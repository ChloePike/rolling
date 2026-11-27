/**
 * Per-model prompt adapters: a structured shot → the prompt text one model
 * family reads best (order of the parts, camera wording, speech and sound
 * syntax, how references and frames are named, negative prompts, length).
 *
 * Only shots are composed. A prompt the user typed is never rewritten here:
 * `adaptPrompt` passes it through untouched, and provider-side prompt
 * enhancement (the gateway's `prompt_expand`) is the only thing that may
 * rewrite it. A composed prompt is marked `composed` so the provider layer
 * leaves it alone (no double rewrite).
 */
import type { CatalogModel, GenerationMode } from '../models/types';
import { FAMILY_MOVES, profileOf, type FamilyProfile, type PromptFamily } from './families';
import {
  capitalize,
  castSentence,
  clause,
  dialogueSentence,
  framing,
  MOVE_SENTENCES,
  sentence,
  type PromptPurpose,
  type ShotDialogue,
  type ShotSpec,
} from './shot';

/** Media attached to the request, in request order. Labels are the names the user sees (node or asset titles). */
export interface PromptInputs {
  firstFrame?: boolean;
  lastFrame?: boolean;
  /** Reference pictures (video `refs` mode) or pictures an image is drawn from (image `edit` mode). */
  images?: readonly string[];
  videos?: number;
  audios?: number;
}

export interface ComposeOptions {
  mode: GenerationMode;
  /** The request's `audio` flag: true = sound is made, false = silent, undefined = model default. */
  audio?: boolean;
  seconds?: number;
  inputs?: PromptInputs;
  /** Negative prompt the user set on the node. */
  negativePrompt?: string;
}

export interface ComposedPrompt {
  prompt: string;
  negativePrompt?: string;
  family: PromptFamily;
  purpose: PromptPurpose;
  /** Shot parts left out (not supported by the model, or cut to fit the length). */
  dropped: string[];
}

/** One sentence of the prompt. `keep` 0 is never cut; higher numbers are cut first when the text is too long. */
interface Segment {
  key: string;
  text: string;
  keep: number;
}

type Build = (shot: ShotSpec, ctx: Ctx) => Segment[];

interface Ctx {
  profile: FamilyProfile;
  purpose: PromptPurpose;
  opts: ComposeOptions;
  /** Speech and sound go in the prompt. */
  sound: boolean;
  dropped: string[];
}

const seg = (key: string, text: string, keep: number): Segment => ({ key, text, keep });

function purposeOf(model: Pick<CatalogModel, 'kind'>, opts: ComposeOptions): PromptPurpose {
  if (model.kind === 'image') return 'still';
  return opts.inputs?.firstFrame || opts.mode === 'i2v' || opts.mode === 'first_last_frame' ? 'animate' : 'video';
}

function moveSentence(shot: ShotSpec, family: PromptFamily): string {
  const move = shot.camera?.move;
  if (!move) return '';
  return sentence(FAMILY_MOVES[family]?.[move] ?? MOVE_SENTENCES[move]);
}

function cleanLabel(label: string): string {
  return label
    .replace(/\.(png|jpe?g|webp|gif|heic|mp4|mov|webm)$/i, '')
    .replace(/["“”<>{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Binds every reference picture to what it is for, by upload order
 * ("Image 1 is …"): the Seedance, Seedream and Wan guides all ask for explicit
 * numbering and a stated role, and warn that unbound references get mixed up.
 */
export function referenceSentences(labels: readonly string[] | undefined): string {
  if (!labels?.length) return '';
  const out: string[] = [];
  labels.forEach((raw, i) => {
    const label = cleanLabel(raw);
    const sheet = /^(character|animal|product)(?: sheet)?:\s*(.+)$/i.exec(label);
    const who = sheet?.[2];
    const kind = sheet?.[1]?.toLowerCase();
    if (who && kind === 'product') out.push(`Image ${i + 1} is ${who}: keep its shape, materials, colors and markings identical.`);
    else if (who && kind === 'animal') out.push(`Image ${i + 1} is ${who}: keep the same animal, with identical coat, markings and build.`);
    else if (who) out.push(`Image ${i + 1} is the character ${who}: keep the face, hair and outfit identical.`);
    else if (label) out.push(`Image ${i + 1} is ${label}: keep it identical.`);
    else out.push(`Image ${i + 1} is a reference: keep its subject identical.`);
  });
  return out.join(' ');
}

function frameSentence(ctx: Ctx): string {
  const i = ctx.opts.inputs;
  if (i?.firstFrame && i.lastFrame) return 'Move from the first frame to the last frame in one continuous shot.';
  if (ctx.purpose === 'animate') return 'Keep the subject, look and setting of the first frame.';
  return '';
}

/** Speech lines in a family's own syntax, or nothing when the model stays silent. */
function speech(shot: ShotSpec, ctx: Ctx, format: (d: ShotDialogue) => string): Segment[] {
  if (!shot.dialogue?.length) return [];
  if (!ctx.sound) {
    ctx.dropped.push('dialogue');
    return [];
  }
  return shot.dialogue.map((d, i) => seg(`dialogue${i + 1}`, format(d), 0));
}

function quoted(line: string): string {
  return `"${line.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '')}"`;
}

function soundSegments(shot: ShotSpec, ctx: Ctx, silence: { music?: string; dialogue?: string }): Segment[] {
  if (!ctx.sound) {
    if (shot.sound) ctx.dropped.push('sound');
    if (shot.music) ctx.dropped.push('music');
    return [];
  }
  const out: Segment[] = [];
  if (shot.sound) out.push(seg('sound', sentence(`Sound: ${clause(shot.sound)}`), 4));
  if (shot.music) out.push(seg('music', sentence(`Music: ${clause(shot.music)}`), 5));
  // Constraints only when the request asks for sound: the cut gets its own music and voice tracks in the editor.
  if (ctx.opts.audio === true) {
    if (!shot.music && silence.music) out.push(seg('noMusic', silence.music, 3));
    if (!shot.dialogue?.length && silence.dialogue) out.push(seg('noDialogue', silence.dialogue, 3));
  }
  return out;
}

const style = (shot: ShotSpec, keep = 2) => (shot.style ? [seg('style', sentence(capitalize(clause(shot.style))), keep)] : []);
const subjectLine = (shot: ShotSpec) => {
  const frame = framing(shot.camera);
  return seg('subject', sentence(frame ? `${capitalize(frame)} of ${clause(shot.subject)}` : capitalize(clause(shot.subject))), 0);
};
const cast = (shot: ShotSpec) => (shot.characters?.length ? [seg('characters', castSentence(shot.characters), 0)] : []);
const action = (shot: ShotSpec) => seg('action', sentence(capitalize(clause(shot.action))), 0);
const setting = (shot: ShotSpec, keep = 3) => (shot.setting ? [seg('setting', sentence(capitalize(clause(shot.setting))), keep)] : []);
const lighting = (shot: ShotSpec, keep = 4) => (shot.lighting ? [seg('lighting', sentence(capitalize(clause(shot.lighting))), keep)] : []);
const lens = (shot: ShotSpec) => (shot.camera?.lens ? [seg('lens', sentence(capitalize(clause(shot.camera.lens))), 6)] : []);
const text = (shot: ShotSpec) => (shot.text ? [seg('text', `The text ${quoted(shot.text)} is clearly readable.`, 1)] : []);
const move = (shot: ShotSpec, family: PromptFamily, keep = 1) => {
  const m = moveSentence(shot, family);
  return m ? [seg('camera', m, keep)] : [];
};
const refs = (ctx: Ctx) => {
  const r = referenceSentences(ctx.opts.inputs?.images);
  return r ? [seg('references', r, 0)] : [];
};
const frames = (ctx: Ctx) => {
  const f = frameSentence(ctx);
  return f ? [seg('frames', f, 2)] : [];
};
/** Names only: a first frame already shows what the characters look like. */
const castNames = (shot: ShotSpec) => (shot.characters?.length ? [seg('characters', `In the shot: ${shot.characters.map((c) => c.name).join(', ')}.`, 5)] : []);

// ---------------------------------------------------------------- video families

/**
 * Seedance (official 2.5 guide): bind the assets first, a one-sentence summary
 * (style, subject, event, place, camera), details, lines as
 * `X's line (emotion): "…"`, then the negative controls it honors
 * ("No subtitles.", "No BGM; …").
 */
const seedance: Build = (shot, ctx) => {
  const line = (d: ShotDialogue) => `${d.speaker}'s line${d.tone ? ` (${clause(d.tone)})` : ''}: ${quoted(d.line)}`;
  const audio = soundSegments(shot, ctx, { music: 'No BGM; only environmental and action sounds.' });
  if (ctx.purpose === 'animate') {
    return [...frames(ctx), action(shot), ...castNames(shot), ...move(shot, 'seedance'), ...speech(shot, ctx, line), ...audio, seg('noSubtitles', 'No subtitles.', 2)];
  }
  return [
    ...refs(ctx),
    ...style(shot),
    subjectLine(shot),
    ...cast(shot),
    action(shot),
    ...setting(shot),
    ...lighting(shot),
    ...lens(shot),
    ...text(shot),
    ...move(shot, 'seedance'),
    ...speech(shot, ctx, line),
    ...audio,
    seg('noSubtitles', 'No subtitles.', 2),
  ];
};

/**
 * Wan 3.0 / Berry (Alibaba Model Studio guide): Entity + Scene + Motion +
 * Aesthetic control + Stylization + Sound; image-to-video is Motion + Camera
 * movement; lines as `X says: "…"`; "No dialogue." / "No background music.".
 */
const wan: Build = (shot, ctx) => {
  const line = (d: ShotDialogue) => `${d.speaker} says${d.tone ? ` in a ${clause(d.tone)} tone` : ''}: ${quoted(d.line)}`;
  const audio = soundSegments(shot, ctx, { music: 'No background music.', dialogue: 'No dialogue.' });
  if (ctx.purpose === 'animate') {
    return [action(shot), ...move(shot, 'wan'), ...castNames(shot), ...speech(shot, ctx, line), ...audio, ...frames(ctx)];
  }
  const frame = framing(shot.camera);
  return [
    ...refs(ctx),
    ...style(shot),
    seg('subject', sentence(capitalize(clause(shot.subject))), 0),
    ...cast(shot),
    ...setting(shot),
    action(shot),
    ...(frame ? [seg('framing', sentence(capitalize(frame)), 2)] : []),
    ...lighting(shot),
    ...lens(shot),
    ...text(shot),
    ...move(shot, 'wan'),
    ...speech(shot, ctx, line),
    ...audio,
    seg('single', 'Generate single shot.', 3),
  ];
};

/**
 * Wan 2.2 image-to-video (open-source I2V rewrite prompt): the dynamic part
 * only (who moves and how, then the camera), nothing the picture already
 * shows, under 100 words.
 */
const wanI2v: Build = (shot, ctx) => {
  if (shot.dialogue?.length) ctx.dropped.push('dialogue');
  if (shot.sound) ctx.dropped.push('sound');
  if (shot.music) ctx.dropped.push('music');
  for (const k of ['setting', 'lighting', 'style'] as const) if (shot[k]) ctx.dropped.push(k);
  return [action(shot), ...move(shot, 'wan-i2v')];
};

/** MiniMax Hailuo: a timeline in plain sentences, one camera move written as a sentence. */
const minimax: Build = (shot, ctx) => {
  if (shot.dialogue?.length) ctx.dropped.push('dialogue');
  if (shot.sound) ctx.dropped.push('sound');
  if (shot.music) ctx.dropped.push('music');
  if (ctx.purpose === 'animate') return [...frames(ctx), action(shot), ...move(shot, 'minimax'), ...castNames(shot)];
  return [...refs(ctx), subjectLine(shot), ...cast(shot), ...setting(shot), action(shot), ...move(shot, 'minimax'), ...lighting(shot), ...lens(shot), ...text(shot), ...style(shot)];
};

/** Grok Imagine video: short and direct; speech is lip-synced. */
const grokVideo: Build = (shot, ctx) => {
  const line = (d: ShotDialogue) => dialogueSentence(d);
  const audio = soundSegments(shot, ctx, {});
  if (ctx.purpose === 'animate') return [action(shot), ...move(shot, 'grok-video'), ...speech(shot, ctx, line), ...audio];
  return [...refs(ctx), subjectLine(shot), ...cast(shot), action(shot), ...setting(shot), ...move(shot, 'grok-video'), ...lighting(shot, 5), ...style(shot, 4), ...text(shot), ...speech(shot, ctx, line), ...audio];
};

const genericVideo: Build = (shot, ctx) => {
  if (shot.dialogue?.length) ctx.dropped.push('dialogue');
  if (shot.sound) ctx.dropped.push('sound');
  if (shot.music) ctx.dropped.push('music');
  if (ctx.purpose === 'animate') return [action(shot), ...move(shot, 'generic'), ...frames(ctx)];
  return [...refs(ctx), ...style(shot), subjectLine(shot), ...cast(shot), action(shot), ...setting(shot), ...lighting(shot), ...lens(shot), ...text(shot), ...move(shot, 'generic')];
};

// ---------------------------------------------------------------- image families

/** A still has no motion, camera move or sound: those parts are not sent. */
function stillParts(shot: ShotSpec): { frame: Segment[] } {
  const frame = framing(shot.camera);
  return { frame: frame ? [seg('framing', sentence(`${capitalize(frame)} composition`), 2)] : [] };
}

/**
 * Seedream (official guide): coherent sentences (subject + action +
 * environment), then lighting, composition and style; text in double quotes;
 * each reference image bound to what it is for.
 */
const seedream: Build = (shot, ctx) => {
  const { frame } = stillParts(shot);
  return [...refs(ctx), seg('subject', sentence(capitalize(clause(shot.subject))), 0), ...cast(shot), action(shot), ...setting(shot), ...lighting(shot), ...frame, ...lens(shot), ...text(shot), ...style(shot)];
};

/** Qwen-Image, Z-Image, Grok image: style first (as in the vendor samples), then the scene. */
const styleFirstImage: Build = (shot, ctx) => {
  const { frame } = stillParts(shot);
  return [...refs(ctx), ...style(shot), seg('subject', sentence(capitalize(clause(shot.subject))), 0), ...cast(shot), action(shot), ...setting(shot), ...lighting(shot), ...frame, ...lens(shot), ...text(shot)];
};

const BUILDERS: Record<PromptFamily, Build> = {
  seedance,
  wan,
  'wan-i2v': wanI2v,
  minimax,
  'grok-video': grokVideo,
  seedream,
  'qwen-image': styleFirstImage,
  'z-image': styleFirstImage,
  'image-edit': seedream,
  'grok-image': styleFirstImage,
  generic: genericVideo,
};

function join(segments: readonly Segment[]): string {
  return segments
    .map((s) => s.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts optional sentences (highest `keep` first) until the text fits; a last resort cut ends at a sentence. */
function fit(segments: Segment[], max: number, dropped: string[]): string {
  const kept = [...segments];
  while (join(kept).length > max) {
    let worst = -1;
    for (let i = 0; i < kept.length; i++) if (kept[i]!.keep > 0 && (worst < 0 || kept[i]!.keep >= kept[worst]!.keep)) worst = i;
    if (worst < 0) break;
    dropped.push(kept[worst]!.key);
    kept.splice(worst, 1);
  }
  const out = join(kept);
  if (out.length <= max) return out;
  dropped.push('truncated');
  const cut = out.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('." '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut;
}

/** Composes a shot for one model. Pure: the same inputs always give the same text. */
export function composePrompt(shot: ShotSpec, model: Pick<CatalogModel, 'id' | 'kind' | 'audio' | 'params'>, opts: ComposeOptions): ComposedPrompt {
  const profile = profileOf(model);
  const purpose = purposeOf(model, opts);
  const dropped: string[] = [];
  const ctx: Ctx = { profile, purpose, opts, dropped, sound: purpose !== 'still' && profile.speech && model.audio && opts.audio !== false };
  const build = profile.family === 'generic' && model.kind === 'image' ? styleFirstImage : BUILDERS[profile.family];
  const prompt = fit(build(shot, ctx), profile.maxChars, dropped);
  const negatives = [opts.negativePrompt?.trim(), profile.negatives === 'param' ? profile.defaultNegative : undefined].filter((x): x is string => !!x);
  return {
    prompt,
    ...(model.params.negativePrompt && negatives.length > 0 && { negativePrompt: negatives.join(', ') }),
    family: profile.family,
    purpose,
    dropped: [...new Set(dropped)],
  };
}

export interface AdaptInput {
  /** The stored prompt: typed by the user, or the canonical text of `shot`. */
  prompt: string;
  negativePrompt?: string;
  /** Present only when `prompt` is still the text composed from it. */
  shot?: ShotSpec;
}

export interface AdaptedPrompt {
  prompt: string;
  negativePrompt?: string;
  /**
   * The prompt was written for this model from a shot. Provider-side prompt
   * rewriting (`prompt_expand` / `prompt_extend`) must stay off for it; a
   * prompt that is not composed is the user's own text, untouched.
   */
  composed: boolean;
  family: PromptFamily;
  dropped: string[];
}

/**
 * The prompt a provider request carries. With a shot: composed for the model.
 * Without one: exactly the stored prompt and negative prompt.
 */
export function adaptPrompt(input: AdaptInput, model: Pick<CatalogModel, 'id' | 'kind' | 'audio' | 'params'>, opts: ComposeOptions): AdaptedPrompt {
  const family = profileOf(model).family;
  if (!input.shot) {
    return { prompt: input.prompt, ...(input.negativePrompt !== undefined && { negativePrompt: input.negativePrompt }), composed: false, family, dropped: [] };
  }
  const c = composePrompt(input.shot, model, { ...opts, ...(input.negativePrompt !== undefined && { negativePrompt: input.negativePrompt }) });
  return { prompt: c.prompt, ...(c.negativePrompt !== undefined && { negativePrompt: c.negativePrompt }), composed: true, family, dropped: c.dropped };
}
