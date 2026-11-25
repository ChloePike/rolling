import { getCapabilities, moderationFor, validateRequest } from '../../capabilities';
import { InvalidGenerateRequestError } from '../../errors';
import type { GenerateRequest, GenerationProvider, JobOutput, JobStatus, ModelCapabilities, WebhookResult } from '../../types';
import { HyperouterClient } from './client';
import type { HyperouterConfig } from './config';
import { buildImageBody, createImage, generationToJobStatus, getGeneration } from './image';
import { buildVideoBody, createVideo, getVideo, getVideoContentUrl, videoToJobStatus } from './video';
import { verifyWebhookRequest } from './webhooks';

function requireKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new TypeError('An idempotency key is required for every paid create.');
  }
}

function prepare(cap: ModelCapabilities, req: GenerateRequest): 'auto' | 'low' {
  const problems = validateRequest(cap, req);
  if (problems.length) throw new InvalidGenerateRequestError(cap.key, problems);
  return moderationFor(cap, req.mature);
}

/** Image models (`/v1/images/*` with `Prefer: respond-async`, polled via `/v1/generations/{id}`). */
export class HyperouterImageProvider implements GenerationProvider {
  readonly id: string;
  readonly kind = 'image' as const;
  /** Finished statuses from synchronous answers, served by `status()` without a request. */
  private readonly immediate = new Map<string, JobStatus>();

  constructor(
    readonly capabilities: ModelCapabilities,
    private readonly client: HyperouterClient,
    private readonly webhookSecret?: string,
  ) {
    this.id = capabilities.key;
  }

  async submit(req: GenerateRequest, idempotencyKey: string): Promise<{ externalId: string }> {
    requireKey(idempotencyKey);
    const moderation = prepare(this.capabilities, req);
    const { id, immediate } = await createImage(this.client, buildImageBody(this.capabilities, req, moderation), idempotencyKey);
    if (immediate) this.immediate.set(id, immediate);
    return { externalId: id };
  }

  async status(externalId: string): Promise<JobStatus> {
    const cached = this.immediate.get(externalId);
    if (cached) return cached;
    return generationToJobStatus(await getGeneration(this.client, externalId));
  }

  async verifyWebhook(req: Request): Promise<WebhookResult | null> {
    return handleHyperouterWebhook(req, this.client, this.webhookSecret);
  }
}

/** Video models (`POST /v1/videos`, polled via `GET /v1/videos/{id}`, content via `/content` redirect). */
export class HyperouterVideoProvider implements GenerationProvider {
  readonly id: string;
  readonly kind: 'video' | 'avatar';

  constructor(
    readonly capabilities: ModelCapabilities,
    private readonly client: HyperouterClient,
    private readonly webhookSecret?: string,
  ) {
    this.id = capabilities.key;
    this.kind = capabilities.kind === 'avatar' ? 'avatar' : 'video';
  }

  async submit(req: GenerateRequest, idempotencyKey: string): Promise<{ externalId: string }> {
    requireKey(idempotencyKey);
    const moderation = prepare(this.capabilities, req);
    const video = await createVideo(this.client, buildVideoBody(this.capabilities, req, moderation), idempotencyKey);
    return { externalId: video.id };
  }

  async status(externalId: string): Promise<JobStatus> {
    return videoJobStatus(this.client, externalId);
  }

  async verifyWebhook(req: Request): Promise<WebhookResult | null> {
    return handleHyperouterWebhook(req, this.client, this.webhookSecret);
  }
}

/** Video status including signed content and thumbnail URLs once completed. */
export async function videoJobStatus(client: HyperouterClient, externalId: string): Promise<JobStatus> {
  const video = await getVideo(client, externalId);
  if (video.status !== 'completed') return videoToJobStatus(video);
  const outputs: JobOutput[] = [];
  const content = await getVideoContentUrl(client, externalId, 'video');
  if (!content) {
    // Completed but content not served yet: report running so the caller polls again.
    return { ...videoToJobStatus(video), state: 'running', progress: 99, outputs: [] };
  }
  outputs.push({ kind: 'video', url: content.url, expiresAt: content.expiresAt });
  const thumb = await getVideoContentUrl(client, externalId, 'thumbnail').catch(() => null);
  if (thumb) outputs.push({ kind: 'thumbnail', url: thumb.url, expiresAt: thumb.expiresAt });
  return videoToJobStatus(video, outputs);
}

/**
 * Verifies a Hyperouter webhook (Standard Webhooks) and fetches the object it
 * names (the payload carries only `data.id`). Throws WebhookVerificationError
 * on a bad signature. Dedupe on `eventId` (`webhook-id`) before acting.
 */
export async function handleHyperouterWebhook(
  req: Request,
  client: HyperouterClient,
  secret: string | undefined,
  opts: { now?: number } = {},
): Promise<WebhookResult | null> {
  if (!secret) throw new Error('Hyperouter webhook secret is not configured.');
  const { webhookId, event } = await verifyWebhookRequest(req, secret, opts);
  const externalId = event.data.id;
  let status: JobStatus | null = null;
  if (event.type.startsWith('video.')) status = await videoJobStatus(client, externalId);
  else if (event.type.startsWith('image.')) status = generationToJobStatus(await getGeneration(client, externalId));
  return { eventId: webhookId, eventType: event.type, externalId, status };
}

/** Builds the provider for a capabilities key, e.g. `seedance-2.0-mini`. */
export function createHyperouterGenerationProvider(
  modelKey: string,
  config: HyperouterConfig | HyperouterClient,
  webhookSecret?: string,
): GenerationProvider {
  const cap = getCapabilities(modelKey);
  if (!cap) throw new Error(`Unknown model key: ${modelKey}`);
  const client = config instanceof HyperouterClient ? config : new HyperouterClient(config);
  const secret = webhookSecret ?? (config instanceof HyperouterClient ? undefined : config.webhookSecret);
  return cap.kind === 'image'
    ? new HyperouterImageProvider(cap, client, secret)
    : new HyperouterVideoProvider(cap, client, secret);
}
