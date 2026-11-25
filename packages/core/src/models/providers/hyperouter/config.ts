/**
 * Hyperouter gateway configuration (D-002). Endpoints, model ids and defaults
 * confirmed against https://hyperouter.app/llms-full.txt and `GET /v1/models`
 * on 2026-11-25.
 */

export const HYPEROUTER_BASE_URL = 'https://api.hyperouter.app';
export const HYPEROUTER_API_VERSION = '/v1';

export const HYPEROUTER_PATHS = {
  models: '/v1/models',
  chatCompletions: '/v1/chat/completions',
  imageGenerations: '/v1/images/generations',
  imageEdits: '/v1/images/edits',
  generation: (id: string) => `/v1/generations/${encodeURIComponent(id)}`,
  videos: '/v1/videos',
  video: (id: string) => `/v1/videos/${encodeURIComponent(id)}`,
  videoContent: (id: string, variant: 'video' | 'thumbnail') =>
    `/v1/videos/${encodeURIComponent(id)}/content?variant=${variant}`,
} as const;

/** Provider model ids referenced in code. The available set comes from the live listing (`../../catalog.ts`). */
export const HYPEROUTER_MODEL_IDS = {
  chat: {
    agent: 'deepseek/deepseek-v4.1-flash',
  },
  image: {
    seedream55: 'bytedance/seedream-5.5',
    seedream50Lite: 'bytedance/seedream-5.0-lite',
    seedream50Flash: 'bytedance/seedream-5.0-flash',
    qwenImage20: 'qwen/qwen-image-2.0',
    zImageSpicy: 'lumina/z-image-spicy',
    zImageSpicyPro: 'lumina/z-image-spicy-pro',
    qwenImageEditSpicy: 'lumina/qwen-image-edit-spicy',
    faceSwap: 'lumina/face-swap',
    headSwap: 'lumina/head-swap',
  },
  video: {
    seedance25: 'bytedance/seedance-2.5',
    seedance25Flash: 'bytedance/seedance-2.5-flash',
    seedance20Mini: 'bytedance/seedance-2.0-mini',
    seedance20Fast: 'bytedance/seedance-2.0-fast',
    minimaxH3: 'minimax/minimax-h3',
    wan30: 'alibaba/wan3.0',
    wan30Turbo: 'alibaba/wan3.0-turbo',
    wan22I2vSpicy: 'lumina/wan2.2-i2v-spicy',
    wan27I2vSpicy: 'lumina/wan2.7-i2v-spicy',
    wanAnimate: 'lumina/wan-animate',
    videoFaceSwap: 'lumina/video-face-swap',
    videoHeadSwap: 'lumina/video-head-swap',
  },
} as const;

export const HYPEROUTER_DEFAULTS = {
  /** Idempotency window at the gateway. A retry after this starts a new job. */
  idempotencyWindowMs: 30 * 60 * 1000,
  /** Signed video content links from `/content` live 15 minutes. */
  videoContentUrlTtlMs: 15 * 60 * 1000,
  /** Standard Webhooks timestamp tolerance. */
  webhookToleranceSec: 5 * 60,
  /** Fallback when a 429 carries no Retry-After. */
  defaultRetryAfterMs: 5_000,
  /** Fallback models list limit for `models`. */
  maxFallbackModels: 5,
} as const;

export interface HyperouterConfig {
  /** `sk-hr-v1-...` (Worker secret `HYPEROUTER_API_KEY`). */
  apiKey: string;
  baseUrl?: string;
  /** Webhook signing secret `whsec_...`. Needed for `verifyWebhook`. */
  webhookSecret?: string;
  /** Injected fetch (tests, tracing). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Clock for tests (ms since epoch). */
  now?: () => number;
}
