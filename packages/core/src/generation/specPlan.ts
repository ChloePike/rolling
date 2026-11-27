/**
 * Tool page planning (no graph): a `PromptSpec` becomes one or more run items.
 *
 * - `image` / `video`: one item, ref `spec`.
 * - `avatar`: one lip-sync video item, ref `avatar`: the photo is the first
 *   frame and the uploaded voice track goes to `audio_url` (D-009 model
 *   `lumina/wan2.7-i2v-spicy` by default; identity rules of D-005 apply through
 *   `modelProblem`: mature runs take only platform pictures).
 * - `remix`: one video item per shot, refs `shot-1…`: refs-mode requests with
 *   the reference video, the shot's frame and the new characters/outfits as
 *   references; models that take no reference video get the clip's poster frame.
 * - `character`: `body` (full figure) then `face` (a close-up made from the
 *   body picture, so the two stay consistent), both image edits/generations
 *   with the reference pictures. The Worker saves the Character on success.
 *
 * Plan caps (D-006), mature routing (D-005) and Auto (D-009) apply per item
 * through `buildSpec`, exactly as for canvas nodes.
 */
import type { Catalog } from '../models/catalog';
import type { CatalogModel, ImageSource } from '../models/types';
import type { Classify } from './auto';
import { buildSpec, imageOriginsOf, keyframeRefOf, type Blocked, type ChainRefs, type ExplicitCheck } from './plan';
import { findModel, isAuto, type NodeSettings, type PromptSpec } from './spec';
import type { GenInput, PlanContext, PlanItem, RunPlan } from './types';

/** Lip-sync model for Avatar runs (D-009 candidate). */
export const AVATAR_MODEL = 'lumina/wan2.7-i2v-spicy';

export const AVATAR_DEFAULT_PROMPT = 'The person in the picture speaks to the camera with natural expressions and small head movements.';

/** What planning needs to know about each input asset. */
export interface SpecAsset {
  origin: ImageSource;
  media: 'image' | 'video' | 'audio';
  /** Video/audio length: probed, or the browser-reported length of an upload still being processed. */
  durationSec?: number;
  /** `durationSec` is the length the browser reported at upload (not probed yet): re-checked in `prepare`. */
  durationDeclared?: boolean;
  /** Video has a poster frame (thumbnail) that can stand in as a picture. */
  poster?: boolean;
  /** Video: scene cuts found when it was processed (seconds, ascending). */
  sceneCuts?: number[];
  /** D-005: a mature asset (e.g. a mature public-library item). Only mature-allowed callers get one; the item runs as mature. */
  mature?: boolean;
}

/** Where each Remix shot starts in the reference video and how long it runs there. */
export interface ShotTime {
  /** Seconds from the start of the reference video, when known. */
  start?: number;
  /** Length of the shot's segment of the reference video, when known. */
  length?: number;
  /** `start` came from the user, a detected scene cut, or an even split. */
  via?: 'user' | 'scene' | 'even';
}

/** Cuts closer than this to each other or to the clip's ends are ignored. */
const MIN_SEGMENT_SEC = 0.5;

/**
 * Shot boundaries in the reference video. Explicit `startSec` wins; otherwise,
 * when the clip has enough detected scene cuts, the first `n - 1` cuts are the
 * boundaries (the user has not set them); else the clip is split evenly.
 */
export function remixShotTimes(shots: ReadonlyArray<{ startSec?: number | undefined }>, total?: number, sceneCuts: readonly number[] = []): ShotTime[] {
  const n = shots.length;
  const cuts = [...sceneCuts]
    .filter((c) => Number.isFinite(c) && c >= MIN_SEGMENT_SEC && (total === undefined || c <= total - MIN_SEGMENT_SEC))
    .sort((a, b) => a - b)
    .filter((c, i, all) => i === 0 || c - all[i - 1]! >= MIN_SEGMENT_SEC);
  const userSet = shots.some((s) => s.startSec !== undefined);
  const useCuts = !userSet && n > 1 && cuts.length >= n - 1;
  const starts: ShotTime[] = shots.map((s, i) => {
    if (s.startSec !== undefined) return { start: s.startSec, via: 'user' };
    if (i === 0) return { start: 0, via: useCuts ? 'scene' : 'even' };
    if (useCuts) return { start: cuts[i - 1]!, via: 'scene' };
    if (!userSet && total !== undefined && total > 0) return { start: Math.round(((total * i) / n) * 100) / 100, via: 'even' };
    return {};
  });
  return starts.map((t, i) => {
    if (t.start === undefined) return t;
    const next = starts.slice(i + 1).find((x) => x.start !== undefined && x.start > t.start!)?.start ?? total;
    return next !== undefined && next > t.start ? { ...t, length: Math.round((next - t.start) * 100) / 100 } : t;
  });
}

export interface PlanSpecInput {
  spec: PromptSpec;
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
  /** D-005 quote-time text classifier for mature-allowed callers' text-only videos (see `ExplicitCheck`). */
  explicit?: ExplicitCheck | null;
  /** Source of every input asset (D-005 provenance). Unknown assets block the item. */
  assetOrigins: ReadonlyMap<string, SpecAsset>;
  /** Retry: plan only these item refs (others are left out). */
  onlyRefs?: readonly string[];
  /** Retry: outputs of items of the earlier run that are not planned again (ref → asset id). */
  priorAssets?: Readonly<Record<string, string>>;
}

type Base = Pick<PlanItem, 'ref' | 'nodeId' | 'title' | 'kind' | 'dependsOn' | 'model' | 'modelName'>;

/** Default item title of a spec. */
export function specTitle(spec: PromptSpec): string {
  if (spec.title) return spec.title;
  switch (spec.kind) {
    case 'remix':
      return 'Remix';
    case 'avatar':
      return 'Avatar';
    case 'character':
      return spec.name ?? 'Character';
    case 'video':
      return 'Video';
    default:
      return 'Image';
  }
}

function settingsOfSpec(spec: PromptSpec, over: Partial<NodeSettings> = {}): NodeSettings {
  return {
    ...(spec.seconds !== undefined && { seconds: spec.seconds }),
    ...(spec.resolution !== undefined && { resolution: spec.resolution }),
    ...(spec.ratio !== undefined && { ratio: spec.ratio }),
    ...(spec.audio !== undefined && { audio: spec.audio }),
    ...(spec.n !== undefined && spec.n > 1 && { n: spec.n }),
    ...(spec.negativePrompt !== undefined && { negativePrompt: spec.negativePrompt }),
    ...(spec.seed !== undefined && { seed: spec.seed }),
    mature: spec.mature === true,
    refsMode: spec.refsMode === true,
    ...over,
  };
}

async function planOne(
  input: PlanSpecInput,
  base: Base,
  kind: 'image' | 'video',
  modelRef: string,
  prompt: string,
  settings: NodeSettings,
  inputs: GenInput[],
  extra: { inputVideoMs?: number; declaredDurations?: Record<string, number> } = {},
): Promise<PlanItem> {
  return (await planSteps(input, base, kind, modelRef, prompt, settings, inputs, extra))[0]!;
}

/**
 * Plans one item; with `chain`, a mature text-only video that no model takes
 * becomes two items (D-005): the keyframe step first, then the animation, which
 * depends on it. The animation keeps `base.ref` and title.
 */
async function planSteps(
  input: PlanSpecInput,
  base: Base,
  kind: 'image' | 'video',
  modelRef: string,
  prompt: string,
  settings: NodeSettings,
  inputs: GenInput[],
  extra: { inputVideoMs?: number; declaredDurations?: Record<string, number> } = {},
  chain?: ChainRefs,
): Promise<PlanItem[]> {
  const built = await buildSpec({
    kind,
    modelRef,
    prompt,
    settings,
    inputs,
    imageOrigins: imageOriginsOf(inputs),
    catalog: input.catalog,
    ctx: input.ctx,
    classify: input.classify ?? null,
    ...(matureInputsOf(input, inputs) && { matureInputs: true }),
    ...(chain && { chain, explicit: input.explicit ?? null }),
  });
  if (!built.ok) {
    return [
      {
        ...base,
        ...(built.model && { model: built.model.id, modelName: built.model.displayName }),
        action: 'blocked',
        code: built.code,
        reason: built.reason,
        ...(built.lowestPlan !== undefined && { lowestPlan: built.lowestPlan }),
      },
    ];
  }
  const spec = {
    ...built.spec,
    ...(extra.inputVideoMs !== undefined && { inputVideoMs: extra.inputVideoMs }),
    ...(extra.declaredDurations && Object.keys(extra.declaredDurations).length > 0 && { declaredDurations: extra.declaredDurations }),
  };
  const main: PlanItem = {
    ...base,
    action: 'run',
    model: built.model.id,
    modelName: built.model.displayName,
    ...(built.autoVia && { autoVia: built.autoVia }),
    spec,
    priceRequest: extra.inputVideoMs !== undefined && built.priceRequest.referenceVideos ? { ...built.priceRequest, inputVideoMs: extra.inputVideoMs } : built.priceRequest,
  };
  if (!built.keyframe || !chain) return [main];
  const k = built.keyframe;
  const first: PlanItem = {
    ref: chain.keyframeRef,
    nodeId: null,
    title: `${base.title} · First frame`,
    kind: 'image',
    dependsOn: [],
    action: 'run',
    model: k.model.id,
    modelName: k.model.displayName,
    spec: k.spec,
    priceRequest: k.priceRequest,
  };
  return [first, { ...main, dependsOn: [...main.dependsOn, chain.keyframeRef] }];
}

const blockedItem = (base: Base, b: Blocked): PlanItem => ({ ...base, action: 'blocked', ...b });

/** D-005: some input of the item is a mature asset (`SpecAsset.mature`). */
function matureInputsOf(input: PlanSpecInput, inputs: readonly GenInput[]): boolean {
  return inputs.some((i) => 'assetId' in i.from && input.assetOrigins.get(i.from.assetId)?.mature === true);
}

/** Looks up an input asset; returns a block when it is unknown or of the wrong media. */
function asset(input: PlanSpecInput, id: string | undefined, want: SpecAsset['media'], missing: string): { a: SpecAsset; id: string } | Blocked {
  if (!id) return { code: 'missing_input', reason: missing };
  const a = input.assetOrigins.get(id);
  if (!a) return { code: 'missing_input', reason: 'An input file is not available.' };
  if (a.media !== want) return { code: 'unsupported', reason: `This input must be ${want === 'audio' ? 'an audio file' : want === 'video' ? 'a video' : 'a picture'}.` };
  return { a, id };
}

const isBlock = (x: unknown): x is Blocked => typeof x === 'object' && x !== null && 'code' in x;

/** Plain image / video (Quick Create, Home): one item, ref `spec`. */
async function planSingle(input: PlanSpecInput): Promise<RunPlan> {
  const { spec } = input;
  const kind = spec.kind as 'image' | 'video';
  const base: Base = { ref: 'spec', nodeId: null, title: specTitle(spec), kind, dependsOn: [], model: null, modelName: null };
  const inputs: GenInput[] = [];
  const add = (assetId: string | undefined, role: GenInput['role']): Blocked | null => {
    if (!assetId) return null;
    const a = input.assetOrigins.get(assetId);
    if (!a) return { code: 'missing_input', reason: 'An input file is not available.' };
    inputs.push({ role, media: a.media, from: { assetId, origin: a.origin } });
    return null;
  };
  const i = spec.inputs;
  const problems = [
    add(i.firstFrameAssetId ?? i.photoAssetId, spec.refsMode ? 'reference' : 'frame'),
    add(i.lastFrameAssetId, spec.refsMode ? 'reference' : 'frame'),
    ...(i.referenceAssetIds ?? []).map((a) => add(a, 'reference')),
    ...(i.inputAssetIds ?? []).map((a) => add(a, kind === 'image' ? 'edit' : 'reference')),
    add(i.videoAssetId, 'reference'),
    add(i.audioAssetId, 'audio'),
  ].filter((p): p is Blocked => p !== null);
  if (problems[0]) return { items: [blockedItem(base, problems[0])] };
  // D-005: a mature text-only video no model takes runs as keyframe → animation. A retry of the animation alone
  // reuses the earlier keyframe.
  const keyframeRef = keyframeRefOf(base.ref);
  const prior = input.onlyRefs && !input.onlyRefs.includes(keyframeRef) ? input.priorAssets?.[keyframeRef] : undefined;
  const chain: ChainRefs | undefined = kind === 'video' ? { ref: base.ref, keyframeRef, ...(prior && { priorKeyframe: prior }) } : undefined;
  return { items: await planSteps(input, base, kind, spec.model, spec.prompt, settingsOfSpec(spec), inputs, {}, chain) };
}

/** The lip-sync model an Avatar run uses: the requested one, or the default (Auto never picks identity models). */
function avatarModel(catalog: Catalog, ref: string): CatalogModel | Blocked {
  if (isAuto(ref)) {
    const preferred = catalog.get(AVATAR_MODEL);
    if (preferred && preferred.lipSync) return preferred;
    const any = catalog.models.find((m) => m.kind === 'video' && m.lipSync && !m.hidden);
    return any ?? { code: 'no_capable_model', reason: 'No lip-sync model is available right now.' };
  }
  const m = findModel(catalog, ref);
  if (!m) return { code: 'unknown_model', reason: `Model “${ref}” is not available.` };
  if (!m.lipSync) return { code: 'unsupported', reason: `${m.displayName} can’t lip-sync to a voice track.` };
  return m;
}

async function planAvatar(input: PlanSpecInput): Promise<RunPlan> {
  const { spec } = input;
  const base: Base = { ref: 'avatar', nodeId: null, title: specTitle(spec), kind: 'video', dependsOn: [], model: null, modelName: null };
  const photo = asset(input, spec.inputs.photoAssetId ?? spec.inputs.firstFrameAssetId, 'image', 'Add a photo first.');
  if (isBlock(photo)) return { items: [blockedItem(base, photo)] };
  const voice = asset(input, spec.inputs.audioAssetId, 'audio', 'Upload a voice track.');
  if (isBlock(voice)) return { items: [blockedItem(base, voice)] };
  // Voice generation (TTS) is an open decision: the track must be an uploaded file.
  if (voice.a.origin === 'generated' || voice.a.origin === 'public' || voice.a.origin === 'builtin') {
    return { items: [blockedItem(base, { code: 'unsupported', reason: 'Upload a voice track.' })] };
  }
  const model = avatarModel(input.catalog, spec.model);
  if (isBlock(model)) return { items: [blockedItem(base, model)] };
  let seconds = spec.seconds;
  if (voice.a.durationSec !== undefined && voice.a.durationSec > 0) seconds = Math.ceil(voice.a.durationSec);
  const declared = voice.a.durationDeclared && voice.a.durationSec !== undefined ? { declaredDurations: { [voice.id]: voice.a.durationSec } } : {};
  if (model.seconds) seconds = Math.min(model.seconds.max, Math.max(model.seconds.min, seconds ?? model.defaultSeconds ?? model.seconds.min));
  const inputs: GenInput[] = [
    { role: 'frame', media: 'image', from: { assetId: photo.id, origin: photo.a.origin } },
    { role: 'audio', media: 'audio', from: { assetId: voice.id, origin: voice.a.origin } },
  ];
  const prompt = spec.prompt.trim() || AVATAR_DEFAULT_PROMPT;
  const settings = settingsOfSpec(spec, { audio: true, refsMode: false, ...(seconds !== undefined && { seconds }) });
  delete settings.n;
  return { items: [{ ...(await planOne(input, base, 'video', model.id, prompt, settings, inputs, declared)), modelName: model.displayName }] };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const REMIX_DIRECTION =
  'Recreate the reference video with the characters and outfits from the reference pictures. Keep its camera moves, framing, actions and timing.';

async function planRemix(input: PlanSpecInput): Promise<RunPlan> {
  const { spec } = input;
  const title = specTitle(spec);
  const shots = spec.shots && spec.shots.length > 0 ? spec.shots : [{ prompt: '' }];
  const video = asset(input, spec.inputs.videoAssetId, 'video', 'Add a reference video first.');
  const refs: GenInput[] = [];
  let refProblem: Blocked | null = null;
  for (const id of spec.inputs.referenceAssetIds ?? []) {
    const a = asset(input, id, 'image', '');
    if (isBlock(a)) refProblem ??= a;
    else refs.push({ role: 'reference', media: 'image', from: { assetId: a.id, origin: a.a.origin } });
  }
  const items: PlanItem[] = [];
  const total = !isBlock(video) ? video.a.durationSec : undefined;
  const times = remixShotTimes(shots, total, !isBlock(video) ? video.a.sceneCuts : []);
  for (const [i, shot] of shots.entries()) {
    const time = times[i]!;
    const ref = `shot-${i + 1}`;
    if (input.onlyRefs && !input.onlyRefs.includes(ref)) continue;
    const base: Base = { ref, nodeId: null, title: shots.length > 1 ? `${title} · Shot ${i + 1}` : title, kind: 'video', dependsOn: [], model: null, modelName: null };
    if (isBlock(video)) {
      items.push(blockedItem(base, video));
      continue;
    }
    if (refProblem) {
      items.push(blockedItem(base, refProblem));
      continue;
    }
    const inputs: GenInput[] = [{ role: 'reference', media: 'video', from: { assetId: video.id, origin: video.a.origin } }];
    // The shot's own frame: the user's picture, else the reference video's frame at the shot start (made in `prepare`).
    const frameAt = time.start ?? 0;
    const videoFrame: GenInput = {
      role: 'reference',
      media: 'image',
      from: { assetId: video.id, origin: video.a.origin, frameAt, ...(video.a.poster && { poster: true as const }) },
    };
    if (shot.frameAssetId) {
      const f = asset(input, shot.frameAssetId, 'image', '');
      if (isBlock(f)) {
        items.push(blockedItem(base, f));
        continue;
      }
      inputs.push({ role: 'reference', media: 'image', from: { assetId: f.id, origin: f.a.origin } });
    } else inputs.push({ ...videoFrame, from: { ...videoFrame.from, optional: true } as GenInput['from'] });
    inputs.push(...refs);
    const line = shot.prompt.trim();
    const where = time.start !== undefined && (time.via !== 'even' || shots.length > 1) ? ` (from ${round1(time.start)}s in the reference video)` : '';
    const prompt = [REMIX_DIRECTION, spec.prompt.trim(), line ? `Shot ${i + 1}${where}: ${line}` : shots.length > 1 ? `Shot ${i + 1} of ${shots.length}${where}.` : '']
      .filter((p) => p !== '')
      .join('\n\n');
    const evenSplit = total !== undefined && total > 0 ? Math.max(1, Math.round(total / shots.length)) : undefined;
    const segment = time.via === 'scene' && time.length !== undefined ? Math.max(1, Math.round(time.length)) : evenSplit;
    const seconds = shot.seconds ?? spec.seconds ?? segment;
    const settings = settingsOfSpec(spec, { refsMode: true, ...(seconds !== undefined && { seconds }) });
    delete settings.n;
    const inputVideoMs = total !== undefined ? Math.round(total * 1000) : undefined;
    const declared = video.a.durationDeclared && total !== undefined ? { declaredDurations: { [video.id]: total } } : {};
    let item = await planOne(input, base, 'video', spec.model, prompt, settings, inputs, { ...(inputVideoMs !== undefined && { inputVideoMs }), ...declared });
    // Models without reference-video input: the clip's frame at the shot start (or its poster) stands in as a picture.
    if (item.action === 'blocked' && (item.code === 'no_capable_model' || item.code === 'unsupported')) {
      const rest = inputs.slice(1).filter((x) => !('assetId' in x.from && x.from.assetId === video.id));
      const framed: GenInput[] = [videoFrame, ...rest];
      const second = await planOne(input, base, 'video', spec.model, prompt, settings, framed, declared);
      if (second.action === 'run') item = second;
    }
    items.push(item);
  }
  return { items };
}

const BODY_DIRECTION = 'Full-body character reference: the whole figure from head to toe, standing in a neutral pose, front view, plain light studio background, even lighting.';
const FACE_DIRECTION = 'Close-up portrait of the same character: face and shoulders, front view, neutral expression, plain light background, even lighting. Keep the face, hair and features identical.';

async function planCharacter(input: PlanSpecInput): Promise<RunPlan> {
  const { spec } = input;
  const title = specTitle(spec);
  const views = spec.views ?? ['body', 'face'];
  const refs: GenInput[] = [];
  let refProblem: Blocked | null = null;
  for (const id of [...(spec.inputs.referenceAssetIds ?? []), ...(spec.inputs.inputAssetIds ?? [])]) {
    const a = asset(input, id, 'image', '');
    if (isBlock(a)) refProblem ??= a;
    else refs.push({ role: 'edit', media: 'image', from: { assetId: a.id, origin: a.a.origin } });
  }
  const description = [spec.name ? `${spec.name}.` : '', spec.prompt.trim()].filter(Boolean).join(' ');
  const items: PlanItem[] = [];
  const run = (ref: string) => !input.onlyRefs || input.onlyRefs.includes(ref);
  const settingsFor = (ratio: string) => {
    const s = settingsOfSpec(spec, { ratio: spec.ratio ?? ratio, refsMode: false });
    delete s.n;
    delete s.seconds;
    delete s.audio;
    return s;
  };
  if (views.includes('body') && run('body')) {
    const base: Base = { ref: 'body', nodeId: null, title: `${title} · Full body`, kind: 'image', dependsOn: [], model: null, modelName: null };
    if (refProblem) items.push(blockedItem(base, refProblem));
    else if (!description && refs.length === 0) items.push(blockedItem(base, { code: 'empty_prompt', reason: 'Describe the character or add a reference picture.' }));
    else items.push(await planOne(input, base, 'image', spec.model, [description, BODY_DIRECTION].filter(Boolean).join('\n\n'), settingsFor('3:4'), refs));
  }
  if (views.includes('face') && run('face')) {
    const base: Base = { ref: 'face', nodeId: null, title: `${title} · Face`, kind: 'image', dependsOn: [], model: null, modelName: null };
    let inputs: GenInput[] = refs;
    const bodyItem = items.find((i) => i.ref === 'body');
    const prior = input.priorAssets?.body;
    if (bodyItem?.action === 'run') {
      inputs = [{ role: 'edit', media: 'image', from: { item: 'body' } }, ...refs];
      base.dependsOn = ['body'];
    } else if (prior) inputs = [{ role: 'edit', media: 'image', from: { assetId: prior, origin: 'generated' } }, ...refs];
    if (refProblem) items.push(blockedItem(base, refProblem));
    else if (bodyItem?.action === 'blocked') items.push(blockedItem(base, { code: 'upstream_blocked', reason: 'Waiting on the full-body picture, which can’t run.' }));
    else if (!description && inputs.length === 0) items.push(blockedItem(base, { code: 'empty_prompt', reason: 'Describe the character or add a reference picture.' }));
    else items.push(await planOne(input, base, 'image', spec.model, [description, FACE_DIRECTION].filter(Boolean).join('\n\n'), settingsFor('1:1'), inputs));
  }
  return { items };
}

/** Plans a tool page run (no graph). */
export async function planPromptSpec(input: PlanSpecInput): Promise<RunPlan> {
  const plan = await (async () => {
    switch (input.spec.kind) {
      case 'avatar':
        return planAvatar(input);
      case 'remix':
        return planRemix(input);
      case 'character':
        return planCharacter(input);
      default:
        return planSingle(input);
    }
  })();
  if (!input.onlyRefs) return plan;
  return { items: plan.items.filter((i) => input.onlyRefs!.includes(i.ref)) };
}
