/**
 * Prompt families: how each model family wants its prompt written. One
 * profile per family, with the vendor source it follows
 * (docs/harness-research.md §1 has the links and the quotes).
 *
 * Limits marked "assumed" are not stated by the vendor for the current model
 * version; they are conservative values to revisit after a live run.
 */
import type { CatalogModel } from '../models/types';
import type { CameraMove } from './shot';

export type PromptFamily =
  | 'seedance'
  | 'wan'
  | 'wan-i2v'
  | 'minimax'
  | 'grok-video'
  | 'seedream'
  | 'qwen-image'
  | 'z-image'
  | 'image-edit'
  | 'grok-image'
  | 'generic';

export interface FamilyProfile {
  family: PromptFamily;
  kind: 'video' | 'image';
  /** Languages the model follows well. Composed prompts are English; `zh` here means Chinese typed by a user needs no rewrite. */
  languages: readonly ('en' | 'zh')[];
  /** Hard cap on the composed prompt, in characters (the vendor truncates or refuses beyond it). */
  maxChars: number;
  /** Target length in words for a full description (vendor rewriters aim here). */
  words: { min: number; max: number };
  /** Target ceiling in words when a first frame carries the look. */
  animateWords: number;
  /** Speech in the prompt is voiced (lip-synced) by the model. */
  speech: boolean;
  /**
   * How things to keep out are expressed: `param` = the `negative_prompt`
   * parameter, `inline` = short constraint sentences at the end of the prompt
   * (subtitles and audio only), `none` = say what you want instead.
   */
  negatives: 'param' | 'inline' | 'none';
  /** Default negative prompt for `param` families (English terms). */
  defaultNegative?: string;
  source: string;
}

const PROFILES: Record<PromptFamily, FamilyProfile> = {
  // Dreamina Seedance 2.5 series prompt guide (BytePlus ModelArk): reference binding by upload order,
  // one-sentence summary, detail, optional timeline, `X's line (emotion): "…"`, "No subtitles." / "No BGM".
  seedance: {
    family: 'seedance',
    kind: 'video',
    languages: ['en', 'zh'],
    maxChars: 2000, // assumed
    words: { min: 30, max: 220 },
    animateWords: 120,
    speech: true,
    negatives: 'inline',
    source: 'https://docs.byteplus.com/en/docs/modelark/seedance-2-5-prompt-guide',
  },
  // Alibaba Model Studio video prompt guide (Wan 2.5 to 3.0): Entity + Scene + Motion + Aesthetic control +
  // Stylization + Sound; `X says: "…"`; "No dialogue." / "No background music."; 1,500 characters, cut beyond.
  wan: {
    family: 'wan',
    kind: 'video',
    languages: ['en', 'zh'],
    maxChars: 1500,
    words: { min: 30, max: 200 },
    animateWords: 100,
    speech: true,
    negatives: 'inline',
    source: 'https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt',
  },
  // Wan 2.2 image-to-video (the spicy and LoRA routes): the open-source I2V rewrite prompt keeps motion and
  // camera only, drops what the picture already shows, under 100 words; default negative prompt of the repo.
  'wan-i2v': {
    family: 'wan-i2v',
    kind: 'video',
    languages: ['en', 'zh'],
    maxChars: 800, // assumed
    words: { min: 8, max: 100 },
    animateWords: 100,
    speech: false,
    negatives: 'param',
    defaultNegative:
      'garish colors, overexposed, static, blurry details, subtitles, still frame, grey overall, worst quality, low quality, JPEG artifacts, ugly, incomplete, extra fingers, badly drawn hands, badly drawn face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards',
    source: 'https://github.com/Wan-Video/Wan2.2/blob/main/wan/utils/system_prompt.py',
  },
  // MiniMax Hailuo: a timeline in plain sentences (opening state, ordered action, camera, ending state);
  // camera as one natural sentence. The listing has no audio parameter for H3.
  minimax: {
    family: 'minimax',
    kind: 'video',
    languages: ['en', 'zh'],
    maxChars: 2000, // assumed
    words: { min: 25, max: 180 },
    animateWords: 100,
    speech: false,
    negatives: 'none',
    source: 'https://hailuoai.video/pages/blog/camera-movement-prompt-cheatsheet',
  },
  // xAI Grok Imagine video: no vendor prompt guide; short direct prompts in its examples, speech lip-synced,
  // text-to-video is text-to-image then image-to-video under the hood.
  'grok-video': {
    family: 'grok-video',
    kind: 'video',
    languages: ['en'],
    maxChars: 1000, // assumed
    words: { min: 15, max: 120 },
    animateWords: 80,
    speech: true,
    negatives: 'none',
    source: 'https://docs.x.ai/developers/model-capabilities/video/generation',
  },
  // Seedream 4.0-4.5 prompt guide (BytePlus): coherent natural language (subject + action + environment), then
  // style, color, lighting, composition; text in double quotes; concise beats ornate; name what each image is for.
  seedream: {
    family: 'seedream',
    kind: 'image',
    languages: ['en', 'zh'],
    maxChars: 1500, // assumed
    words: { min: 12, max: 180 },
    animateWords: 0,
    speech: false,
    negatives: 'none',
    source: 'https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide',
  },
  // Qwen-Image: the repo's prompt polisher keeps prompts under 200 words, quotes text to render with its
  // position, and the README samples pass a quality negative prompt.
  'qwen-image': {
    family: 'qwen-image',
    kind: 'image',
    languages: ['en', 'zh'],
    maxChars: 1200, // assumed
    words: { min: 12, max: 200 },
    animateWords: 0,
    speech: false,
    negatives: 'param',
    defaultNegative:
      'low resolution, low quality, deformed limbs, deformed fingers, oversaturated, waxy skin, face without detail, over-smoothed, AI look, chaotic composition, blurry text, distorted text',
    source: 'https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py',
  },
  // Z-Image (the spicy text-to-image routes): detailed natural-language description, no negative prompt.
  'z-image': {
    family: 'z-image',
    kind: 'image',
    languages: ['en', 'zh'],
    maxChars: 1500, // assumed
    words: { min: 12, max: 220 },
    animateWords: 0,
    speech: false,
    negatives: 'none',
    source: 'https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide',
  },
  // Instruction-style edit models (Qwen Image Edit): say what changes and what stays.
  'image-edit': {
    family: 'image-edit',
    kind: 'image',
    languages: ['en', 'zh'],
    maxChars: 1000, // assumed
    words: { min: 6, max: 150 },
    animateWords: 0,
    speech: false,
    negatives: 'none',
    source: 'https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide',
  },
  'grok-image': {
    family: 'grok-image',
    kind: 'image',
    languages: ['en'],
    maxChars: 1000, // assumed
    words: { min: 10, max: 150 },
    animateWords: 0,
    speech: false,
    negatives: 'none',
    source: 'https://docs.x.ai/developers/model-capabilities/video/generation',
  },
  generic: {
    family: 'generic',
    kind: 'video',
    languages: ['en'],
    maxChars: 1500,
    words: { min: 15, max: 200 },
    animateWords: 100,
    speech: false,
    negatives: 'none',
    source: 'docs/harness-research.md',
  },
};

/** The prompt family of a catalog model, by gateway id. Unknown models are `generic`. */
export function promptFamilyOf(model: Pick<CatalogModel, 'id' | 'kind'>): PromptFamily {
  const id = model.id.toLowerCase();
  if (model.kind === 'video') {
    if (id.startsWith('bytedance/seedance')) return 'seedance';
    // Photo-driven Wan 2.x routes (spicy, LoRA) before the Wan 3.0 / Berry routes.
    if (/^lumina\/w(?:an)?2\.\d+-i2v/.test(id)) return 'wan-i2v';
    if (id.startsWith('lumina/berry') || id.startsWith('alibaba/wan')) return 'wan';
    if (id.startsWith('minimax/')) return 'minimax';
    if (id.startsWith('x-ai/grok-imagine')) return 'grok-video';
    return 'generic';
  }
  if (id.startsWith('bytedance/seedream')) return 'seedream';
  if (id.includes('qwen-image-edit')) return 'image-edit';
  if (id.startsWith('qwen/qwen-image')) return 'qwen-image';
  if (id.includes('z-image')) return 'z-image';
  if (id.startsWith('x-ai/grok-imagine')) return 'grok-image';
  return 'generic';
}

export function familyProfile(family: PromptFamily, kind: 'video' | 'image' = PROFILES[family].kind): FamilyProfile {
  const p = PROFILES[family];
  return p.kind === kind ? p : { ...p, kind };
}

export function profileOf(model: Pick<CatalogModel, 'id' | 'kind'>): FamilyProfile {
  return familyProfile(promptFamilyOf(model), model.kind === 'image' ? 'image' : 'video');
}

/**
 * Camera-move wording per family. Seedance and Wan list their own terms in
 * the vendor guides ("push in", "camera pushes in", "fixed camera", "orbiting
 * camera movement"); the others read a plain sentence.
 */
export const FAMILY_MOVES: Partial<Record<PromptFamily, Record<CameraMove, string>>> = {
  seedance: {
    static: 'Fixed camera, the framing stays stable',
    push_in: 'The camera slowly pushes in',
    pull_out: 'The camera slowly pulls back',
    pan_left: 'The camera pans left',
    pan_right: 'The camera pans right',
    tilt_up: 'The camera tilts up',
    tilt_down: 'The camera tilts down',
    truck_left: 'The camera tracks left',
    truck_right: 'The camera tracks right',
    pedestal_up: 'The camera rises',
    pedestal_down: 'The camera lowers',
    orbit: 'The camera orbits slowly around the subject',
    tracking: 'The camera follows the subject',
    handheld: 'Handheld shot with a slight handheld feel',
    zoom_in: 'The camera zooms in',
    zoom_out: 'The camera zooms out',
  },
  wan: {
    static: 'Fixed camera',
    push_in: 'The camera pushes in',
    pull_out: 'The camera pulls out',
    pan_left: 'The camera pans left',
    pan_right: 'The camera pans right',
    tilt_up: 'The camera tilts up',
    tilt_down: 'The camera tilts down',
    truck_left: 'The camera moves left',
    truck_right: 'The camera moves right',
    pedestal_up: 'The camera rises',
    pedestal_down: 'The camera lowers',
    // The guide asks to keep orbits small to avoid spatial distortion.
    orbit: 'Slow orbiting camera movement, a small arc around the subject',
    tracking: 'The camera follows the subject',
    handheld: 'Handheld camera',
    zoom_in: 'The camera zooms in',
    zoom_out: 'The camera zooms out',
  },
  'wan-i2v': {
    static: 'The camera stays still',
    push_in: 'The camera pushes forward',
    pull_out: 'The camera pulls back',
    pan_left: 'The camera pans left',
    pan_right: 'The camera pans right',
    tilt_up: 'The camera pans up',
    tilt_down: 'The camera pans down',
    truck_left: 'The camera moves left',
    truck_right: 'The camera moves right',
    pedestal_up: 'The camera moves upward',
    pedestal_down: 'The camera moves downward',
    orbit: 'The camera slowly circles the subject',
    tracking: 'The camera follows the subject',
    handheld: 'Handheld camera',
    zoom_in: 'The camera zooms in',
    zoom_out: 'The camera zooms out',
  },
};
