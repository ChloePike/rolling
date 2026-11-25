import type { GenerateRequest, GenerationMode, ModelCapabilities } from './types';

/**
 * Model capabilities table (D-002), confirmed against Hyperouter `GET /v1/models`
 * (`param_schema` and `prices`) on 2026-11-25. Prices are the gateway's USD list
 * prices for text/image-driven output; Seedance also has a lower per-second rate
 * when `reference_videos` are sent, plus a per-ms charge for the input clip,
 * which we ignore here (the higher rate is the conservative basis).
 *
 * D-005: `mature` stays false for every model until Hyperouter confirms which
 * models carry a screening opt-out and allow adult output. Identity models
 * (`requiresIdentitySafety`) are never routable for mature runs.
 */

const SOURCE = 'GET /v1/models 2026-11-25';
const NOT_CONFIRMED = 'Not confirmed with the provider; default false (D-005).';
const SPICY_NOTE =
  'Name ("Spicy") suggests adult-oriented output, but the model metadata has no description or flag that confirms it. Kept false until Hyperouter confirms (D-005).';

const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const WAN_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'];
const VIDEO_FULL_MODES: GenerationMode[] = ['t2v', 'i2v', 'first_last_frame', 'refs'];
const NO_PARAMS = { seed: false, negativePrompt: false, promptExtend: false, size: false };

export const MODEL_CAPABILITIES: readonly ModelCapabilities[] = [
  // ------------------------------------------------------------------ video
  {
    key: 'seedance-2.5',
    label: 'Seedance 2.5',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedance-2.5',
    status: 'launch',
    creditKey: 'seedance-2.5',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 4, max: 15 },
    resolutions: ['480p', '720p', '1080p'],
    ratios: SEEDANCE_RATIOS,
    audio: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    params: NO_PARAMS,
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.1074708, '720p': 0.23112, '1080p': 0.56862 }, source: SOURCE },
    autoEligible: true,
    notes: 'PRD says up to 30 s; the gateway allows 4 to 15 s. Keyframes cannot be combined with reference media.',
  },
  {
    key: 'minimax-h3',
    label: 'MiniMax H3',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'minimax/minimax-h3',
    status: 'launch',
    creditKey: 'minimax-h3',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 4, max: 15 },
    resolutions: ['768p', '2K'],
    ratios: SEEDANCE_RATIOS,
    audio: false,
    maxReferenceImages: 5,
    maxReferenceVideos: 3,
    params: NO_PARAMS,
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '768p': 0.08, '2K': 0.13 }, source: SOURCE },
    autoEligible: true,
    notes: 'PRD says native audio and 9 image + 3 video + 3 audio refs; the gateway lists no audio, 5 images, 3 videos, no audio refs.',
  },
  {
    key: 'wan-3.0',
    label: 'Wan 3.0',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'alibaba/wan3.0',
    status: 'launch',
    creditKey: 'wan-3.0',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 2, max: 30 },
    resolutions: ['480p', '720p', '1080p'],
    ratios: WAN_RATIOS,
    audio: true,
    maxReferenceImages: 10,
    maxReferenceVideos: 5,
    maxReferenceAudios: 5,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: false },
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.05, '720p': 0.1, '1080p': 0.2 }, source: SOURCE },
    autoEligible: true,
    notes: 'Docs/web pages to video via extra fields `file` / `link`. PRD "extend" is not listed in `operations`.',
  },
  {
    key: 'seedance-2.0-mini',
    label: 'Seedance 2.0 Mini',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedance-2.0-mini',
    status: 'substitute',
    substituteFor: 'wan-2.2',
    creditKey: 'wan-2.2',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 4, max: 15 },
    resolutions: ['480p', '720p'],
    ratios: SEEDANCE_RATIOS,
    audio: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    params: NO_PARAMS,
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.035154, '720p': 0.0756 }, source: SOURCE },
    autoEligible: true,
    notes: 'Cheapest launch-grade video. Stands in for Wan 2.2 (cheap and fast).',
  },
  {
    key: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedance-2.0-fast',
    status: 'substitute',
    substituteFor: 'wan-2.2',
    creditKey: 'wan-2.2',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 4, max: 15 },
    resolutions: ['480p', '720p'],
    ratios: SEEDANCE_RATIOS,
    audio: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    params: NO_PARAMS,
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.0562464, '720p': 0.12096 }, source: SOURCE },
    autoEligible: true,
  },
  {
    key: 'seedance-2.5-flash',
    label: 'Seedance 2.5 Flash',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedance-2.5-flash',
    status: 'candidate',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 4, max: 15 },
    resolutions: ['480p', '720p'],
    ratios: SEEDANCE_RATIOS,
    audio: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    params: NO_PARAMS,
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.070308, '720p': 0.1512 }, source: SOURCE },
    autoEligible: false,
    notes: 'New on the gateway; not in the PRD. No credit price yet.',
  },
  {
    key: 'wan-3.0-turbo',
    label: 'Wan 3.0 Turbo',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'alibaba/wan3.0-turbo',
    status: 'candidate',
    modes: VIDEO_FULL_MODES,
    seconds: { min: 2, max: 30 },
    resolutions: ['480p', '720p', '1080p'],
    ratios: WAN_RATIOS,
    audio: true,
    maxReferenceImages: 10,
    maxReferenceVideos: 5,
    maxReferenceAudios: 5,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: false },
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_second', usd: { '480p': 0.068, '720p': 0.14, '1080p': 0.28 }, source: SOURCE },
    autoEligible: false,
  },
  {
    key: 'wan-2.7-i2v-spicy',
    label: 'Wan 2.7 I2V (lip sync)',
    kind: 'avatar',
    provider: 'hyperouter',
    providerModelId: 'lumina/wan2.7-i2v-spicy',
    status: 'candidate',
    substituteFor: 'wan-2.2-s2v',
    modes: ['i2v', 'lip_sync'],
    seconds: { min: 2, max: 15 },
    resolutions: ['720p', '1080p'],
    ratios: [],
    audio: true,
    lipSync: true,
    params: { seed: true, negativePrompt: true, promptExtend: true, size: false },
    mature: false,
    matureNote: SPICY_NOTE,
    requiresIdentitySafety: true,
    price: { unit: 'per_second', usd: { '720p': 0.13, '1080p': 0.2 }, source: SOURCE },
    autoEligible: false,
    notes:
      'Photo + `audio_url` (WAV/MP3, 2 to 30 s) lip sync: the only avatar-like path on the gateway. Needs a voice track from elsewhere (no TTS). Animates a person photo, so identity checks apply.',
  },
  {
    key: 'wan-2.2-i2v-spicy',
    label: 'Wan 2.2 I2V Spicy',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'lumina/wan2.2-i2v-spicy',
    status: 'candidate',
    modes: ['i2v', 'first_last_frame'],
    seconds: { min: 5, max: 8, allowed: [5, 8] },
    resolutions: ['480p', '720p'],
    ratios: [],
    audio: false,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: false },
    mature: false,
    matureNote: SPICY_NOTE,
    price: { unit: 'per_second', usd: { '480p': 0.02, '720p': 0.04 }, source: SOURCE },
    autoEligible: false,
    notes: 'Needs an input picture. Wan 2.2 lineage but image-to-video only.',
  },
  {
    key: 'wan-animate',
    label: 'Wan Animate',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'lumina/wan-animate',
    status: 'candidate',
    modes: ['motion_transfer'],
    resolutions: ['720p', '480p'],
    ratios: [],
    audio: false,
    maxReferenceVideos: 1,
    params: { seed: true, negativePrompt: false, promptExtend: false, size: false },
    mature: false,
    matureNote: NOT_CONFIRMED,
    requiresIdentitySafety: true,
    price: { unit: 'per_second', usd: { '480p': 0.053, '720p': 0.11 }, source: SOURCE },
    autoEligible: false,
    notes: 'Motion transfer (picture + driving clip, `mode` animate|replace). Not lip sync; output length = clip length.',
  },
  {
    key: 'video-face-swap',
    label: 'Video Face Swap',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'lumina/video-face-swap',
    status: 'candidate',
    modes: ['face_swap'],
    seconds: { min: 2, max: 30 },
    resolutions: ['480p', '720p', '1080p'],
    ratios: WAN_RATIOS,
    audio: true,
    maxReferenceImages: 2,
    maxReferenceVideos: 1,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: false },
    mature: false,
    matureNote: 'Never mature: identity model (D-005 forbids intimate content of real people).',
    requiresIdentitySafety: true,
    price: { unit: 'per_second', usd: { '480p': 0.05, '720p': 0.1, '1080p': 0.2 }, source: SOURCE },
    autoEligible: false,
  },
  {
    key: 'video-head-swap',
    label: 'Video Head Swap',
    kind: 'video',
    provider: 'hyperouter',
    providerModelId: 'lumina/video-head-swap',
    status: 'candidate',
    modes: ['head_swap'],
    seconds: { min: 2, max: 30 },
    resolutions: ['480p', '720p', '1080p'],
    ratios: WAN_RATIOS,
    audio: true,
    maxReferenceImages: 2,
    maxReferenceVideos: 1,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: false },
    mature: false,
    matureNote: 'Never mature: identity model (D-005 forbids intimate content of real people).',
    requiresIdentitySafety: true,
    price: { unit: 'per_second', usd: { '480p': 0.05, '720p': 0.1, '1080p': 0.2 }, source: SOURCE },
    autoEligible: false,
  },
  // ------------------------------------------------------------------ image
  {
    key: 'seedream-5.5',
    label: 'Seedream 5.5',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedream-5.5',
    status: 'substitute',
    substituteFor: 'seedream-5.0-pro',
    creditKey: 'seedream-5.0-pro',
    modes: ['t2i', 'edit'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 10,
    maxImagesPerRequest: 1,
    params: { ...NO_PARAMS, size: true },
    mature: false,
    matureNote: NOT_CONFIRMED,
    // $0.035 at 2,601,124 px or more (about 1613x1613, i.e. 2K); $0.008 per input picture on edits.
    price: { unit: 'per_image', usd: { default: 0.02, '2K': 0.035 }, source: SOURCE },
    autoEligible: true,
    notes: 'Seedream 5.0 Pro is not listed; 5.5 is the likely Pro default. Confirm with product.',
  },
  {
    key: 'seedream-5.0-lite',
    label: 'Seedream 5.0 Lite',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedream-5.0-lite',
    status: 'launch',
    creditKey: 'seedream-5.0-lite',
    modes: ['t2i', 'edit'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 10,
    maxImagesPerRequest: 1,
    params: { ...NO_PARAMS, size: true },
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_image', usd: { default: 0.035 }, source: SOURCE },
    autoEligible: true,
    notes: 'One 2K image per request. Costs more than 5.5 and 5.0 Flash at the gateway.',
  },
  {
    key: 'seedream-5.0-flash',
    label: 'Seedream 5.0 Flash',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'bytedance/seedream-5.0-flash',
    status: 'substitute',
    substituteFor: 'seedream-5.0-lite',
    creditKey: 'seedream-5.0-lite',
    modes: ['t2i', 'edit'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 10,
    maxImagesPerRequest: 1,
    params: { ...NO_PARAMS, size: true },
    mature: false,
    matureNote: NOT_CONFIRMED,
    price: { unit: 'per_image', usd: { default: 0.018 }, source: SOURCE },
    autoEligible: true,
  },
  {
    key: 'qwen-image-2.0',
    label: 'Qwen Image 2.0',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'qwen/qwen-image-2.0',
    status: 'substitute',
    substituteFor: 'wan-2.7-image',
    creditKey: 'wan-2.7-image',
    modes: ['t2i', 'edit'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 3,
    maxImagesPerRequest: 6,
    params: { seed: true, negativePrompt: true, promptExtend: true, size: true },
    mature: false,
    matureNote:
      'Its `supported_parameters` lists `moderation`, which suggests a screening opt-out exists; adult output not confirmed. Kept false (D-005).',
    price: { unit: 'per_image', usd: { default: 0.035 }, source: SOURCE },
    autoEligible: true,
  },
  {
    key: 'z-image-spicy',
    label: 'Z-Image Spicy',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'lumina/z-image-spicy',
    status: 'candidate',
    modes: ['t2i'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxImagesPerRequest: 1,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: true },
    mature: false,
    matureNote: SPICY_NOTE,
    price: { unit: 'per_image', usd: { default: 0.013 }, source: SOURCE },
    autoEligible: false,
    notes: 'Async only.',
  },
  {
    key: 'z-image-spicy-pro',
    label: 'Z-Image Spicy Pro',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'lumina/z-image-spicy-pro',
    status: 'candidate',
    modes: ['t2i'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxImagesPerRequest: 1,
    params: { seed: true, negativePrompt: false, promptExtend: true, size: true },
    mature: false,
    matureNote: SPICY_NOTE,
    price: { unit: 'per_image', usd: { default: 0.02 }, source: SOURCE },
    autoEligible: false,
    notes: 'Async only.',
  },
  {
    key: 'qwen-image-edit-spicy',
    label: 'Qwen Image Edit Spicy',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'lumina/qwen-image-edit-spicy',
    status: 'candidate',
    modes: ['edit'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 3,
    maxImagesPerRequest: 1,
    params: { seed: true, negativePrompt: false, promptExtend: false, size: false },
    mature: false,
    matureNote: SPICY_NOTE,
    // 0.043 with 2 input pictures, 0.046 with 3.
    price: { unit: 'per_image', usd: { default: 0.04 }, source: SOURCE },
    autoEligible: false,
    notes: 'Edit only. Edits uploaded photos, so identity checks on inputs still apply in core/safety.',
  },
  {
    key: 'face-swap',
    label: 'Face Swap',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'lumina/face-swap',
    status: 'candidate',
    modes: ['face_swap'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 2,
    maxImagesPerRequest: 1,
    params: { seed: true, negativePrompt: false, promptExtend: false, size: false },
    mature: false,
    matureNote: 'Never mature: identity model (D-005 forbids intimate content of real people).',
    requiresIdentitySafety: true,
    price: { unit: 'per_image', usd: { default: 0.013 }, source: SOURCE },
    autoEligible: false,
    notes: 'Exactly 2 pictures: the face going in, then the target photo. No prompt.',
  },
  {
    key: 'head-swap',
    label: 'Head Swap',
    kind: 'image',
    provider: 'hyperouter',
    providerModelId: 'lumina/head-swap',
    status: 'candidate',
    modes: ['head_swap'],
    resolutions: [],
    ratios: [],
    audio: false,
    maxInputImages: 2,
    maxImagesPerRequest: 1,
    params: { seed: true, negativePrompt: false, promptExtend: false, size: false },
    mature: false,
    matureNote: 'Never mature: identity model (D-005 forbids intimate content of real people).',
    requiresIdentitySafety: true,
    price: { unit: 'per_image', usd: { default: 0.013 }, source: SOURCE },
    autoEligible: false,
    notes: 'Exactly 2 pictures: the head going in, then the target photo. No prompt.',
  },
];

const BY_KEY = new Map(MODEL_CAPABILITIES.map((m) => [m.key, m]));
const BY_PROVIDER_ID = new Map(MODEL_CAPABILITIES.map((m) => [m.providerModelId, m]));

export function getCapabilities(key: string): ModelCapabilities | undefined {
  return BY_KEY.get(key);
}

export function getCapabilitiesByProviderId(providerModelId: string): ModelCapabilities | undefined {
  return BY_PROVIDER_ID.get(providerModelId);
}

/** True when a model may receive mature runs (D-005). Identity models never may. */
export function isMatureRoutable(cap: ModelCapabilities): boolean {
  return cap.mature && !cap.requiresIdentitySafety;
}

export class MatureRoutingError extends Error {
  override readonly name = 'MatureRoutingError';
  constructor(readonly modelKey: string) {
    super(`Model ${modelKey} is not allowed for mature runs.`);
  }
}

/**
 * Moderation value to send (D-005): `low` only for mature runs on mature models,
 * `auto` for everything else. A mature run on any other model is refused.
 */
export function moderationFor(cap: ModelCapabilities, mature: boolean | undefined): 'auto' | 'low' {
  if (!mature) return 'auto';
  if (!isMatureRoutable(cap)) throw new MatureRoutingError(cap.key);
  return 'low';
}

export interface AutoRequest {
  kind: 'image' | 'video';
  mode: GenerationMode;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  n?: number;
  referenceImages?: number;
  referenceVideos?: number;
  referenceAudios?: number;
  inputImages?: number;
  mature?: boolean;
}

/** Why a model does not fit a request, or null when it fits. */
export function unmetCapability(cap: ModelCapabilities, req: AutoRequest): string | null {
  if (cap.kind !== req.kind) return 'kind';
  if (!cap.modes.includes(req.mode)) return 'mode';
  if (req.mature && !isMatureRoutable(cap)) return 'mature';
  if (req.seconds !== undefined) {
    if (!cap.seconds) return 'seconds';
    const { min, max, allowed } = cap.seconds;
    if (allowed ? !allowed.includes(req.seconds) : req.seconds < min || req.seconds > max) return 'seconds';
  }
  if (req.resolution !== undefined && cap.resolutions.length > 0 && !cap.resolutions.includes(req.resolution)) {
    return 'resolution';
  }
  if (req.ratio !== undefined && !cap.ratios.includes(req.ratio)) return 'ratio';
  if (req.audio && !cap.audio) return 'audio';
  if ((req.n ?? 1) > (cap.maxImagesPerRequest ?? 1) && cap.kind === 'image') return 'n';
  if ((req.referenceImages ?? 0) > (cap.maxReferenceImages ?? 0)) return 'referenceImages';
  if ((req.referenceVideos ?? 0) > (cap.maxReferenceVideos ?? 0)) return 'referenceVideos';
  if ((req.referenceAudios ?? 0) > (cap.maxReferenceAudios ?? 0)) return 'referenceAudios';
  if ((req.inputImages ?? 0) > (cap.maxInputImages ?? 0)) return 'inputImages';
  return null;
}

/** Gateway USD estimate for one request on `cap`, or null when it cannot be priced. */
export function estimateUsd(
  cap: ModelCapabilities,
  req: { seconds?: number; resolution?: string; n?: number },
): number | null {
  const usd = cap.price.usd;
  if (cap.price.unit === 'per_image') {
    const unit = (req.resolution !== undefined ? usd[req.resolution] : undefined) ?? usd.default;
    return unit === undefined ? null : unit * (req.n ?? 1);
  }
  const resolution = req.resolution ?? cap.resolutions[0];
  const unit = resolution ? usd[resolution] : usd.default;
  const seconds = req.seconds ?? cap.seconds?.min;
  if (unit === undefined || seconds === undefined) return null;
  return unit * seconds;
}

const STATUS_RANK: Record<ModelCapabilities['status'], number> = { launch: 0, substitute: 1, candidate: 2 };

/**
 * Auto model: the cheapest auto-eligible model that satisfies the request.
 * When unset, resolution is compared at each model's own default and video
 * length at 5 s.
 * Ties go to launch models. Returns null when nothing fits.
 */
export function pickAuto(
  req: AutoRequest,
  models: readonly ModelCapabilities[] = MODEL_CAPABILITIES,
): ModelCapabilities | null {
  let best: { cap: ModelCapabilities; usd: number } | null = null;
  for (const cap of models) {
    if (!cap.autoEligible || cap.requiresIdentitySafety) continue;
    if (unmetCapability(cap, req) !== null) continue;
    // Compare video at the same length (5 s, the credit unit) when none was asked.
    const usd = estimateUsd(cap, { ...req, seconds: req.seconds ?? (cap.kind === 'image' ? undefined : 5) });
    if (usd === null) continue;
    if (
      !best ||
      usd < best.usd ||
      (usd === best.usd && STATUS_RANK[cap.status] < STATUS_RANK[best.cap.status])
    ) {
      best = { cap, usd };
    }
  }
  return best?.cap ?? null;
}

/**
 * Checks a concrete GenerateRequest against a model before any provider call.
 * Returns the list of problems (empty when the request fits). Nothing is
 * dropped silently: unsupported fields are problems, as at the gateway.
 */
export function validateRequest(cap: ModelCapabilities, req: GenerateRequest): string[] {
  const problems: string[] = [];
  const kindOk = cap.kind === req.kind || (cap.kind === 'avatar' && req.kind === 'video');
  if (!kindOk) problems.push(`kind ${req.kind} not supported`);
  const unmet = unmetCapability(
    { ...cap, kind: req.kind },
    {
      kind: req.kind,
      mode: req.mode,
      ...(req.seconds !== undefined && { seconds: req.seconds }),
      ...(req.resolution !== undefined && { resolution: req.resolution }),
      ...(req.ratio !== undefined && { ratio: req.ratio }),
      ...(req.audio !== undefined && { audio: req.audio }),
      ...(req.n !== undefined && { n: req.n }),
      referenceImages: req.referenceImageUrls?.length ?? 0,
      referenceVideos: req.referenceVideoUrls?.length ?? 0,
      referenceAudios: req.referenceAudioUrls?.length ?? 0,
      inputImages: req.inputImageUrls?.length ?? 0,
      ...(req.mature !== undefined && { mature: req.mature }),
    },
  );
  if (unmet) problems.push(`${unmet} not supported`);
  if (req.seed !== undefined && !cap.params.seed) problems.push('seed not supported');
  if (req.negativePrompt !== undefined && !cap.params.negativePrompt) problems.push('negativePrompt not supported');
  if (req.size !== undefined && !cap.params.size) problems.push('size not supported');
  const hasKeyframes = req.firstFrameUrl !== undefined || req.lastFrameUrl !== undefined;
  const hasRefs =
    (req.referenceImageUrls?.length ?? 0) + (req.referenceVideoUrls?.length ?? 0) + (req.referenceAudioUrls?.length ?? 0) > 0;
  if (hasKeyframes && hasRefs) problems.push('keyframes cannot be combined with reference media');
  if (req.lastFrameUrl !== undefined && req.firstFrameUrl === undefined) problems.push('lastFrame needs a firstFrame');
  if ((req.mode === 'i2v' || req.mode === 'first_last_frame') && req.firstFrameUrl === undefined) {
    problems.push(`${req.mode} needs firstFrameUrl`);
  }
  if (req.mode === 'first_last_frame' && req.lastFrameUrl === undefined) problems.push('first_last_frame needs lastFrameUrl');
  if (req.mode === 'edit' && (req.inputImageUrls?.length ?? 0) === 0) problems.push('edit needs inputImageUrls');
  if (req.fallbackModelIds && req.fallbackModelIds.length > 5) problems.push('at most 5 fallback models');
  return problems;
}
