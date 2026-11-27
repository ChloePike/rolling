/**
 * Provider-neutral model gateway types. The rest of the app talks to these
 * interfaces only; provider-specific code lives in `./providers/*`.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type GenerationKind = 'video' | 'image' | 'avatar' | 'speech';

/**
 * Where an input picture came from. Platform assets (D-005) are `generated`
 * (made on Rolling), `character` (a saved Character) and `public` (public library).
 */
export type ImageSource = 'generated' | 'character' | 'public' | 'upload' | 'mine' | 'team' | 'builtin';
export const PLATFORM_IMAGE_SOURCES: readonly ImageSource[] = ['generated', 'character', 'public'];

/** Video modes: text, first frame, first + last frame, reference media, extend a finished clip. */
export type VideoMode = 't2v' | 'i2v' | 'first_last_frame' | 'refs' | 'extend';
/** Image modes: text to image, edit / reference images. */
export type ImageMode = 't2i' | 'edit';
/** Special-purpose modes (identity swaps, motion transfer, lip sync). */
export type SpecialMode = 'face_swap' | 'head_swap' | 'motion_transfer' | 'lip_sync';
export type GenerationMode = VideoMode | ImageMode | SpecialMode;

/** Catalog kinds as the gateway listing reports them. */
export type CatalogKind = 'image' | 'video' | 'chat';

/**
 * One price line from the listing (`prices[]`): USD per unit of `meter`,
 * applying when every entry of `conditions` matches the request. The most
 * specific matching line (most conditions) wins for a meter.
 */
export interface PriceRule {
  /** e.g. `video_second`, `image`, `input_image`, `input_video_ms`, `prompt`. */
  meter: string;
  /** e.g. `{ resolution: '720p', video_input: true }`, `{ min_pixels: 2601124 }`, `{ input_images: 2 }`. */
  conditions: Record<string, string | number | boolean>;
  usd: number;
  minUnits: number;
  unitStep: number;
}

/**
 * D-005 routing class for mature runs:
 * - `never`: mature runs are refused (normal models, face/head swap).
 * - `platform_assets_only`: identity-driven model in the mature family; a mature
 *   run is allowed only when every input image is a platform asset.
 * - `allowed`: mature runs go here with `moderation: "low"`.
 */
export type MatureRouting = 'never' | 'platform_assets_only' | 'allowed';

/**
 * Technical facts about a model, derived from one `GET /v1/models` entry
 * (`./catalog.ts`). Nothing here is hand-maintained: the listing wins.
 */
export interface ListingModel {
  /** Gateway model id, e.g. `bytedance/seedance-2.5`. Our stable key everywhere (graphs, quotes, ledger). */
  id: string;
  /** Listing `name`. */
  name: string;
  kind: CatalogKind;
  /** What the model can do, derived from its parameter schema. */
  operations: GenerationMode[];
  /** Listing operations we could not map to a GenerationMode (e.g. video `edit`). */
  unmappedOperations: string[];
  /** Video length in whole seconds, or a fixed list of allowed values. Absent = set by an input clip. */
  seconds?: { min: number; max: number; allowed?: number[] };
  defaultSeconds?: number;
  /** Allowed `resolution` values in listing order. Empty = model picks / uses `size`. */
  resolutions: string[];
  defaultResolution?: string;
  /** Default `size` (`WxH`) when the listing states one. */
  defaultSize?: string;
  /** Allowed `ratio` values. Empty = not supported. */
  ratios: string[];
  /** Model can make sound (`audio` parameter). */
  audio: boolean;
  /** Lip sync to an uploaded audio track (`audio_url`). */
  lipSync: boolean;
  /** Video reference limits (0 = not accepted). */
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  /** Image models: input pictures accepted by edits. */
  minInputImages: number;
  maxInputImages: number;
  /** Needs an input picture (photo-driven i2v). */
  inputImageRequired: boolean;
  /** Images per request (`n` maximum). */
  maxImagesPerRequest: number;
  /** Shared optional parameters we map from GenerateRequest. */
  /**
   * `promptExtend`: the vendor's own rewrite (`prompt_extend`, never sent). `promptExpand`: Hyperouter's
   * rewrite before the render (`prompt_expand`; the listing names it only once the account has it).
   */
  params: { seed: boolean; negativePrompt: boolean; promptExtend: boolean; promptExpand: boolean; size: boolean };
  /** Every parameter name the gateway accepts for this model (schema, supported and extra). */
  acceptedParams: string[];
  /** Parameters the schema marks required. */
  requiredParams: string[];
  /** Mutually exclusive parameter groups (`param_schema.exclusive`). */
  exclusive: string[][][];
  /** Parameter dependencies (`param_schema.needs`): key needs one of the values. */
  needs: Record<string, string[]>;
  /** The listing accepts a `moderation` parameter (vendor screening opt-out). */
  supportsModeration: boolean;
  responseModes: string[];
  price: PriceRule[];
  /** Listing fields or values the parser saw but could not map. For logs and the sync diff. */
  unmapped: string[];
}

export type ModelPlacement = 'featured' | 'more' | 'tool';

/** Product-only fields (`./overlay.ts`) merged over a ListingModel. */
export interface ModelProductFields {
  displayName: string;
  tags: string[];
  /** Default model for its kind (one per kind). */
  default: boolean;
  /** Not offered in the picker. */
  hidden: boolean;
  /**
   * Where general model pickers list it: `featured` (the curated main list),
   * `more` (behind "More models"), or `tool` (only in the tool that needs it:
   * swaps, motion transfer, LoRA). Lip-sync pickers list lip-sync models
   * regardless of placement.
   */
  placement: ModelPlacement;
  /** Considered by Auto selection. */
  auto: boolean;
  /**
   * D-005: may receive mature runs with `moderation: "low"` without asset checks.
   * True for the `lumina/*-spicy` family and models that accept `moderation`,
   * except identity-driven models.
   */
  mature: boolean;
  /** Adult-oriented model (the spicy family): listed only to callers allowed to see mature content. */
  matureOnly: boolean;
  /** See MatureRouting. Face/head swap is always `never`. */
  matureRouting: MatureRouting;
  /**
   * Model operates on a real person's face or likeness (face/head swap, photo-driven
   * i2v and lip sync). Must pass the identity checks in `core/safety`; never picked by Auto.
   */
  requiresIdentitySafety: boolean;
  /** PRD model this one stands in for (D-002), e.g. `wan-2.2`. */
  substituteFor?: string;
  notes?: string;
}

/** A model in the merged catalog: listing ∪ overlay. */
export interface CatalogModel extends ListingModel, ModelProductFields {
  provider: 'hyperouter';
  /** Same as `id`; kept for the provider adapter. */
  providerModelId: string;
}

/** @deprecated Use CatalogModel. */
export type ModelCapabilities = CatalogModel;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  kind: 'image' | 'video';
  mode: GenerationMode;
  prompt: string;
  /**
   * `prompt` was composed for this model from a structured shot
   * (`core/prompting`). Provider-side prompt rewriting (`prompt_expand` /
   * `prompt_extend`) must stay off for it: one rewrite, not two. When this is
   * not set the prompt is the user's own text, sent as typed.
   */
  promptComposed?: boolean;
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
  /** Mature run (D-005). Routed only to mature-routable models. */
  mature?: boolean;
  /**
   * Provenance of every input picture in the request (frames, reference images,
   * edit inputs), in any order. Required for mature runs on identity-driven models (D-005).
   */
  imageSources?: ImageSource[];
  /**
   * Gateway prompt expansion ("Enhance prompt", D-020): the gateway rewrites the
   * prompt with a chat model before the render. `model` is the writer (absent =
   * the gateway's default), `locale` the language of spoken lines (BCP 47).
   * Never sent together with the vendor's own `prompt_extend`.
   */
  promptExpand?: { model?: string; locale?: string };
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
  /** With prompt expansion: the prompt that rendered (null = nothing was expanded). Absent when not reported. */
  expandedPrompt?: string | null;
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
  /** Catalog model id, e.g. `bytedance/seedance-2.5`. */
  id: string;
  kind: GenerationKind;
  capabilities: CatalogModel;
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
