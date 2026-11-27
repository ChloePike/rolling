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
import { applyOps as applyTimelineOps, clipEnd, edlDuration, findClip, planCutTo, type Clip, type Edl, type TimelineOp } from '@rolling/core/timeline';
import type { z } from 'zod/v4';
import { planAllowsResolution } from '@rolling/core/pricing/config';
import { MATURE_REQUIRED_MESSAGE, SAFETY_BLOCKED_MESSAGE, type SafetyGate } from '@rolling/core/safety';
import { explicitSignal } from '@rolling/core/safety/rules';
import { CAMERA_ANGLES, CAMERA_MOVES, canonicalPrompt, characterSheetShot, characterSheetTitle, SHOT_SIZES, ShotSpecSchema, wordCount, type ShotCharacter, type ShotSpec } from '@rolling/core/prompting';
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

/**
 * Characters of an option that get a reference sheet: shown in two or more
 * shots that have a keyframe. With `@` pictures in the turn, objects get none:
 * the user's product photo or logo is the reference, and a sheet drawn from
 * words would compete with it.
 */
export function sheetCharacters(option: Pick<PlanOptionOut, 'characters' | 'shots'>, keyframe: KeyframeModels, imageRefs = 0): ShotCharacter[] {
  if (!keyframe.edit) return [];
  return (option.characters ?? [])
    .filter((c) => !(imageRefs > 0 && c.kind === 'object'))
    .filter((c) => option.shots.filter((s) => s.mode === 'i2v' && s.shot?.characters?.some((x) => x.name === c.name)).length >= CHARACTER_SHEET_MIN_SHOTS);
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
  const sheets = sheetCharacters(option, keyframe, imageRefs.length);
  sheets.forEach((c, i) => {
    const sheet = characterSheetShot(c, option.look);
    ops.push({
      op: 'addNode',
      tempId: `char${i + 1}`,
      kind: 'image',
      title: characterSheetTitle(c),
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
/** In a cut of several shots, a shot without speech longer than this holds one beat too long. */
export const LONG_SHOT_SECONDS = 8;

/** The brief itself sets how the video is cut ("three shots", "one take", "5 panels"): its shot lengths are the user's. */
const SHOT_COUNT_ASK = /\b(?:\d+|one|two|three|four|five|six|single|long)[ -](?:shots?|takes?|clips?|panels?|scenes?)\b|一镜|一鏡|长镜头|長鏡頭|ワンカット|원테이크/i;
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
  if (settings.videoModel && !MODEL_ASK.test(userText) && !args.options.some((o) => o.shots.every((s) => (s.model ?? o.model) === settings.videoModel))) {
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

/** Lengths the mature video models take, when they take fixed ones. */
function matureLengths(models: ModelsPort): number[] {
  const takers = models.models().filter((m) => m.kind === 'video' && !m.hidden && m.matureRouting !== 'never' && !m.lipSync && m.seconds);
  return [...new Set(takers.flatMap((m) => m.seconds!.allowed ?? []))].sort((a, b) => a - b);
}

/** A split of `target` into mature-length shots ("2 shots of 5 seconds"), or null. */
export function matureSplit(target: number, models: ModelsPort): { n: number; seconds: number } | null {
  const lengths = matureLengths(models);
  for (let n = 1; n <= 12; n++) {
    const fit = lengths.filter((l) => Math.abs(n * l - target) <= target * 0.1 + 1e-9).sort((a, b) => Math.abs(n * a - target) - Math.abs(n * b - target))[0];
    if (fit !== undefined) return { n, seconds: fit };
  }
  return null;
}

/** A credit budget the brief names ("under 600 credits", "max 500 credits"), or null. */
export function budgetOf(text: string): number | null {
  const m = /(?:under|below|less than|at most|no more than|max(?:imum)?(?: of)?|within|up to|budget(?: of| is)?)\s+(\d[\d,.]*)\s*credits?\b/i.exec(text) ?? /(\d[\d,.]*)\s*credits?\s+(?:or less|max(?:imum)?|budget|at most)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,.](?=\d{3}\b)/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** How far the server moves one shot's length to make an option add up. */
export const MAX_SECONDS_NUDGE = 2;

/**
 * Makes an option's whole-second shot lengths add up to the target when they
 * are close: the model's arithmetic fails about once in ten plans ("five shots
 * of 5 s" for 30 s), and a refusal costs a whole extra call. Shots move by at
 * most 2 s each, stay inside their model's range and the pacing limit, and a
 * shot with speech is never shortened below what its words need. Returns the
 * lengths to use, or null when the option is fine or cannot be fixed this way.
 */
export function fitShotSeconds(shots: readonly { seconds: number; words: number; range: { min: number; max: number; allowed?: number[] } | undefined }[], target: number): number[] | null {
  const sum = shots.reduce((s, x) => s + x.seconds, 0);
  if (Math.abs(sum - target) <= target * 0.1 + 1e-9) return null;
  if (shots.some((s) => !s.range || s.range.allowed || !Number.isInteger(s.seconds))) return null;
  const goal = Math.round(target);
  const out = shots.map((s) => s.seconds);
  const lo = shots.map((s) => Math.max(s.range!.min, s.seconds - MAX_SECONDS_NUDGE, Math.ceil(s.words / WORDS_PER_SECOND)));
  const hi = shots.map((s) => Math.min(s.range!.max, s.seconds + MAX_SECONDS_NUDGE, s.words > 0 ? s.range!.max : Math.max(s.seconds, LONG_SHOT_SECONDS)));
  let diff = goal - sum;
  while (diff !== 0) {
    const step = diff > 0 ? 1 : -1;
    // Lengthen the shortest shot first, shorten the longest first: the cut stays even.
    const order = out.map((_, i) => i).sort((a, b) => (out[a]! - out[b]!) * step || a - b);
    const i = order.find((k) => (step > 0 ? out[k]! < hi[k]! : out[k]! > lo[k]!));
    if (i === undefined) return null;
    out[i] = out[i]! + step;
    diff -= step;
  }
  return out;
}

const CAMERA_SYNONYMS: Record<'size' | 'angle' | 'move', Record<string, string>> = {
  size: { establishing: 'wide', long: 'wide', long_shot: 'wide', two_shot: 'medium', cowboy: 'medium', insert: 'close_up', detail: 'close_up', macro: 'extreme_close_up', portrait: 'medium_close_up', closeup: 'close_up' },
  angle: { birds_eye: 'overhead', top_down: 'overhead', topdown: 'overhead', worms_eye: 'low_angle', low: 'low_angle', high: 'high_angle', ots: 'over_the_shoulder', first_person: 'pov', front: 'eye_level', side: 'eye_level', profile: 'eye_level' },
  move: { dolly_in: 'push_in', push: 'push_in', dolly_out: 'pull_out', pull_back: 'pull_out', dolly: 'push_in', crane_up: 'pedestal_up', crane_down: 'pedestal_down', follow: 'tracking', track: 'tracking', pan: 'pan_right', tilt: 'tilt_up', arc: 'orbit', locked: 'static', locked_off: 'static', fixed: 'static', still: 'static', none: 'static', zoom: 'zoom_in' },
};
const CAMERA_VALUES = { size: SHOT_SIZES as readonly string[], angle: CAMERA_ANGLES as readonly string[], move: CAMERA_MOVES as readonly string[] };

/**
 * Camera words the model sends outside the lists ("over_the_shoulder" as a
 * size, "dolly_in", "two shot") are mapped to the listed value or left out: a
 * missing camera word costs a little framing, a refused plan costs a turn.
 */
export function normalizeCamera(camera: unknown): void {
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) return;
  const cam = camera as Record<string, unknown>;
  for (const key of ['size', 'angle', 'move'] as const) {
    const raw = cam[key];
    if (raw === undefined) continue;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    if (CAMERA_VALUES[key].includes(v)) cam[key] = v;
    else if (CAMERA_SYNONYMS[key][v]) cam[key] = CAMERA_SYNONYMS[key][v];
    else {
      // An angle written as the size ("over_the_shoulder") moves to where it belongs.
      if (key === 'size' && CAMERA_VALUES.angle.includes(v) && cam.angle === undefined) cam.angle = v;
      delete cam[key];
    }
  }
}

function normalizePlanCameras(args: unknown): void {
  const options = (args as { options?: unknown })?.options;
  if (!Array.isArray(options)) return;
  for (const o of options) for (const sh of Array.isArray((o as { shots?: unknown })?.shots) ? ((o as { shots: unknown[] }).shots) : []) normalizeCamera((sh as { camera?: unknown })?.camera);
}

function normalizePatchCameras(args: unknown): void {
  const ops = (args as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) return;
  for (const op of ops) normalizeCamera((op as { params?: { shot?: { camera?: unknown } } })?.params?.shot?.camera);
}

type PlanShotInput = z.infer<typeof ProposePlanInput>['options'][number]['shots'][number];
type PlanOptionInput = z.infer<typeof ProposePlanInput>['options'][number];

/** A declared character as the shot carries it. */
function character(c: PlanOptionInput['characters'] extends (infer T)[] | undefined ? T : never): ShotCharacter {
  return { name: c.name, ...(c.kind && c.kind !== 'person' ? { kind: c.kind } : {}), look: dropNegatedClauses(c.look), ...(c.wardrobe ? { wardrobe: dropNegatedClauses(c.wardrobe) } : {}) };
}

function mentions(text: string, name: string, exactCase = false): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, exactCase ? 'u' : 'iu').test(text);
}

/**
 * "…, no props", "…, without a logo": an image model draws the thing a
 * negation names, so clauses that only say what is absent are left out of the
 * descriptive fields. The text is returned unchanged when nothing else is left.
 */
export function dropNegatedClauses(text: string): string {
  const kept = text.split(/\s*[,;]\s*/).filter((part) => !/^(?:and\s+|with\s+)?(?:no|without|never|not)\b/i.test(part.trim()));
  const out = kept.join(', ').trim();
  return out ? out : text;
}

const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
    else if (!cast.some((x) => x.name === c.name)) cast.push(character(c));
  }
  // A character named in the shot is in the shot: the server lists it (the model forgets `cast` about once in five
  // plans, and a refusal for it costs a whole turn). Speakers are on camera too.
  const told = `${shot.subject} ${shot.action}`;
  for (const c of known) {
    const speaks = (shot.dialogue ?? []).some((d) => d.speaker.toLowerCase() === c.name.toLowerCase());
    // Case matters here: a man called "Roaster" is not in a shot of "a drum roaster".
    if (!cast.some((x) => x.name === c.name) && (speaks || mentions(told, c.name, true))) cast.push(character(c));
  }
  cast.sort((a, b) => known.findIndex((c) => c.name === a.name) - known.findIndex((c) => c.name === b.name));
  for (const d of shot.dialogue ?? []) {
    if (known.length && !known.some((c) => c.name.toLowerCase() === d.speaker.toLowerCase())) problems.push(`${where}: speaker "${d.speaker}" is not in characters`);
  }
  // Speech on a silent model is a planning mistake; ambience on one is simply not made.
  const silent = !!model && !model.audio;
  if (silent && shot.dialogue?.length) {
    problems.push(`${where}: ${model.id} makes no sound; use a model with audio for speech, or move the words to line (voiceover or caption)`);
  }
  const spoken = (shot.dialogue ?? []).reduce((n, d) => n + wordCount(d.line), 0);
  if (spoken > Math.ceil(shot.seconds * WORDS_PER_SECOND)) {
    problems.push(`${where}: ${spoken} spoken words do not fit ${shot.seconds} s (about ${Math.ceil(shot.seconds * WORDS_PER_SECOND)} at most); shorten the dialogue or lengthen the shot`);
  }
  const lineWords = shot.line ? wordCount(shot.line) : 0;
  if (lineWords > Math.ceil(shot.seconds * (WORDS_PER_SECOND + 1))) {
    problems.push(`${where}: the line has ${lineWords} words for ${shot.seconds} s; shorten it to about ${Math.ceil(shot.seconds * WORDS_PER_SECOND)} words`);
  }
  // Prompts are composed in English around these fields; a field in another script gives the model a mixed prompt.
  const described = [shot.subject, shot.action, shot.setting, shot.lighting, option.look, ...known.flatMap((c) => [c.look, c.wardrobe])].filter((x): x is string => !!x);
  if (described.some((x) => CJK_TEXT.test(x))) {
    problems.push(`${where}: write subject, action, setting, lighting, look and the characters' look in English (titles, line, dialogue and text keep the user's language)`);
    return { shot: null, problems };
  }
  const candidate = {
    subject: dropNegatedClauses(shot.subject),
    action: shot.action,
    ...(shot.setting ? { setting: dropNegatedClauses(shot.setting) } : {}),
    ...(shot.camera && Object.keys(shot.camera).length ? { camera: shot.camera } : {}),
    ...(shot.lighting ? { lighting: dropNegatedClauses(shot.lighting) } : {}),
    ...(option.look ? { style: dropNegatedClauses(option.look) } : {}),
    ...(cast.length ? { characters: cast } : {}),
    ...(shot.dialogue?.length ? { dialogue: shot.dialogue } : {}),
    ...(shot.sound && !silent ? { sound: shot.sound } : {}),
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
  // Suggest lengths that also pass the pacing check, unless the target cannot be reached that way.
  const hardMax = Math.min(...ranges.map((r) => r.max));
  const paced = Math.max(min, LONG_SHOT_SECONDS);
  const max = 12 * paced >= Math.round(target) ? Math.min(hardMax, paced) : hardMax;
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

/**
 * A model for an option whose shots are shorter than its model takes (two
 * 3-second shots for a 6-second bumper on a model that starts at 4): the
 * cheapest listed model that takes every length, makes sound when a shot needs
 * it, and costs no more than the one named. Null when there is none; a model
 * the user picked on the prompt box is never replaced.
 */
export function modelForShortShots(models: ModelsPort, account: AccountSnapshot, named: CatalogModel, seconds: readonly number[], needsAudio: boolean): CatalogModel | null {
  const per5 = (m: CatalogModel) => {
    const resolution = bestAllowedResolution(m, account.plan, 'video') ?? undefined;
    return models.creditsFor(m, { seconds: 5, ...(resolution ? { resolution } : {}) });
  };
  const limit = per5(named);
  let best: { model: CatalogModel; credits: number } | null = null;
  for (const m of models.models()) {
    if (m.kind !== 'video' || m.hidden || m.matureOnly || m.requiresIdentitySafety || m.placement !== 'featured' || !m.seconds || m.seconds.allowed) continue;
    if (!m.operations.includes('t2v') && !m.operations.includes('i2v')) continue;
    if (needsAudio && !m.audio) continue;
    if (!seconds.every((s) => Number.isInteger(s) && s >= m.seconds!.min && s <= m.seconds!.max)) continue;
    const credits = per5(m);
    if (credits === null || (limit !== null && credits > limit)) continue;
    if (!best || credits < best.credits) best = { model: m, credits };
  }
  return best?.model ?? null;
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

  // D-005: an explicit brief from a mature-allowed member makes every clip of the plan a mature one, whatever words
  // the shots use: their lengths are checked against the models that take mature runs. The run itself is routed by
  // the pre-check (rules, then the classifier), which re-plans an explicit prompt as a mature run.
  const matureTurn = ctx.account.matureAllowed && explicitSignal(ctx.userText).length > 0;
  args.options.forEach((opt, oi) => {
    const ratio = opt.ratio ?? DEFAULT_RATIO;
    // Shots shorter than the option's model takes: use a listed model that takes them, when the user picked none.
    const named = opt.model ? models.get(opt.model) : undefined;
    if (named?.seconds && !matureTurn && opt.model !== ctx.settings?.videoModel && opt.shots.every((sh) => !sh.model) && opt.shots.some((sh) => sh.seconds < named.seconds!.min)) {
      const needsAudio = opt.shots.some((sh) => !!sh.dialogue?.length);
      const other = modelForShortShots(models, ctx.account, named, opt.shots.map((sh) => sh.seconds), needsAudio);
      if (other) opt.model = other.id;
    }
    if (!matureTurn) {
      const fitted = fitShotSeconds(
        opt.shots.map((sh) => ({ seconds: sh.seconds, words: (sh.dialogue ?? []).reduce((n, d) => n + wordCount(d.line), 0), range: models.get(sh.model ?? opt.model ?? '')?.seconds })),
        args.seconds,
      );
      if (fitted) opt.shots.forEach((sh, i) => (sh.seconds = fitted[i]!));
    }
    const shots: PlanShotOut[] = [];
    const items: EstimateItem[] = [];
    const names = (opt.characters ?? []).map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) problems.push(`options[${oi}]: two characters share a name`);
    opt.shots.forEach((shot, si) => {
      const where = `options[${oi}].shots[${si}]`;
      const modelId = shot.model ?? opt.model;
      if (!modelId) {
        if (si === 0) problems.push(`options[${oi}]: set model on the option (a video model id from the list)`);
        return;
      }
      const model = models.get(modelId);
      if (!model) {
        problems.push(`${where}: model "${modelId}" is not in the catalog; use an id from the Video models list or call models.capabilities with kind video`);
        return;
      }
      if (opt.shots.length > 1 && shot.seconds > LONG_SHOT_SECONDS && !shot.dialogue?.length && !SHOT_COUNT_ASK.test(ctx.userText)) {
        problems.push(`${where}: ${shot.seconds} s without speech holds one beat too long; use shots of 4 to 6 s (up to ${LONG_SHOT_SECONDS} for a slow move) and more of them. A cheaper option saves with the model or the resolution, not with fewer, longer shots`);
        return;
      }
      const built = buildShot(shot, opt, model, where);
      if (built.problems.length) {
        problems.push(...built.problems);
        return;
      }
      const visual = built.shot ? canonicalPrompt(built.shot) : shot.visual!;
      const mature = ctx.account.matureAllowed && (matureTurn || explicitSignal(visual).length > 0);
      if (mature) {
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
        ...(mature ? { mature: true } : {}),
        credits: credits ?? 0,
      });
    });
    if (shots.length !== opt.shots.length) return;
    const option: PlanOptionOut = {
      title: opt.title,
      ...(opt.look ? { look: dropNegatedClauses(opt.look) } : {}),
      ...(opt.characters?.length ? { characters: opt.characters.map(character) } : {}),
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
    const budget = budgetOf(ctx.userText);
    if (cheapest > available && floor && floor.credits <= available) {
      problems.push(
        `every option costs more than the available ${available} credits (cheapest ${cheapest}); make one option cheaper, e.g. ${floor.model} at ${floor.resolution ?? 'its default resolution'} is about ${floor.credits} credits for ${args.seconds}s`,
      );
    } else if (budget !== null && cheapest > budget) {
      // The brief names a budget: one option has to meet it (the reply may not promise what the estimate does not show).
      problems.push(
        `the brief asks for at most ${budget} credits but the cheapest option costs ${cheapest}; make one option cheaper${floor ? `, e.g. ${floor.model} at ${floor.resolution ?? 'its default resolution'} is about ${floor.credits} credits for ${args.seconds}s` : ''}`,
      );
    }
  }
  if (problems.length) {
    // Models are bad at this arithmetic: name a split that fits each failing option's models.
    const hints: string[] = [];
    args.options.forEach((opt, oi) => {
      if (!problems.some((p) => p.startsWith(`options[${oi}]`))) return;
      if (matureTurn || problems.some((p) => p.startsWith(`options[${oi}]`) && p.includes('mature clips'))) {
        const m = matureSplit(args.seconds, models);
        if (m) hints.push(`options[${oi}] could use ${m.n} shot${m.n > 1 ? 's' : ''} of ${m.seconds} seconds`);
        return;
      }
      const split = suggestSplit(args.seconds, opt.shots.map((sh) => models.get(sh.model ?? opt.model ?? '')?.seconds).filter((x): x is NonNullable<typeof x> => !!x), opt.shots.length);
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
  const noop = new Set<number>();
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
    const prompt = canonicalPrompt(shot, kind === 'image' ? 'still' : 'video');
    // An update that leaves the node's prompt and settings as they are would only make it run again for nothing
    // (a camera move sent to a keyframe: a still has none). It is left out of the patch.
    if (node && prompt === node.params.prompt && Object.entries(op.params).every(([k, v]) => k === 'shot' || k === 'prompt' || JSON.stringify(v) === JSON.stringify(node.params[k])) && (op.op !== 'updateNode' || op.title === undefined || op.title === node.title)) {
      noop.add(i);
      return op;
    }
    const params = {
      ...op.params,
      shot,
      prompt,
      ...(sound && model?.audio && op.params.audio === undefined && node?.params.audio === undefined ? { audio: true } : {}),
    };
    return { ...op, params };
  });
  return { ops: out.filter((_, i) => !noop.has(i)), problems };
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
  if (ops.length === 0) return fail('these ops change nothing: every node already has these values. Send only what the user asked to change');
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
  // "Cut to N seconds" is arithmetic over every track; the planner in core does it, the model only names the length.
  const ops: TimelineOp[] = [];
  let edl = t.edl;
  for (const op of args.ops) {
    if (op.op !== 'cutTo') {
      ops.push(op as TimelineOp);
      continue;
    }
    const before = validateTimelineOps(t.edl, ops);
    if (!before.ok) return fail(`timeline ops refused: ${before.error}`);
    edl = before.edl;
    const planned = planCutTo(edl, op.seconds);
    if (!planned) return fail(`cutTo ${op.seconds}: the cut is ${Math.round(edlDuration(edl) * 100) / 100} s long; give a shorter length that leaves every shot at least 1 s`);
    ops.push(...planned.ops);
  }
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
 * A JSON text whose closing brackets at the very end are wrong (one too many
 * or one missing, as models write when they escape a long array into a
 * string): the tail is rebuilt from the brackets still open. Null when that
 * does not make it parse.
 */
export function rebalanceTail(text: string): unknown | null {
  const body = text.replace(/[\]}\s]+$/, '');
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') stack.push(ch === '[' ? ']' : '}');
    else if (ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString || stack.length === 0) return null;
  try {
    return JSON.parse(body + stack.reverse().join('')) as unknown;
  } catch {
    return null;
  }
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
        const fixed = rebalanceTail(t);
        if (fixed !== null) return decodeJsonStrings(fixed, depth + 1);
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
  if (name === 'propose.plan') {
    hoistPlanSeconds(decoded);
    normalizePlanCameras(decoded);
  } else if (name === 'propose.graphPatch') normalizePatchCameras(decoded);
  // A list written as a string that does not parse: say exactly that (the schema error alone made the model resend it).
  const listKey = name === 'propose.plan' ? 'options' : name === 'propose.fields' ? null : 'ops';
  if (listKey && typeof (decoded as Record<string, unknown>)?.[listKey] === 'string') {
    return fail(`invalid input: "${listKey}" must be a JSON array, not text. Write "${listKey}": [ { ... } ] directly: no quotes around the array and no backslashes before the quotes inside it`);
  }
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
