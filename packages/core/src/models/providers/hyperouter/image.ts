import type { GenerateRequest, JobState, JobStatus, CatalogModel } from '../../types';
import type { HyperouterClient } from './client';
import { HYPEROUTER_PATHS } from './config';
import { jobErrorFrom, toEpochMs } from './job-errors';

/** `GET /v1/generations/{id}` record. */
export interface HyperouterGeneration {
  id: string;
  kind: 'chat' | 'image' | 'video';
  model?: string;
  status: 'queued' | 'submitting' | 'running' | 'done' | 'failed';
  created_at?: string | null;
  finished_at?: string | null;
  usage?: { cost?: number | null; image?: number; video_seconds?: number } | null;
  latency_ms?: number | null;
  error?: { code?: string | null; message?: string | null } | null;
  outputs?: { url: string; expires_at?: string | number | null }[];
}

/** Image create answer: `202 {id, status}` under `Prefer: respond-async`, else `200` with images. */
export interface HyperouterImageCreateResponse {
  id: string;
  status?: string;
  created?: number;
  data?: { url: string }[];
  usage?: { cost?: number | null } | null;
}

export interface ImageCreateBody {
  model: string;
  prompt?: string;
  n?: number;
  size?: string;
  seed?: number;
  negative_prompt?: string;
  prompt_extend?: boolean;
  ratio?: string;
  resolution?: string;
  images?: { image_url: string }[];
  models?: string[];
  moderation: 'auto' | 'low';
  [extra: string]: unknown;
}

/** Maps a GenerateRequest to the gateway body. Assumes `validateRequest` passed. */
export function buildImageBody(cap: CatalogModel, req: GenerateRequest, moderation: 'auto' | 'low'): ImageCreateBody {
  const body: ImageCreateBody = { ...req.extra, model: cap.providerModelId, moderation };
  const promptless = req.mode === 'face_swap' || req.mode === 'head_swap';
  if (!promptless) body.prompt = req.prompt;
  if (req.n !== undefined) body.n = req.n;
  if (req.size !== undefined) body.size = req.size;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.negativePrompt !== undefined) body.negative_prompt = req.negativePrompt;
  if (req.ratio !== undefined) body.ratio = req.ratio;
  if (req.resolution !== undefined && cap.resolutions.length > 0) body.resolution = req.resolution;
  if (req.inputImageUrls?.length) body.images = req.inputImageUrls.map((url) => ({ image_url: url }));
  if (req.fallbackModelIds?.length) body.models = req.fallbackModelIds;
  return body;
}

/** True when the body goes to `/v1/images/edits`. */
export function isImageEdit(body: ImageCreateBody): boolean {
  return Array.isArray(body.images) && body.images.length > 0;
}

/**
 * Starts an image job with `Prefer: respond-async`. Returns the generation id;
 * when the gateway still answered synchronously (200), the finished status too.
 */
export async function createImage(
  client: HyperouterClient,
  body: ImageCreateBody,
  idempotencyKey: string,
): Promise<{ id: string; immediate: JobStatus | null }> {
  const path = isImageEdit(body) ? HYPEROUTER_PATHS.imageEdits : HYPEROUTER_PATHS.imageGenerations;
  const { data, response } = await client.json<HyperouterImageCreateResponse>(path, {
    method: 'POST',
    body,
    idempotencyKey,
    headers: { prefer: 'respond-async' },
  });
  if (response.status === 200 && Array.isArray(data.data)) {
    return {
      id: data.id,
      immediate: {
        externalId: data.id,
        state: 'succeeded',
        progress: 100,
        outputs: data.data.map((d) => ({ kind: 'image' as const, url: d.url, expiresAt: client.now() + 24 * 3600 * 1000 })),
        costUsd: data.usage?.cost ?? null,
        error: null,
        providerStatus: 'done',
      },
    };
  }
  return { id: data.id, immediate: null };
}

export async function getGeneration(client: HyperouterClient, id: string): Promise<HyperouterGeneration> {
  const { data } = await client.json<{ data: HyperouterGeneration }>(HYPEROUTER_PATHS.generation(id));
  return data.data;
}

const GENERATION_STATE: Record<HyperouterGeneration['status'], JobState> = {
  queued: 'queued',
  submitting: 'queued',
  running: 'running',
  done: 'succeeded',
  failed: 'failed',
};

/** Normalizes a generation record. The gateway reports no image progress, so it is coarse. */
export function generationToJobStatus(gen: HyperouterGeneration): JobStatus {
  const state = GENERATION_STATE[gen.status] ?? 'running';
  const outputKind = gen.kind === 'video' ? 'video' : 'image';
  return {
    externalId: gen.id,
    state,
    progress: state === 'succeeded' ? 100 : state === 'running' ? 50 : 0,
    outputs:
      state === 'succeeded'
        ? (gen.outputs ?? []).map((o) => {
            const expiresAt = toEpochMs(o.expires_at);
            return expiresAt === undefined
              ? { kind: outputKind, url: o.url }
              : { kind: outputKind, url: o.url, expiresAt };
          })
        : [],
    costUsd: gen.usage?.cost ?? null,
    error: state === 'failed' ? jobErrorFrom(gen.error) : null,
    providerStatus: gen.status,
  };
}
