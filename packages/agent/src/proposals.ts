/**
 * Propose tools: validation before a proposal is stored (docs/harness.md
 * section 5). Schema, ids exist, ports/types/cycles (`core/project`
 * applyGraphOps over `core/graph` validateConnection), model capabilities,
 * plan caps (D-006), mature routing (D-005), no timeline overlaps
 * (`core/timeline`), estimate via `creditsFor`. Proposals never mutate.
 */
import type { CatalogModel } from '@rolling/core';
import type { GraphState, LocalOp } from '@rolling/core/graph';
import { applyGraphOps } from '@rolling/core/project';
import { applyOps as applyTimelineOps, clipEnd, edlDuration, findClip, type Clip, type Edl, type TimelineOp } from '@rolling/core/timeline';
import type { z } from 'zod/v4';
import { planAllowsResolution } from '@rolling/core/pricing/config';
import { MATURE_REQUIRED_MESSAGE, SAFETY_BLOCKED_MESSAGE, type SafetyGate } from '@rolling/core/safety';
import { explicitSignal } from '@rolling/core/safety/rules';
import { canonicalPrompt, characterSheetShot, ShotSpecSchema, wordCount, type ShotCharacter, type ShotSpec } from '@rolling/core/prompting';
import type { TurnSettings } from './context';
import { bestAllowedResolution, creditsForSpec, specFromParams, specProblems, type GenSpec } from './capabilities';
import { layoutNewNodes } from './layout';
import type { AccountSnapshot, AssetItem, ModelsPort } from './ports';
import type { ToolContext } from './tools';
import {
  FIELD_SCHEMAS,
  issueText,
  ProposeFieldsInput,
  ProposeGraphPatchInput,
  ProposePlanInput,
  ProposeTimelinePatchInput,
} from './tools/schemas';
import type {
  Estimate,
  EstimateItem,
  FieldsBody,
  GraphPatchBody,
  PlanBody,
  PlanOptionOut,
  PlanShotOut,
  Proposal,
  ProposalKind,
  ProposalRisk,
  TimelineHighlight,
  TimelinePatchBody,
} from './types';

export interface ProposeContext extends ToolContext {
  newId: () => string;
  now: () => number;
  /** `@` references of this turn, resolved. */
  refs: readonly AssetItem[];
  /** The user's message of this turn (removing user nodes needs an explicit ask). */
  userText: string;
  /** The prompt box's pills of this turn; plans follow them unless the brief names something else. */
  settings?: TurnSettings;
}

export type ProposeResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

const fail = (error: string): ProposeResult => ({ ok: false, error });

export function availableCredits(a: Pick<AccountSnapshot, 'balance'>): number {
  return a.balance.plan + a.balance.purchased - a.balance.held;
}

export function makeEstimate(items: EstimateItem[], account: AccountSnapshot): Estimate {
  const credits = items.reduce((s, i) => s + i.credits, 0);
  return {
    credits,
    items,
    applyIsFree: true,
    balanceAfter: availableCredits(account) - credits,
    needsConfirm: credits > account.confirmThreshold,
  };
}

function risksFor(estimate: Estimate, account: AccountSnapshot, extra: ProposalRisk[] = []): ProposalRisk[] {
  const risks: ProposalRisk[] = [...extra];
  const available = availableCredits(account);
  if (estimate.credits > available) risks.push({ code: 'over_balance', data: { credits: estimate.credits, available } });
  if (estimate.needsConfirm) risks.push({ code: 'needs_confirm', data: { credits: estimate.credits, threshold: account.confirmThreshold } });
  return risks;
}

function proposal(
  ctx: ProposeContext,
  kind: ProposalKind,
  baseRevision: number | null,
  summary: string,
  estimate: Estimate,
  body: Proposal['body'],
  risks: ProposalRisk[] = [],
): Proposal {
  return {
    id: ctx.newId(),
    kind,
    baseRevision,
    summary,
    estimate,
    risks: risksFor(estimate, ctx.account, risks),
    body,
    status: 'proposed',
    createdAt: ctx.now(),
  };
}

// ---------------------------------------------------------------- plan

/** Default keyframe model: the catalog's default image model that can edit when refs are given. */
export function keyframeModel(models: ModelsPort, needsEdit: boolean): CatalogModel | undefined {
  const images = models.models().filter((m) => m.kind === 'image' && !m.hidden && !m.matureOnly && !m.requiresIdentitySafety && m.placement !== 'tool');
  const fits = (m: CatalogModel) => m.operations.includes(needsEdit ? 'edit' : 't2i');
  return images.find((m) => m.default && fits(m)) ?? images.find(fits);
}

const DEFAULT_RATIO = '16:9';

/** Keyframe models of a plan: plain text-to-image, and the one that draws from reference pictures (null when none can). */
export interface KeyframeModels {
  t2i: string;
  edit: string | null;
  /** Reference pictures one keyframe may take. */
  maxRefs: number;
}

/** A character gets a reference sheet when at least this many keyframed shots show it. */
export const CHARACTER_SHEET_MIN_SHOTS = 2;

/** Characters of an option that get a reference sheet: shown in two or more shots that have a keyframe. */
export function sheetCharacters(option: Pick<PlanOptionOut, 'characters' | 'shots'>, keyframe: KeyframeModels): ShotCharacter[] {
  if (!keyframe.edit) return [];
  return (option.characters ?? []).filter((c) => option.shots.filter((s) => s.mode === 'i2v' && s.shot?.characters?.some((x) => x.name === c.name)).length >= CHARACTER_SHEET_MIN_SHOTS);
}

/** Reference pictures wired into a shot's keyframe, in order: character sheets first, then `@` pictures. */
function keyframeRefs(shot: PlanShotOut, sheets: readonly ShotCharacter[], imageRefs: number, max: number): { sheets: number[]; assets: number[] } {
  const mine = sheets.map((c, i) => (shot.shot?.characters?.some((x) => x.name === c.name) ? i : -1)).filter((i) => i >= 0).slice(0, max);
  const assets = Array.from({ length: Math.max(0, Math.min(imageRefs, max - mine.length)) }, (_, i) => i);
  return { sheets: mine, assets };
}

/**
 * Builds the GraphOps for one plan option: a script node, `@` reference
 * assets, a reference sheet per recurring character, then per shot a video
 * node, fed by an image keyframe when the model animates a first frame (i2v).
 * A text-to-video shot gets no keyframe: nothing would read it, and running
 * it would cost credits. Nodes of a structured shot carry it (`params.shot`)
 * next to its neutral prose (`params.prompt`); the run composes the prompt
 * for the model from the shot (`core/prompting`).
 */
export function planOps(option: PlanOptionOut, refs: readonly AssetItem[], keyframe: KeyframeModels): LocalOp[] {
  const ops: LocalOp[] = [];
  ops.push({
    op: 'addNode',
    tempId: 'script',
    kind: 'script',
    title: option.title,
    params: {
      rows: option.shots.map((s) => ({
        n: String(s.n).padStart(2, '0'),
        title: s.title,
        visual: s.visual,
        ...(s.line ? { line: s.line } : {}),
        seconds: s.seconds,
      })),
      ratio: option.ratio,
    },
  });
  const imageRefs = refs.filter((r) => r.kind === 'image');
  imageRefs.forEach((r, i) => {
    ops.push({ op: 'addNode', tempId: `ref${i + 1}`, kind: 'asset', title: r.name, params: { assetId: r.id, media: 'image', source: r.source } });
  });
  const sheets = sheetCharacters(option, keyframe);
  sheets.forEach((c, i) => {
    const sheet = characterSheetShot(c, option.look);
    ops.push({
      op: 'addNode',
      tempId: `char${i + 1}`,
      kind: 'image',
      title: `Character: ${c.name}`.slice(0, 200),
      params: { prompt: canonicalPrompt(sheet, 'still'), shot: sheet, model: keyframe.t2i, mode: 't2i', ratio: '3:4', count: 1 },
    });
  });
  option.shots.forEach((s) => {
    const k = `key${s.n}`;
    const v = `shot${s.n}`;
    const withKeyframe = s.mode === 'i2v';
    const wired = withKeyframe ? keyframeRefs(s, sheets, imageRefs.length, keyframe.edit ? keyframe.maxRefs : 0) : { sheets: [], assets: [] };
    const drawsFromRefs = wired.sheets.length + wired.assets.length > 0;
    if (withKeyframe)
      ops.push({
        op: 'addNode',
        tempId: k,
        kind: 'image',
        title: `Keyframe ${s.n}: ${s.title}`.slice(0, 200),
        params: {
          prompt: s.shot ? canonicalPrompt(s.shot, 'still') : `${s.visual} First frame of the shot.`,
          ...(s.shot ? { shot: s.shot } : {}),
          model: drawsFromRefs ? keyframe.edit! : keyframe.t2i,
          mode: drawsFromRefs ? 'edit' : 't2i',
          ratio: option.ratio,
          count: 1,
        },
      });
    ops.push({
      op: 'addNode',
      tempId: v,
      kind: 'video',
      title: `Shot ${s.n}: ${s.title}`.slice(0, 200),
      params: {
        prompt: s.visual,
        ...(s.shot ? { shot: s.shot } : {}),
        model: s.model,
        mode: s.mode,
        seconds: s.seconds,
        ...(s.resolution ? { resolution: s.resolution } : {}),
        ratio: option.ratio,
        ...(s.audio ? { audio: true } : {}),
        ...(s.line ? { line: s.line } : {}),
      },
    });
    if (!withKeyframe) return;
    ops.push({ op: 'connect', from: { node: 'script', port: 'out' }, to: { node: k, port: 'prompt' } });
    wired.sheets.forEach((i) => ops.push({ op: 'connect', from: { node: `char${i + 1}`, port: 'out' }, to: { node: k, port: 'refs' } }));
    wired.assets.forEach((i) => ops.push({ op: 'connect', from: { node: `ref${i + 1}`, port: 'out' }, to: { node: k, port: 'refs' } }));
    ops.push({ op: 'connect', from: { node: k, port: 'out' }, to: { node: v, port: 'frame' } });
  });
  return ops;
}

// ---------------------------------------------------------------- plan checks (shot craft, pacing, pills)

/** Spoken words a second of video carries comfortably (speech runs about 2.5 words a second). */
export const WORDS_PER_SECOND = 3;

const RATIO_ASK = /\b(?:vertical|portrait|horizontal|landscape|widescreen|wide-?screen|square|tv|\d{1,2}\s*[:x×]\s*\d{1,2})\b|竖|豎|横|橫|方形|正方|縦|横型|세로|가로|hochformat|querformat|quadrat/i;
const LENGTH_ASK = /\d+(?:[.,]\d+)?\s*-?\s*(?:s\b|sec|second|sekunde|segundo|seconde|minute|min\b|秒|分钟|分鐘|초|분)|\b(?:panels?|shots?)\b|[格コマ컷]/i;
const MODEL_ASK = /\b(?:cheap|cheaper|cheapest|budget|draft|fast|seedance|wan|minimax|hailuo|grok|credits?)\b|便宜|省|預算|预算|安い|저렴/i;
const RESOLUTION_ASK = /\b(?:480p|720p|1080p|2k|4k|hd|full hd|resolution)\b|分辨率|解析度|解像度|해상도/i;

/**
 * Where a plan departs from the prompt box's pills although the brief does
 * not ask for it. The pills are the user's settings: only the brief's own
 * words override them.
 */
export function pillProblems(args: z.infer<typeof ProposePlanInput>, settings: TurnSettings | undefined, userText: string): string[] {
  if (!settings) return [];
  const problems: string[] = [];
  if (settings.ratio && !RATIO_ASK.test(userText)) {
    args.options.forEach((o, i) => {
      if (o.ratio !== settings.ratio) problems.push(`options[${i}]: ratio ${o.ratio}, but the prompt box says ${settings.ratio} and the brief does not ask for another`);
    });
  }
  if (settings.seconds && !LENGTH_ASK.test(userText) && Math.abs(args.seconds - settings.seconds) > settings.seconds * 0.1 + 1e-9) {
    problems.push(`seconds is ${args.seconds}, but the prompt box says ${settings.seconds} s total and the brief does not ask for another length`);
  }
  if (settings.resolution && !RESOLUTION_ASK.test(userText)) {
    args.options.forEach((o, i) => {
      if (o.resolution !== undefined && o.resolution !== settings.resolution) problems.push(`options[${i}]: resolution ${o.resolution}, but the prompt box says ${settings.resolution}`);
    });
  }
  if (settings.videoModel && !MODEL_ASK.test(userText) && !args.options.some((o) => o.shots.every((s) => s.model === settings.videoModel))) {
    problems.push(`no option uses the model picked on the prompt box (${settings.videoModel}) for every shot; at least one option must`);
  }
  return problems;
}

/**
 * D-005: a mature-allowed member's explicit shot runs on the models that take
 * mature runs, whatever model the plan names (the run re-routes it). Those
 * models take few lengths; a shot of another length would be blocked at run
 * time, so the plan is checked here. Null when the length is fine.
 */
export function matureLengthProblem(seconds: number, models: ModelsPort): string | null {
  const takers = models.models().filter((m) => m.kind === 'video' && !m.hidden && m.matureRouting !== 'never' && !m.lipSync && m.seconds);
  if (takers.length === 0) return null;
  const fits = takers.some((m) => (m.seconds!.allowed ? m.seconds!.allowed.includes(seconds) : seconds >= m.seconds!.min && seconds <= m.seconds!.max));
  if (fits) return null;
  const lengths = [...new Set(takers.flatMap((m) => m.seconds!.allowed ?? [m.seconds!.min, m.seconds!.max]))].sort((a, b) => a - b);
  return `mature clips run on models that take ${lengths.join(' or ')} seconds, not ${seconds}; use one of those lengths for this shot`;
}

type PlanShotInput = z.infer<typeof ProposePlanInput>['options'][number]['shots'][number];
type PlanOptionInput = z.infer<typeof ProposePlanInput>['options'][number];

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The structured shot of a plan shot (null for a free-text `visual` shot),
 * with the checks a director would make before handing it on: the cast
 * exists and is named where it appears, speech fits the model and the length.
 */
export function buildShot(shot: PlanShotInput, option: PlanOptionInput, model: CatalogModel | undefined, where: string): { shot: ShotSpec | null; problems: string[] } {
  const problems: string[] = [];
  if (!shot.subject || !shot.action) {
    if (shot.visual) return { shot: null, problems };
    return { shot: null, problems: [`${where}: give subject and action`] };
  }
  const known = option.characters ?? [];
  const cast: ShotCharacter[] = [];
  for (const name of shot.cast ?? []) {
    const c = known.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) problems.push(`${where}: cast "${name}" is not in this option's characters (${known.map((x) => x.name).join(', ') || 'none'})`);
    else if (!cast.includes(c)) cast.push({ name: c.name, look: c.look, ...(c.wardrobe ? { wardrobe: c.wardrobe } : {}) });
  }
  const told = `${shot.subject} ${shot.action}`;
  for (const c of known) {
    if (!cast.some((x) => x.name === c.name) && mentions(told, c.name)) problems.push(`${where}: ${c.name} appears in the shot but is not in cast; add "${c.name}" to cast so the same look is used`);
  }
  for (const d of shot.dialogue ?? []) {
    if (known.length && !known.some((c) => c.name.toLowerCase() === d.speaker.toLowerCase())) problems.push(`${where}: speaker "${d.speaker}" is not in characters`);
  }
  if (model && !model.audio && (shot.dialogue?.length || shot.sound)) {
    problems.push(`${where}: ${model.id} makes no sound; use a model with audio for speech and sound effects, or move the words to line (voiceover or caption)`);
  }
  const spoken = (shot.dialogue ?? []).reduce((n, d) => n + wordCount(d.line), 0);
  if (spoken > Math.ceil(shot.seconds * WORDS_PER_SECOND)) {
    problems.push(`${where}: ${spoken} spoken words do not fit ${shot.seconds} s (about ${Math.ceil(shot.seconds * WORDS_PER_SECOND)} at most); shorten the dialogue or lengthen the shot`);
  }
  const lineWords = shot.line ? wordCount(shot.line) : 0;
  if (lineWords > Math.ceil(shot.seconds * (WORDS_PER_SECOND + 1))) {
    problems.push(`${where}: the line has ${lineWords} words for ${shot.seconds} s; shorten it to about ${Math.ceil(shot.seconds * WORDS_PER_SECOND)} words`);
  }
  const candidate = {
    subject: shot.subject,
    action: shot.action,
    ...(shot.setting ? { setting: shot.setting } : {}),
    ...(shot.camera && Object.keys(shot.camera).length ? { camera: shot.camera } : {}),
    ...(shot.lighting ? { lighting: shot.lighting } : {}),
    ...(option.look ? { style: option.look } : {}),
    ...(cast.length ? { characters: cast } : {}),
    ...(shot.dialogue?.length ? { dialogue: shot.dialogue } : {}),
    ...(shot.sound ? { sound: shot.sound } : {}),
    ...(shot.text ? { text: shot.text } : {}),
  };
  const parsed = ShotSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    problems.push(`${where}: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { shot: null, problems };
  }
  return { shot: parsed.data as ShotSpec, problems };
}

/**
 * Whole-second shot lengths that add up to `target` and fit every model's
 * range, using as close to `preferred` shots as possible. Null when none fit.
 */
export function suggestSplit(target: number, ranges: readonly { min: number; max: number; allowed?: number[] }[], preferred: number): number[] | null {
  if (!ranges.length || !Number.isFinite(target) || target <= 0) return null;
  const min = Math.max(...ranges.map((r) => r.min));
  const max = Math.min(...ranges.map((r) => r.max));
  const total = Math.round(target);
  if (min > max || ranges.some((r) => r.allowed)) return null;
  const candidates = Array.from({ length: 12 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
  for (const n of candidates) {
    if (n * min > total || n * max < total) continue;
    const base = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
  }
  return null;
}

/** Cheapest general video model for a total length (lowest allowed resolution), for budget hints. */
export function cheapestVideo(models: ModelsPort, account: AccountSnapshot, seconds: number): { model: string; resolution: string | null; credits: number } | null {
  let best: { model: string; resolution: string | null; credits: number } | null = null;
  for (const m of models.models()) {
    if (m.kind !== 'video' || m.hidden || m.matureOnly || m.requiresIdentitySafety || m.placement === 'tool' || !m.seconds) continue;
    if (!m.operations.includes('t2v') && !m.operations.includes('i2v')) continue;
    const resolution = m.resolutions.find((r) => !account.plan || planAllowsResolution(account.plan, 'video', r)) ?? null;
    if (m.resolutions.length && !resolution) continue;
    const per5 = models.creditsFor(m, { seconds: Math.min(Math.max(5, m.seconds.min), m.seconds.max), ...(resolution ? { resolution } : {}) });
    if (per5 === null) continue;
    const credits = Math.ceil((per5 / Math.min(Math.max(5, m.seconds.min), m.seconds.max)) * seconds);
    if (!best || credits < best.credits) best = { model: m.id, resolution, credits };
  }
  return best;
}

async function proposePlan(args: z.infer<typeof ProposePlanInput>, ctx: ProposeContext): Promise<ProposeResult> {
  const { models } = ctx.ports;
  const refs = ctx.refs.filter((r) => r.kind === 'image');
  const kfT2i = keyframeModel(models, false);
  const kfEdit = keyframeModel(models, true);
  const kf = kfT2i ?? kfEdit;
  if (!kf) return fail('no image model is available for keyframes');
  const keyframe: KeyframeModels = { t2i: kf.id, edit: kfEdit?.id ?? null, maxRefs: kfEdit ? Math.max(1, Math.min(8, kfEdit.maxInputImages || 8)) : 0 };
  const problems: string[] = pillProblems(args, ctx.settings, ctx.userText);
  const options: PlanOptionOut[] = [];
  const unpriced: string[] = [];
  let base: GraphState = { revision: 0, nodes: [], edges: [], groups: [] };
  if (ctx.thread.surface === 'canvas' && ctx.thread.projectId) {
    const g = await ctx.ports.canvas.getGraph(ctx.thread.projectId);
    if (g) base = g.state;
  }

  args.options.forEach((opt, oi) => {
    const ratio = opt.ratio ?? DEFAULT_RATIO;
    const shots: PlanShotOut[] = [];
    const items: EstimateItem[] = [];
    const names = (opt.characters ?? []).map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) problems.push(`options[${oi}]: two characters share a name`);
    opt.shots.forEach((shot, si) => {
      const where = `options[${oi}].shots[${si}]`;
      const model = models.get(shot.model);
      if (!model) {
        problems.push(`${where}: model "${shot.model}" is not in the catalog; call models.capabilities with kind video`);
        return;
      }
      const built = buildShot(shot, opt, model, where);
      if (built.problems.length) {
        problems.push(...built.problems);
        return;
      }
      const visual = built.shot ? canonicalPrompt(built.shot) : shot.visual!;
      if (ctx.account.matureAllowed && explicitSignal(visual).length > 0) {
        const length = matureLengthProblem(shot.seconds, models);
        if (length) {
          problems.push(`${where}: ${length}`);
          return;
        }
      }
      const mode = model.operations.includes('i2v') ? 'i2v' : 't2v';
      const resolution = opt.resolution ?? bestAllowedResolution(model, ctx.account.plan, 'video', ctx.settings?.resolution) ?? null;
      const audio = model.audio && !!built.shot && (!!built.shot.dialogue?.length || !!built.shot.sound);
      const spec: GenSpec = { kind: 'video', model: model.id, mode, seconds: shot.seconds, ratio, ...(resolution ? { resolution } : {}), ...(audio ? { audio: true } : {}) };
      const p = specProblems(spec, models, ctx.account);
      if (p.length) {
        problems.push(`${where}: ${p.join('; ')}`);
        return;
      }
      const n = si + 1;
      const credits = creditsForSpec(spec, models);
      if (credits === null) unpriced.push(`shot ${n}`);
      if (credits !== null) items.push({ ref: `shot${n}`, model: model.id, kind: 'video', seconds: shot.seconds, ...(resolution ? { resolution } : {}), credits });
      shots.push({
        n,
        title: shot.title,
        seconds: shot.seconds,
        visual,
        ...(built.shot ? { shot: built.shot } : {}),
        ...(shot.line ? { line: shot.line } : {}),
        model: model.id,
        mode,
        resolution,
        ...(audio ? { audio: true } : {}),
        credits: credits ?? 0,
      });
    });
    if (shots.length !== opt.shots.length) return;
    const option: PlanOptionOut = {
      title: opt.title,
      ...(opt.look ? { look: opt.look } : {}),
      ...(opt.characters?.length ? { characters: opt.characters.map((c) => ({ name: c.name, look: c.look, ...(c.wardrobe ? { wardrobe: c.wardrobe } : {}) })) } : {}),
      ratio,
      resolution: opt.resolution ?? null,
      seconds: Math.round(shots.reduce((s, x) => s + x.seconds, 0) * 100) / 100,
      shots,
      estimate: makeEstimate([], ctx.account),
      ops: [],
    };
    const ops = layoutNewNodes(base, planOps(option, refs, keyframe));
    const applied = applyGraphOps(base, ops, { actor: 'agent' });
    if (!applied.ok) {
      problems.push(`options[${oi}]: the nodes would not connect (${applied.refusal.message})`);
      return;
    }
    // Pictures the option adds (character sheets, keyframes), priced from the nodes exactly as they will run.
    const pictures: EstimateItem[] = [];
    for (const op of ops) {
      if (op.op !== 'addNode' || op.kind !== 'image') continue;
      const inputImages = ops.filter((o) => o.op === 'connect' && o.to.node === op.tempId && o.to.port === 'refs').length;
      const spec = specFromParams('image', op.params, { frames: 0, refs: inputImages });
      const credits = spec ? creditsForSpec(spec, models) : null;
      if (credits === null || !spec) unpriced.push(op.tempId);
      else pictures.push({ ref: op.tempId, model: spec.model, kind: 'image', credits });
    }
    for (const s of shots) s.credits += pictures.find((x) => x.ref === `key${s.n}`)?.credits ?? 0;
    option.estimate = makeEstimate([...pictures, ...items], ctx.account);
    option.ops = ops;
    options.push(option);
  });

  for (const [oi, o] of options.entries()) {
    if (Math.abs(o.seconds - args.seconds) > args.seconds * 0.1 + 1e-9) {
      problems.push(`options[${oi}]: shots add up to ${o.seconds}s, but the target is ${args.seconds}s (within 10%); change shot lengths or the number of shots`);
    }
  }
  if (!problems.length && options.length) {
    const available = availableCredits(ctx.account);
    const cheapest = Math.min(...options.map((o) => o.estimate.credits));
    const floor = cheapestVideo(models, ctx.account, args.seconds);
    if (cheapest > available && floor && floor.credits <= available) {
      problems.push(
        `every option costs more than the available ${available} credits (cheapest ${cheapest}); make one option cheaper, e.g. ${floor.model} at ${floor.resolution ?? 'its default resolution'} is about ${floor.credits} credits for ${args.seconds}s`,
      );
    }
  }
  if (problems.length) {
    // Models are bad at this arithmetic: name a split that fits each failing option's models.
    const hints: string[] = [];
    args.options.forEach((opt, oi) => {
      if (!problems.some((p) => p.startsWith(`options[${oi}]`))) return;
      const split = suggestSplit(args.seconds, opt.shots.map((sh) => models.get(sh.model)?.seconds).filter((x): x is NonNullable<typeof x> => !!x), opt.shots.length);
      if (split) hints.push(`options[${oi}] could use ${split.length} shot${split.length > 1 ? 's' : ''} of ${split.join(' + ')} seconds`);
    });
    return fail(`invalid plan: ${problems.slice(0, 6).join(' | ')}${hints.length ? `. Suggestion: ${hints.join('; ')}` : ''}`);
  }
  const body: PlanBody = { kind: 'plan', seconds: args.seconds, options, refs: refs.map((r) => r.id) };
  const cheapest = options.reduce((a, b) => (b.estimate.credits < a.estimate.credits ? b : a));
  const summary = args.summary?.trim() || `${options.length} options, ${options.map((o) => o.title).join(' / ')}`;
  return {
    ok: true,
    proposal: proposal(ctx, 'plan', ctx.thread.surface === 'canvas' ? base.revision : null, summary, cheapest.estimate, body, unpriced.length ? [{ code: 'unpriced', data: { refs: unpriced } }] : []),
  };
}

// ---------------------------------------------------------------- graph patch

const REMOVE_ASK = /\b(delete|remove|drop|get rid of|clear)\b|删除|删掉|移除|削除|삭제/i;

/** Inputs wired into a node in a graph state. */
function inputCounts(state: GraphState, nodeId: string) {
  let frames = 0;
  let refs = 0;
  for (const e of state.edges) {
    if (e.to.node !== nodeId) continue;
    if (e.to.port === 'frame') frames++;
    if (e.to.port === 'refs') refs++;
  }
  return { frames, refs };
}

/** Checks and prices the generative nodes a patch adds or changes, in the patched state. */
function checkTouchedNodes(
  after: GraphState,
  nodeIds: Iterable<string>,
  models: ModelsPort,
  account: AccountSnapshot,
  label: (id: string) => string,
): { problems: string[]; items: EstimateItem[]; unpriced: string[] } {
  const problems: string[] = [];
  const items: EstimateItem[] = [];
  const unpriced: string[] = [];
  for (const id of nodeIds) {
    const node = after.nodes.find((n) => n.id === id);
    if (!node || (node.kind !== 'video' && node.kind !== 'image')) continue;
    const spec = specFromParams(node.kind, node.params, inputCounts(after, id));
    if (!spec) {
      problems.push(`${label(id)}: set params.model to a ${node.kind} model id`);
      continue;
    }
    const p = specProblems(spec, models, account);
    if (p.length) {
      problems.push(`${label(id)}: ${p.join('; ')}`);
      continue;
    }
    const credits = creditsForSpec(spec, models);
    if (credits === null) unpriced.push(label(id));
    else items.push({ ref: label(id), model: spec.model, kind: spec.kind, ...(spec.seconds ? { seconds: spec.seconds } : {}), ...(spec.resolution ? { resolution: spec.resolution } : {}), credits });
  }
  return { problems, items, unpriced };
}

/**
 * Shots in a graph patch: `params.shot` on an added or updated image or video
 * node is checked, merged over the node's current shot (only the changed
 * fields are sent) and written back with its neutral prose as `params.prompt`,
 * so the node keeps one source of truth and the run composes it per model.
 */
export function normalizeShotOps(ops: readonly LocalOp[], state: GraphState, models: ModelsPort): { ops: LocalOp[]; problems: string[] } {
  const problems: string[] = [];
  const out = ops.map((op, i): LocalOp => {
    if ((op.op !== 'addNode' && op.op !== 'updateNode') || !op.params || typeof op.params.shot !== 'object' || op.params.shot === null) return op;
    const node = op.op === 'updateNode' ? state.nodes.find((n) => n.id === op.nodeId) : undefined;
    const kind = op.op === 'addNode' ? op.kind : node?.kind;
    if (kind !== 'image' && kind !== 'video') return op;
    const current = node && node.params.shot && typeof node.params.shot === 'object' ? (node.params.shot as Record<string, unknown>) : {};
    const next = op.params.shot as Record<string, unknown>;
    const camera = { ...((current.camera as object | undefined) ?? {}), ...((next.camera as object | undefined) ?? {}) };
    const merged: Record<string, unknown> = { ...current, ...next, ...(Object.keys(camera).length ? { camera } : {}) };
    for (const [k, v] of Object.entries(merged)) if (v === null || v === '') delete merged[k];
    const parsed = ShotSpecSchema.safeParse(merged);
    if (!parsed.success) {
      problems.push(`ops[${i}].params.shot: ${parsed.error.issues.slice(0, 2).map((x) => `${x.path.join('.') || 'shot'}: ${x.message}`).join('; ')}`);
      return op;
    }
    const shot = parsed.data as ShotSpec;
    const modelId = typeof op.params.model === 'string' ? op.params.model : typeof node?.params.model === 'string' ? node.params.model : undefined;
    const model = modelId ? models.get(modelId) : undefined;
    const sound = kind === 'video' && (!!shot.dialogue?.length || !!shot.sound);
    if (sound && model && !model.audio) problems.push(`ops[${i}]: ${model.id} makes no sound; use a model with audio for speech and sound effects`);
    const params = {
      ...op.params,
      shot,
      prompt: canonicalPrompt(shot, kind === 'image' ? 'still' : 'video'),
      ...(sound && model?.audio && op.params.audio === undefined && node?.params.audio === undefined ? { audio: true } : {}),
    };
    return { ...op, params };
  });
  return { ops: out, problems };
}

async function proposeGraphPatch(args: z.infer<typeof ProposeGraphPatchInput>, ctx: ProposeContext): Promise<ProposeResult> {
  if (!ctx.thread.projectId) return fail('this thread has no project; propose a plan instead');
  if (args.projectId !== ctx.thread.projectId) return fail(`projectId must be ${ctx.thread.projectId}`);
  const graph = await ctx.ports.canvas.getGraph(args.projectId);
  if (!graph) return fail('project not found');
  const state = graph.state;
  if (args.baseRevision !== state.revision) {
    return fail(`baseRevision ${args.baseRevision} is stale: the canvas is at revision ${state.revision}. Call canvas.get and build the ops again`);
  }
  const normalized = normalizeShotOps(args.ops as LocalOp[], state, ctx.ports.models);
  if (normalized.problems.length) return fail(`invalid shot: ${normalized.problems.slice(0, 4).join(' | ')}`);
  const ops = normalized.ops;
  const removesUser: string[] = [];
  for (const [i, op] of ops.entries()) {
    if (op.op === 'addNode' && op.tempId.startsWith('node_')) return fail(`ops[${i}]: tempId must be a short temp id like t1, not a node id`);
    if (op.op === 'removeNode') {
      const node = state.nodes.find((n) => n.id === op.nodeId);
      if (node && node.createdBy !== 'agent') removesUser.push(node.id);
    }
  }
  if (removesUser.length && !REMOVE_ASK.test(ctx.userText)) {
    return fail(`ops remove nodes the user made (${removesUser.join(', ')}); only remove them when the user asks`);
  }
  const laidOut = layoutNewNodes(state, ops);
  const applied = applyGraphOps(state, laidOut, { actor: 'agent' });
  if (!applied.ok) {
    const r = applied.refusal;
    return fail(`ops[${r.opIndex ?? '?'}] refused (${r.code}): ${r.message}`);
  }
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const op of laidOut) {
    if (op.op === 'addNode') added.push(op.tempId);
    else if (op.op === 'updateNode' && Object.keys(op.params).length) updated.push(op.nodeId);
    else if (op.op === 'removeNode') removed.push(op.nodeId);
  }
  const reverse = new Map(Object.entries(applied.idMap).map(([temp, real]) => [real, temp]));
  const touchedIds = [...added.map((t) => applied.idMap[t] ?? t), ...updated];
  const checked = checkTouchedNodes(applied.state, touchedIds, ctx.ports.models, ctx.account, (id) => reverse.get(id) ?? id);
  if (checked.problems.length) return fail(`invalid node settings: ${checked.problems.slice(0, 6).join(' | ')}`);
  const body: GraphPatchBody = {
    kind: 'graphPatch',
    projectId: args.projectId,
    ops: laidOut,
    touched: { added, updated, removed, edges: laidOut.filter((o) => o.op === 'connect' || o.op === 'disconnect').length },
  };
  const extra: ProposalRisk[] = [];
  if (removesUser.length) extra.push({ code: 'removes_user_nodes', data: { nodeIds: removesUser } });
  if (checked.unpriced.length) extra.push({ code: 'unpriced', data: { refs: checked.unpriced } });
  return { ok: true, proposal: proposal(ctx, 'graphPatch', state.revision, args.summary, makeEstimate(checked.items, ctx.account), body, extra) };
}

/**
 * Re-checks a graph patch against a newer revision. The ops are kept exactly
 * (Apply must produce the patch the user saw); the proposal is rebased when
 * they still apply, stale otherwise.
 */
export function rebaseGraphPatch(body: GraphPatchBody, state: GraphState): { ok: true; revision: number } | { ok: false; reason: string } {
  const applied = applyGraphOps(state, body.ops, { actor: 'agent' });
  return applied.ok ? { ok: true, revision: state.revision } : { ok: false, reason: applied.refusal.message };
}

// ---------------------------------------------------------------- timeline patch

function highlightsFor(before: Edl, after: Edl, ops: readonly TimelineOp[]): TimelineHighlight[] {
  const out = new Map<string, TimelineHighlight['kind']>();
  for (const op of ops) if ('clipId' in op) out.set(op.clipId, op.op === 'remove' ? 'remove' : (out.get(op.clipId) ?? 'change'));
  for (const t of before.tracks) {
    for (const c of t.clips as Clip[]) {
      const now = findClip(after, c.id);
      if (!now) out.set(c.id, 'remove');
      else if (now.clip.start !== c.start || clipEnd(now.clip) !== clipEnd(c)) out.set(c.id, out.get(c.id) ?? 'change');
    }
  }
  return [...out].map(([clipId, kind]) => ({ clipId, kind }));
}

export function validateTimelineOps(edl: Edl, ops: readonly TimelineOp[]): { ok: true; edl: Edl } | { ok: false; error: string } {
  const res = applyTimelineOps(edl, ops);
  return res.ok ? res : { ok: false, error: res.error };
}

async function proposeTimelinePatch(args: z.infer<typeof ProposeTimelinePatchInput>, ctx: ProposeContext): Promise<ProposeResult> {
  if (ctx.thread.canvasId && args.canvasId !== ctx.thread.canvasId) return fail(`canvasId must be ${ctx.thread.canvasId}`);
  const t = await ctx.ports.timeline.get(args.canvasId);
  if (!t) return fail('no timeline for this canvas');
  if (args.baseRevision !== t.revision) {
    return fail(`baseRevision ${args.baseRevision} is stale: the timeline is at revision ${t.revision}. Call timeline.get and build the ops again`);
  }
  const ops = args.ops as TimelineOp[];
  const res = validateTimelineOps(t.edl, ops);
  if (!res.ok) return fail(`timeline ops refused: ${res.error}`);
  const body: TimelinePatchBody = {
    kind: 'timelinePatch',
    canvasId: args.canvasId,
    ops,
    highlights: highlightsFor(t.edl, res.edl, ops),
    durationBefore: Math.round(edlDuration(t.edl) * 1000) / 1000,
    durationAfter: Math.round(edlDuration(res.edl) * 1000) / 1000,
  };
  return { ok: true, proposal: proposal(ctx, 'timelinePatch', t.revision, args.summary, makeEstimate([], ctx.account), body) };
}

export function rebaseTimelinePatch(body: TimelinePatchBody, current: { revision: number; edl: Edl }): { ok: true; revision: number } | { ok: false; reason: string } {
  const res = validateTimelineOps(current.edl, body.ops);
  return res.ok ? { ok: true, revision: current.revision } : { ok: false, reason: res.error };
}

// ---------------------------------------------------------------- fields

async function proposeFields(args: z.infer<typeof ProposeFieldsInput>, ctx: ProposeContext): Promise<ProposeResult> {
  const schema = FIELD_SCHEMAS[args.tool];
  const parsed = schema.safeParse(args.fields);
  if (!parsed.success) return fail(`invalid ${args.tool} fields: ${issueText(parsed.error)}`);
  const fields = parsed.data as Record<string, unknown>;
  const items: EstimateItem[] = [];
  if (args.tool === 'quick' && typeof fields.model === 'string') {
    const kind = fields.kind as 'video' | 'image';
    const spec = specFromParams(kind, { ...fields, ...(kind === 'image' && fields.count ? { count: fields.count } : {}) });
    if (spec) {
      const p = specProblems(spec, ctx.ports.models, ctx.account);
      if (p.length) return fail(`invalid quick fields: ${p.join('; ')}`);
      const credits = creditsForSpec(spec, ctx.ports.models);
      if (credits !== null) items.push({ ref: 'quick', model: spec.model, kind, ...(spec.seconds ? { seconds: spec.seconds } : {}), credits });
    }
  }
  const body: FieldsBody = { kind: 'fields', tool: args.tool, fields };
  return { ok: true, proposal: proposal(ctx, 'fields', null, `Filled the ${args.tool} form`, makeEstimate(items, ctx.account), body) };
}

// ---------------------------------------------------------------- entry

const SCHEMAS = {
  'propose.plan': ProposePlanInput,
  'propose.graphPatch': ProposeGraphPatchInput,
  'propose.timelinePatch': ProposeTimelinePatchInput,
  'propose.fields': ProposeFieldsInput,
} as const;

export type ProposeToolName = keyof typeof SCHEMAS;

export function isProposeTool(name: string): name is ProposeToolName {
  return name in SCHEMAS;
}

/**
 * Some models send nested arrays or objects as JSON strings
 * (`"options": "[{...}]"`), mostly on retries. Decode those before checking.
 */
export function decodeJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try {
        return decodeJsonStrings(JSON.parse(t), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => decodeJsonStrings(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const decoded = decodeJsonStrings(v, depth + 1);
      // Seen with DeepSeek on retries: the rest of the object is inside the string,
      // e.g. "options": "[...], \"summary\": \"...\"}". Re-read it as the object's tail.
      if (typeof decoded === 'string' && /^\s*[[{]/.test(decoded)) {
        // Also seen: the provider's own parameter markup leaking in, `"seconds" string="false">6`.
        let t = decoded
          .trim()
          .replace(/"([A-Za-z_]\w*)"\s+string="false">([^,}\]"<]*)/g, '"$1": $2')
          .replace(/"([A-Za-z_]\w*)"\s+string="true">([^,}\]"<]*)/g, (_m, key: string, v: string) => `"${key}": ${JSON.stringify(v)}`);
        if (!t.endsWith('}')) t += '}';
        try {
          const tail = JSON.parse(`{${JSON.stringify(k)}:${t}`) as Record<string, unknown>;
          for (const [tk, tv] of Object.entries(tail)) if (!(tk in out) || tk === k) out[tk] = decodeJsonStrings(tv, depth + 1);
          continue;
        } catch {
          // Not repairable; leave it for the schema error.
        }
      }
      if (!(k in out)) out[k] = decoded;
    }
    return out;
  }
  return value;
}

/** Models sometimes put the target length on each option instead of the top level. */
function hoistPlanSeconds(args: unknown): void {
  if (!args || typeof args !== 'object') return;
  const a = args as { seconds?: unknown; options?: unknown };
  if (a.seconds !== undefined || !Array.isArray(a.options)) return;
  const first = a.options[0] as { seconds?: unknown } | undefined;
  if (typeof first?.seconds === 'number') a.seconds = first.seconds;
}

/** Validates a propose call and builds the proposal. Never throws for bad input. */
export async function runPropose(name: ProposeToolName, rawArgs: unknown, ctx: ProposeContext): Promise<ProposeResult> {
  const decoded = decodeJsonStrings(rawArgs ?? {});
  if (name === 'propose.plan') hoistPlanSeconds(decoded);
  const parsed = SCHEMAS[name].safeParse(decoded);
  if (!parsed.success) return fail(`invalid input: ${issueText(parsed.error)}`);
  let result: ProposeResult;
  try {
    switch (name) {
      case 'propose.plan':
        result = await proposePlan(parsed.data as z.infer<typeof ProposePlanInput>, ctx);
        break;
      case 'propose.graphPatch':
        result = await proposeGraphPatch(parsed.data as z.infer<typeof ProposeGraphPatchInput>, ctx);
        break;
      case 'propose.timelinePatch':
        result = await proposeTimelinePatch(parsed.data as z.infer<typeof ProposeTimelinePatchInput>, ctx);
        break;
      case 'propose.fields':
        result = await proposeFields(parsed.data as z.infer<typeof ProposeFieldsInput>, ctx);
        break;
    }
  } catch (err) {
    return fail(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!result.ok || !ctx.ports.safety) return result;
  const problem = await safetyProblem(result.proposal, ctx.ports.safety, ctx.account.matureAllowed);
  return problem ? fail(problem) : result;
}

const PROMPT_KEYS = new Set(['prompt', 'visual']);

/** Generation prompts in a proposal body: `prompt` / `visual` strings anywhere (plan shots, node params, tool fields). */
export function proposalPrompts(body: unknown): { prompts: string[]; negative: string[] } {
  const prompts = new Set<string>();
  const negative = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && x.trim()) {
        if (PROMPT_KEYS.has(k)) prompts.add(x.trim());
        else if (k === 'negativePrompt') negative.add(x.trim());
      } else walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return { prompts: [...prompts].slice(0, 40), negative: [...negative].slice(0, 10) };
}

/**
 * D-005 gate over a valid proposal. A hard-limit hit makes it invalid with a
 * neutral reason so the model rewrites it; explicit prompts on a non-mature
 * turn get the mature-content reason.
 */
async function safetyProblem(p: Proposal, gate: SafetyGate, mature: boolean): Promise<string | null> {
  const { prompts, negative } = proposalPrompts(p.body);
  if (prompts.length === 0) return null;
  let v;
  try {
    v = await gate.checkProposal({ mature, prompts: prompts.map((prompt, i) => ({ prompt, ...(i === 0 && negative.length && { negativePrompt: negative.join('; ') }) })) });
  } catch {
    if (!mature) return null;
    v = { verdict: 'block' as const, reasons: [{ code: 'SAFETY_UNAVAILABLE' as const, detail: 'gate error' }], checks: [] };
  }
  if (v.verdict !== 'block') return null;
  if (v.reasons.every((r) => r.code === 'MATURE_REQUIRED')) {
    return `content rules: ${MATURE_REQUIRED_MESSAGE} Rewrite the prompts without explicit content, or tell the user how to turn on mature content.`;
  }
  return `content rules: ${SAFETY_BLOCKED_MESSAGE} Rewrite the affected prompts so they stay within the content rules, or tell the user it can't be made. Do not describe the rules in detail.`;
}
