/**
 * Capability checks over the live catalog (D-002). Everything here works on
 * CatalogModel values from a `Catalog` built from `GET /v1/models` plus the
 * product overlay; there is no hand-maintained model table.
 *
 * D-005 routing:
 * - Mature runs go only to models with `matureRouting: 'allowed'` (the
 *   `lumina/*-spicy` family and models that accept `moderation`), with
 *   Hyperouter `moderation: "low"`; everything else sends `moderation: "auto"`.
 * - Identity-driven models in the mature family (`platform_assets_only`) take
 *   a mature run only when every input picture is a platform asset
 *   (generated, character or public). Uploaded photos are rejected.
 * - Face/head swap never takes a mature run.
 */
import { Catalog, usdCost, type PriceRequest } from './catalog';
import { isSwapModel } from './overlay';
import {
  PLATFORM_IMAGE_SOURCES,
  type CatalogModel,
  type GenerateRequest,
  type GenerationMode,
  type ImageSource,
} from './types';

export class MatureRoutingError extends Error {
  override readonly name = 'MatureRoutingError';
  constructor(
    readonly modelKey: string,
    readonly reason: string = 'model is not allowed for mature runs',
  ) {
    super(`Model ${modelKey} is not allowed for mature runs: ${reason}.`);
  }
}

/** Number of input pictures in a request (frames, reference images, edit inputs). */
export function inputImageCount(req: GenerateRequest): number {
  return (
    (req.firstFrameUrl !== undefined ? 1 : 0) +
    (req.lastFrameUrl !== undefined ? 1 : 0) +
    (req.referenceImageUrls?.length ?? 0) +
    (req.inputImageUrls?.length ?? 0)
  );
}

/**
 * Why a mature run may not use this model, or null when it may (D-005).
 * `imageSources` must describe every input picture (`inputImages` of them).
 */
export function matureRunProblem(
  model: CatalogModel,
  imageSources: readonly ImageSource[] | undefined,
  inputImages: number,
): string | null {
  if (isSwapModel(model)) return 'face/head swap is never used for mature runs';
  switch (model.matureRouting) {
    case 'allowed':
      return null;
    case 'never':
      return 'model is not in the mature family';
    case 'platform_assets_only': {
      if (inputImages === 0) return null;
      if (!imageSources || imageSources.length !== inputImages) {
        return 'identity-driven model needs the source of every input picture';
      }
      if (!imageSources.every((s) => PLATFORM_IMAGE_SOURCES.includes(s))) {
        return 'identity-driven model takes only platform assets (generated, character, public) in mature runs';
      }
      return null;
    }
  }
}

/**
 * True when a mature run may go to this model. Without `imageSources`, only
 * models that need no asset check (`matureRouting: 'allowed'`) qualify.
 */
export function isMatureRoutable(model: CatalogModel, imageSources?: readonly ImageSource[]): boolean {
  if (model.matureRouting === 'allowed') return true;
  if (model.matureRouting === 'never' || imageSources === undefined) return false;
  return matureRunProblem(model, imageSources, imageSources.length) === null;
}

/**
 * Moderation value to send (D-005): `low` only for mature runs the model may
 * take, `auto` for everything else. A mature run it may not take is refused.
 */
export function moderationFor(
  model: CatalogModel,
  mature: boolean | undefined,
  req?: Pick<GenerateRequest, 'imageSources' | 'firstFrameUrl' | 'lastFrameUrl' | 'referenceImageUrls' | 'inputImageUrls'>,
): 'auto' | 'low' {
  if (!mature) return 'auto';
  const count = req ? inputImageCount(req as GenerateRequest) : 0;
  const problem = matureRunProblem(model, req?.imageSources, count);
  if (problem) throw new MatureRoutingError(model.id, problem);
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
export function unmetCapability(model: CatalogModel, req: AutoRequest): string | null {
  if (model.kind !== req.kind) return 'kind';
  if (!model.operations.includes(req.mode)) return 'mode';
  if (req.mature && model.matureRouting !== 'allowed') return 'mature';
  if (req.seconds !== undefined) {
    if (!model.seconds) return 'seconds';
    const { min, max, allowed } = model.seconds;
    if (allowed ? !allowed.includes(req.seconds) : req.seconds < min || req.seconds > max) return 'seconds';
  }
  if (req.resolution !== undefined && model.resolutions.length > 0 && !model.resolutions.includes(req.resolution)) {
    return 'resolution';
  }
  if (req.ratio !== undefined && !model.ratios.includes(req.ratio)) return 'ratio';
  if (req.audio && !model.audio) return 'audio';
  if (model.kind === 'image' && (req.n ?? 1) > model.maxImagesPerRequest) return 'n';
  if ((req.referenceImages ?? 0) > model.maxReferenceImages) return 'referenceImages';
  if ((req.referenceVideos ?? 0) > model.maxReferenceVideos) return 'referenceVideos';
  if ((req.referenceAudios ?? 0) > model.maxReferenceAudios) return 'referenceAudios';
  if ((req.inputImages ?? 0) > model.maxInputImages) return 'inputImages';
  return null;
}

/** Gateway USD estimate for one request, or null when it cannot be priced. */
export function estimateUsd(model: CatalogModel, req: PriceRequest = {}): number | null {
  return usdCost(model, req);
}

/** PriceRequest for a concrete GenerateRequest. `inputVideoMs` comes from probing the clips, when known. */
export function priceRequestFor(req: GenerateRequest, inputVideoMs?: number): PriceRequest {
  return {
    ...(req.resolution !== undefined && { resolution: req.resolution }),
    ...(req.seconds !== undefined && { seconds: req.seconds }),
    ...(req.audio !== undefined && { audio: req.audio }),
    ...(req.n !== undefined && { n: req.n }),
    ...(req.size !== undefined && { size: req.size }),
    inputImages: inputImageCount(req),
    referenceVideos: req.referenceVideoUrls?.length ?? 0,
    ...(inputVideoMs !== undefined && { inputVideoMs }),
  };
}

/**
 * Auto model: the cheapest Auto-eligible model of the catalog that fits the
 * request. Resolution, when unset, is compared at each model's own default and
 * video length at 5 s. Ties go to the kind's default model, then by id.
 * Identity-driven and hidden models are never picked. Returns null when nothing fits.
 */
export function pickAuto(catalog: Catalog | readonly CatalogModel[], req: AutoRequest): CatalogModel | null {
  const models = catalog instanceof Catalog ? catalog.models : catalog;
  let best: { model: CatalogModel; usd: number } | null = null;
  for (const model of models) {
    if (!model.auto || model.hidden || model.requiresIdentitySafety) continue;
    if (unmetCapability(model, req) !== null) continue;
    const usd = estimateUsd(model, {
      ...(req.resolution !== undefined && { resolution: req.resolution }),
      ...(req.audio !== undefined && { audio: req.audio }),
      ...(req.n !== undefined && { n: req.n }),
      seconds: req.seconds ?? 5,
      inputImages: (req.inputImages ?? 0) + (req.referenceImages ?? 0),
      referenceVideos: req.referenceVideos ?? 0,
    });
    if (usd === null) continue;
    const better =
      !best ||
      usd < best.usd ||
      (usd === best.usd && (model.default !== best.model.default ? model.default : model.id < best.model.id));
    if (better) best = { model, usd };
  }
  return best?.model ?? null;
}

const FIELD_PARAM: [keyof GenerateRequest, string][] = [
  ['firstFrameUrl', 'first_frame'],
  ['lastFrameUrl', 'last_frame'],
  ['referenceImageUrls', 'reference_images'],
  ['referenceVideoUrls', 'reference_videos'],
  ['referenceAudioUrls', 'reference_audios'],
  ['audioUrl', 'audio_url'],
];

/** Gateway parameter names a request sends (for the listing's exclusive / needs rules). */
function sentParams(req: GenerateRequest): Set<string> {
  const sent = new Set<string>();
  for (const [field, param] of FIELD_PARAM) {
    const v = req[field];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) sent.add(param);
  }
  for (const k of Object.keys(req.extra ?? {})) sent.add(k);
  return sent;
}

/**
 * Checks a concrete GenerateRequest against a model before any provider call.
 * Returns the list of problems (empty when the request fits). Nothing is
 * dropped silently: unsupported fields are problems, as at the gateway.
 */
export function validateRequest(model: CatalogModel, req: GenerateRequest): string[] {
  const problems: string[] = [];
  if (model.kind !== req.kind) problems.push(`kind ${req.kind} not supported`);
  const unmet = unmetCapability(
    { ...model, kind: req.kind },
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
    },
  );
  if (unmet) problems.push(`${unmet} not supported`);
  if (req.mature) {
    const problem = matureRunProblem(model, req.imageSources, inputImageCount(req));
    if (problem) problems.push(`mature not supported: ${problem}`);
  }
  if (req.seed !== undefined && !model.params.seed) problems.push('seed not supported');
  if (req.negativePrompt !== undefined && !model.params.negativePrompt) problems.push('negativePrompt not supported');
  if (req.size !== undefined && !model.params.size) problems.push('size not supported');
  if (req.audioUrl !== undefined && !model.lipSync) problems.push('audioUrl not supported');
  if (model.requiredParams.includes('prompt') && req.prompt.trim() === '') problems.push('prompt is required');

  // Listing rules: mutually exclusive groups and dependencies.
  const sent = sentParams(req);
  for (const groups of model.exclusive) {
    const used = groups.filter((g) => g.some((p) => sent.has(p)));
    if (used.length > 1) problems.push(`${used.map((g) => g.filter((p) => sent.has(p)).join('/')).join(' cannot be combined with ')}`);
  }
  for (const [param, oneOf] of Object.entries(model.needs)) {
    if (sent.has(param) && !oneOf.some((p) => sent.has(p))) problems.push(`${param} needs one of ${oneOf.join('/')}`);
  }

  if (req.lastFrameUrl !== undefined && req.firstFrameUrl === undefined) problems.push('lastFrame needs a firstFrame');
  if ((req.mode === 'i2v' || req.mode === 'first_last_frame') && req.firstFrameUrl === undefined) {
    problems.push(`${req.mode} needs firstFrameUrl`);
  }
  if (req.mode === 'first_last_frame' && req.lastFrameUrl === undefined) problems.push('first_last_frame needs lastFrameUrl');
  if (req.mode === 'edit' && (req.inputImageUrls?.length ?? 0) === 0) problems.push('edit needs inputImageUrls');
  if (model.kind === 'image' && (req.inputImageUrls?.length ?? 0) > 0 && (req.inputImageUrls?.length ?? 0) < model.minInputImages) {
    problems.push(`at least ${model.minInputImages} input images`);
  }
  if (req.fallbackModelIds && req.fallbackModelIds.length > 5) problems.push('at most 5 fallback models');
  return problems;
}
