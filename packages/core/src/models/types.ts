/**
 * Provider-neutral model gateway types. The rest of the app talks to these
 * interfaces only; provider-specific code lives in `./providers/*`.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type GenerationKind = 'video' | 'image' | 'avatar' | 'speech';

/** Video modes: text, first frame, first + last frame, reference media, extend a finished clip. */
export type VideoMode = 't2v' | 'i2v' | 'first_last_frame' | 'refs' | 'extend';
/** Image modes: text to image, edit / reference images. */
export type ImageMode = 't2i' | 'edit';
/** Special-purpose modes (identity swaps, motion transfer, lip sync). */
export type SpecialMode = 'face_swap' | 'head_swap' | 'motion_transfer' | 'lip_sync';
export type GenerationMode = VideoMode | ImageMode | SpecialMode;

/** Where a capabilities entry stands relative to the PRD launch list (D-002). */
export type ModelStatus =
  /** PRD launch model, available on the gateway. */
  | 'launch'
  /** Stands in for a PRD model that the gateway does not list (`substituteFor`). Needs product confirmation. */
  | 'substitute'
  /** Listed on the gateway, not part of the launch set; tracked for evaluation only. */
  | 'candidate';

export interface PriceBasis {
  /** `per_second` of output video or `per_image`. */
  unit: 'per_second' | 'per_image';
  /** USD per unit, keyed by resolution (`'default'` when the price does not depend on it). */
  usd: Record<string, number>;
  /** Where the number came from, e.g. `GET /v1/models 2026-11-25`. */
  source: string;
}

export interface ModelCapabilities {
  /** Our stable key, e.g. `seedance-2.5`. Used in graphs, quotes and the ledger. */
  key: string;
  /** Display name. */
  label: string;
  kind: GenerationKind;
  provider: 'hyperouter';
  /** Model id at the provider, e.g. `bytedance/seedance-2.5`. */
  providerModelId: string;
  status: ModelStatus;
  /** PRD model this entry substitutes for (D-002), e.g. `wan-2.2`. */
  substituteFor?: string;
  /** Key into `pricing/config.ts` CREDIT_PRICES. Absent = not sellable yet. */
  creditKey?: string;
  modes: GenerationMode[];
  /** Video length bounds in whole seconds, or a fixed list of allowed values. */
  seconds?: { min: number; max: number; allowed?: number[] };
  /** Allowed `resolution` values; first is the provider default. Empty = model picks / uses `size`. */
  resolutions: string[];
  /** Allowed `ratio` values. Empty = not supported. */
  ratios: string[];
  /** Model can make sound. */
  audio: boolean;
  /** Lip sync to an uploaded audio track. */
  lipSync?: boolean;
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
  /** Image models: input pictures accepted by edits. */
  maxInputImages?: number;
  /** Images per request. */
  maxImagesPerRequest?: number;
  /** Optional shared parameters the gateway accepts for this model (others are refused with 400). */
  params: { seed: boolean; negativePrompt: boolean; promptExtend: boolean; size: boolean };
  /**
   * D-005: only models with `mature: true` may receive mature runs, and only those
   * runs send `moderation: "low"`. Default false until confirmed with the provider.
   */
  mature: boolean;
  /** Why `mature` has its value (evidence or what is pending). */
  matureNote?: string;
  /**
   * Model operates on a real person's face or likeness (face/head swap, photo-driven
   * avatars). Such models must pass the identity safety checks in `core/safety`
   * and can never be routed for mature runs, whatever `mature` says.
   */
  requiresIdentitySafety?: boolean;
  /** Pricing basis in USD at the gateway. */
  price: PriceBasis;
  /** Considered by `pickAuto`. */
  autoEligible: boolean;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  kind: 'image' | 'video';
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  /** Video length in whole seconds. */
  seconds?: number;
  resolution?: string;
  ratio?: string;
  /** `WIDTHxHEIGHT`, image models only. */
  size?: string;
  audio?: boolean;
  /** Images per request. */
  n?: number;
  /** i2v / first_last_frame. */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  /** refs mode (video) — https URLs. */
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  /** Image edits: the pictures to edit (https URLs). */
  inputImageUrls?: string[];
  /** Lip sync audio track (https URL). */
  audioUrl?: string;
  /** Mature run (D-005). Routed only to `mature: true` models. */
  mature?: boolean;
  /** Fallback provider model ids tried by the gateway, in order. */
  fallbackModelIds?: string[];
  /** Model-specific fields passed through as-is. */
  extra?: Record<string, unknown>;
}

/** Normalized job state across providers. */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobOutput {
  kind: 'image' | 'video' | 'thumbnail';
  url: string;
  /** ms since epoch when the signed URL stops working, when known. */
  expiresAt?: number;
}

export interface JobError {
  /** Provider error code, e.g. `content_rejected`. */
  code: string;
  message: string;
  /** Submitting again (same or next model) can succeed. */
  retryable: boolean;
  /** The hold must be released: the provider did not bill this job. */
  refundable: boolean;
}

export interface JobStatus {
  externalId: string;
  state: JobState;
  /** 0–100. */
  progress: number;
  outputs: JobOutput[];
  /** Provider charge in USD once settled; null while unknown. */
  costUsd: number | null;
  error: JobError | null;
  /** Raw provider status, for logs. */
  providerStatus?: string;
}

export interface WebhookResult {
  /** Delivery id (`webhook-id`); dedupe on it. */
  eventId: string;
  eventType: string;
  externalId: string;
  /** Null for events that are not about a job (e.g. `webhook.test`). */
  status: JobStatus | null;
}

export interface GenerationProvider {
  /** Our model key, e.g. `seedance-2.5`. */
  id: string;
  kind: GenerationKind;
  capabilities: ModelCapabilities;
  /** Starts a job. `idempotencyKey` is required (our job id). */
  submit(req: GenerateRequest, idempotencyKey: string): Promise<{ externalId: string }>;
  status(externalId: string): Promise<JobStatus>;
  /** Verifies a provider webhook and returns the job status; throws on a bad signature. */
  verifyWebhook?(req: Request): Promise<WebhookResult | null>;
}

// ---------------------------------------------------------------------------
// Chat (LLM)
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string as produced by the model. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  /** Provider model id; defaults to the agent model. */
  model?: string;
  fallbackModels?: string[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  parallelToolCalls?: boolean;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; name: string; schema: Record<string, unknown> };
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  mature?: boolean;
  /** Required: chat calls are paid. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number | null;
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /** Raw fragment, for live UI. Complete calls arrive as `tool_call`. */
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: ChatUsage; provider?: string }
  | { type: 'error'; error: { code: string; message: string; retryable: boolean } }
  | { type: 'done'; id: string | null; finishReason: string | null };

export interface LlmProvider {
  id: string;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}
