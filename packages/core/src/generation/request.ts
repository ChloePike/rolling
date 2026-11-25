/**
 * GenSpec + resolved input URLs → provider-neutral GenerateRequest for one
 * model (the quoted model, or an Auto fallback on retry).
 */
import { fitRequest } from './auto';
import { imageSizeFor, usesSize } from './spec';
import { validateRequest } from '../models/capabilities';
import type { CatalogModel, GenerateRequest, ImageSource } from '../models/types';
import type { GenInput, GenSpec } from './types';

/** One input with its URL (signed, https) and provenance. */
export interface ResolvedInput {
  input: GenInput;
  url: string;
  origin: ImageSource;
}

export function buildGenerateRequest(spec: GenSpec, model: CatalogModel, resolved: readonly ResolvedInput[]): GenerateRequest {
  const fitted = fitRequest(model, {
    kind: spec.kind,
    mode: spec.mode,
    ...(spec.seconds !== undefined && { seconds: spec.seconds }),
    ...(spec.resolution !== undefined && { resolution: spec.resolution }),
    ...(spec.ratio !== undefined && { ratio: spec.ratio }),
    ...(spec.audio !== undefined && { audio: spec.audio }),
    ...(spec.n !== undefined && { n: spec.n }),
  });
  const urls = (role: GenInput['role'], media?: GenInput['media']) =>
    resolved.filter((r) => r.input.role === role && (media === undefined || r.input.media === media)).map((r) => r.url);
  const frames = urls('frame', 'image');
  const refImages = urls('reference', 'image');
  const refVideos = urls('reference', 'video');
  const audios = urls('audio');
  const edits = urls('edit', 'image');

  const size = usesSize(model) ? imageSizeFor(spec.resolution, spec.ratio) : null;
  const req: GenerateRequest = {
    kind: spec.kind,
    mode: spec.mode,
    prompt: spec.prompt,
    ...(spec.negativePrompt !== undefined && model.params.negativePrompt && { negativePrompt: spec.negativePrompt }),
    ...(spec.seed !== undefined && model.params.seed && { seed: spec.seed }),
    ...(fitted.seconds !== undefined && { seconds: fitted.seconds }),
    ...(fitted.resolution !== undefined && { resolution: fitted.resolution }),
    ...(fitted.ratio !== undefined && { ratio: fitted.ratio }),
    ...(fitted.audio !== undefined && { audio: fitted.audio }),
    ...(fitted.n !== undefined && { n: fitted.n }),
    ...(size && { size }),
    ...(frames[0] !== undefined && { firstFrameUrl: frames[0] }),
    ...(frames[1] !== undefined && { lastFrameUrl: frames[1] }),
    ...(refImages.length > 0 && { referenceImageUrls: refImages }),
    ...(refVideos.length > 0 && { referenceVideoUrls: refVideos }),
    ...(edits.length > 0 && { inputImageUrls: edits }),
    ...(spec.mature && { mature: true }),
  };
  if (audios.length > 0) {
    if (model.lipSync && audios.length === 1) req.audioUrl = audios[0];
    else req.referenceAudioUrls = audios;
  }
  const origins = resolved.filter((r) => r.input.media === 'image').map((r) => r.origin);
  if (origins.length > 0) req.imageSources = origins;
  return req;
}

/** Problems with a request for a model (empty when it fits). */
export function requestProblems(model: CatalogModel, req: GenerateRequest): string[] {
  return validateRequest(model, req);
}
