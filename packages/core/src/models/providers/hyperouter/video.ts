import type { GenerateRequest, JobOutput, JobState, JobStatus, CatalogModel } from '../../types';
import { errorFromResponse, type HyperouterClient } from './client';
import { HYPEROUTER_DEFAULTS, HYPEROUTER_PATHS } from './config';
import { jobErrorFrom } from './job-errors';

/** The Video object (OpenAI Videos API shape). */
export interface HyperouterVideo {
  id: string;
  object?: 'video';
  model?: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number | null;
  seconds?: string | number | null;
  size?: string | null;
  created_at?: number | null;
  completed_at?: number | null;
  expires_at?: number | null;
  error?: { code?: string | null; message?: string | null } | null;
  usage?: { cost?: number | null; seconds?: number | null } | null;
}

export interface VideoCreateBody {
  model: string;
  prompt?: string;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  seed?: number;
  negative_prompt?: string;
  first_frame?: string;
  /** Start picture of models whose listing has no `first_frame` (image-to-video only, e.g. `lumina/wan2.7-i2v-spicy`). */
  input_reference?: { image_url: string };
  last_frame?: string;
  reference_images?: string[];
  reference_videos?: string[];
  reference_audios?: string[];
  audio_url?: string;
  models?: string[];
  moderation: 'auto' | 'low';
  [extra: string]: unknown;
}

/** Maps a GenerateRequest to the gateway body. Assumes `validateRequest` passed. */
export function buildVideoBody(cap: CatalogModel, req: GenerateRequest, moderation: 'auto' | 'low'): VideoCreateBody {
  const body: VideoCreateBody = { ...req.extra, model: cap.providerModelId, moderation };
  // Swap models take no prompt; send it only where the listing accepts one.
  if (cap.acceptedParams.includes('prompt')) body.prompt = req.prompt;
  if (req.seconds !== undefined) body.seconds = req.seconds;
  if (req.resolution !== undefined) body.resolution = req.resolution;
  // Frame-driven generation takes its aspect ratio from the frame: Seedance (and others) refuse
  // `ratio` together with first/last frames. Our keyframes are generated at the shot's ratio.
  const frameDriven = req.firstFrameUrl !== undefined || req.lastFrameUrl !== undefined;
  if (req.ratio !== undefined && !frameDriven) body.ratio = req.ratio;
  // Several models make sound by default at the vendor; the gateway sends it only when asked.
  if (req.audio !== undefined && cap.audio) body.audio = req.audio;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.negativePrompt !== undefined) body.negative_prompt = req.negativePrompt;
  if (req.firstFrameUrl !== undefined) {
    // Image-to-video-only listings (no `first_frame` param, `input_image_required`) take the
    // start picture as `input_reference` (their `request_example`); `first_frame` is refused.
    if (!cap.acceptedParams.includes('first_frame') && (cap.inputImageRequired || cap.acceptedParams.includes('input_reference'))) {
      body.input_reference = { image_url: req.firstFrameUrl };
    } else body.first_frame = req.firstFrameUrl;
  }
  if (req.lastFrameUrl !== undefined) body.last_frame = req.lastFrameUrl;
  if (req.referenceImageUrls?.length) body.reference_images = req.referenceImageUrls;
  if (req.referenceVideoUrls?.length) body.reference_videos = req.referenceVideoUrls;
  if (req.referenceAudioUrls?.length) body.reference_audios = req.referenceAudioUrls;
  if (req.audioUrl !== undefined) body.audio_url = req.audioUrl;
  if (req.fallbackModelIds?.length) body.models = req.fallbackModelIds;
  return body;
}

/** `POST /v1/videos` — always async; answers the Video object in `queued`. */
export async function createVideo(
  client: HyperouterClient,
  body: VideoCreateBody,
  idempotencyKey: string,
): Promise<HyperouterVideo> {
  const { data } = await client.json<HyperouterVideo>(HYPEROUTER_PATHS.videos, { method: 'POST', body, idempotencyKey });
  return data;
}

export async function getVideo(client: HyperouterClient, id: string): Promise<HyperouterVideo> {
  const { data } = await client.json<HyperouterVideo>(HYPEROUTER_PATHS.video(id));
  return data;
}

/**
 * `GET /v1/videos/{id}/content` answers `302` to a signed link (15 minutes).
 * Returns that link without downloading the bytes, or null while the content
 * is not ready (404).
 */
export async function getVideoContentUrl(
  client: HyperouterClient,
  id: string,
  variant: 'video' | 'thumbnail' = 'video',
): Promise<{ url: string; expiresAt: number } | null> {
  const res = await client.raw(HYPEROUTER_PATHS.videoContent(id, variant), { redirect: 'manual' });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    return { url: new URL(location, client.baseUrl).toString(), expiresAt: client.now() + HYPEROUTER_DEFAULTS.videoContentUrlTtlMs };
  }
  // A client that followed the redirect anyway: the final URL is the signed link.
  if (res.ok && res.url && !res.url.startsWith(client.baseUrl)) {
    await res.body?.cancel();
    return { url: res.url, expiresAt: client.now() + HYPEROUTER_DEFAULTS.videoContentUrlTtlMs };
  }
  throw await errorFromResponse(res, client.now());
}

const VIDEO_STATE: Record<HyperouterVideo['status'], JobState> = {
  queued: 'queued',
  in_progress: 'running',
  completed: 'succeeded',
  failed: 'failed',
};

/** Normalizes a Video object. Outputs are attached separately (content URLs). */
export function videoToJobStatus(video: HyperouterVideo, outputs: JobOutput[] = []): JobStatus {
  const state = VIDEO_STATE[video.status] ?? 'running';
  const progress = state === 'succeeded' ? 100 : Math.max(0, Math.min(100, Math.round(video.progress ?? 0)));
  return {
    externalId: video.id,
    state,
    progress,
    outputs: state === 'succeeded' ? outputs : [],
    costUsd: video.usage?.cost ?? null,
    error: state === 'failed' ? jobErrorFrom(video.error) : null,
    providerStatus: video.status,
  };
}
