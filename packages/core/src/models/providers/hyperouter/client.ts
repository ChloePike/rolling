import { HYPEROUTER_BASE_URL, HYPEROUTER_DEFAULTS, type HyperouterConfig } from './config';

/** Hyperouter error body: `{ error: { message, type, code, param, generation_id? } }`. */
export interface HyperouterErrorBody {
  message?: string;
  type?: string;
  code?: string | null;
  param?: string | null;
  generation_id?: string;
}

/** Codes that a repeat cannot fix. */
const NEVER_RETRY_CODES = new Set([
  'insufficient_credits',
  'invalid_api_key',
  'account_suspended',
  'content_rejected',
  'vendor_rejected',
  'unknown_model',
  'unsupported_parameter',
  'invalid_body',
  'invalid_combination',
  'invalid_size',
  'invalid_seconds',
  'idempotency_key_reused',
  'idempotency_key_replayed',
  'moderation_not_enabled',
  'model_not_enabled',
  'feature_not_enabled',
]);

export class HyperouterError extends Error {
  override readonly name = 'HyperouterError';
  /** HTTP status; 0 for network failures. */
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;
  /** Sending the same request again (same idempotency key) may succeed. */
  readonly retryable: boolean;
  /** Wait at least this long before retrying (from Retry-After), when known. */
  readonly retryAfterMs: number | null;
  /** Value of the `x-should-retry` response header, when present. */
  readonly shouldRetryHeader: boolean | null;
  /** `X-Upstream-Status` (502 or 504) on 503 answers. */
  readonly upstreamStatus: number | null;
  /** `error.generation_id`: the job that exists despite the error (sync image timeout, chat replay). */
  readonly generationId: string | null;

  constructor(init: {
    status: number;
    type: string;
    code: string;
    message: string;
    param?: string | null;
    retryable: boolean;
    retryAfterMs?: number | null;
    shouldRetryHeader?: boolean | null;
    upstreamStatus?: number | null;
    generationId?: string | null;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param ?? null;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.shouldRetryHeader = init.shouldRetryHeader ?? null;
    this.upstreamStatus = init.upstreamStatus ?? null;
    this.generationId = init.generationId ?? null;
  }

  get isInsufficientCredits(): boolean {
    return this.code === 'insufficient_credits';
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isContentRejected(): boolean {
    return this.code === 'content_rejected' || this.code === 'vendor_rejected';
  }
}

/** Parses `Retry-After` (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value == null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function parseShouldRetry(value: string | null): boolean | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  return null;
}

/**
 * Decides whether a failed request may be repeated with the same idempotency key.
 * `x-should-retry` wins when present: Hyperouter sends `false` wherever a repeat
 * would start a second job or charge.
 */
export function isRetryable(status: number, code: string, shouldRetryHeader: boolean | null): boolean {
  if (shouldRetryHeader !== null) return shouldRetryHeader;
  if (code === 'idempotency_key_in_use') return true;
  if (NEVER_RETRY_CODES.has(code)) return false;
  if (status === 0 || status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/** Builds a typed error from a non-2xx response. Consumes the body. */
export async function errorFromResponse(res: Response, now: number = Date.now()): Promise<HyperouterError> {
  let body: HyperouterErrorBody = {};
  let rawText = '';
  try {
    rawText = await res.text();
    const parsed = JSON.parse(rawText) as { error?: HyperouterErrorBody };
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') body = parsed.error;
  } catch {
    // Not JSON (edge error page): keep defaults.
  }
  const shouldRetryHeader = parseShouldRetry(res.headers.get('x-should-retry'));
  const code = body.code ?? defaultCodeForStatus(res.status);
  let retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now);
  if (res.status === 429 && retryAfterMs === null) retryAfterMs = HYPEROUTER_DEFAULTS.defaultRetryAfterMs;
  const upstream = Number(res.headers.get('x-upstream-status'));
  return new HyperouterError({
    status: res.status,
    type: body.type ?? 'unknown_error',
    code,
    message: body.message ?? (rawText.slice(0, 200) || `HTTP ${res.status}`),
    param: body.param ?? null,
    retryable: isRetryable(res.status, code, shouldRetryHeader),
    retryAfterMs,
    shouldRetryHeader,
    upstreamStatus: Number.isFinite(upstream) && upstream > 0 ? upstream : null,
    generationId: body.generation_id ?? null,
  });
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'invalid_api_key';
    case 402:
      return 'insufficient_credits';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    case 503:
      return 'upstream_error';
    default:
      return status >= 500 ? 'server_error' : 'http_error';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Required on every paid create. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** `manual` to read a 302 Location (video content). */
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{1,255}$/;

/** Thin fetch wrapper: auth, JSON, idempotency header and error mapping. Fetch only, runs on Workers. */
export class HyperouterClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  readonly now: () => number;

  constructor(config: HyperouterConfig) {
    this.baseUrl = (config.baseUrl ?? HYPEROUTER_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    // Bind so Workers' fetch keeps its `this`.
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.now = config.now ?? (() => Date.now());
  }

  /** Sends a request and returns the raw response (any status). Network failures become HyperouterError(status 0). */
  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY_RE.test(opts.idempotencyKey)) {
        throw new HyperouterError({
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key must be 1 to 255 printable ASCII characters.',
          retryable: false,
        });
      }
      headers['idempotency-key'] = opts.idempotencyKey;
    }
    const init: RequestInit = { method: opts.method ?? (body ? 'POST' : 'GET'), headers };
    if (body !== undefined) init.body = body;
    if (opts.redirect) init.redirect = opts.redirect;
    if (opts.signal) init.signal = opts.signal;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new HyperouterError({
        status: 0,
        type: 'network_error',
        code: 'network_error',
        message: cause instanceof Error ? cause.message : 'Network request failed.',
        // Safe only because paid creates carry an idempotency key.
        retryable: true,
        cause,
      });
    }
  }

  /** Sends a request and parses a 2xx JSON body; throws HyperouterError otherwise. */
  async json<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const res = await this.raw(path, opts);
    if (!res.ok) throw await errorFromResponse(res, this.now());
    const data = (await res.json()) as T;
    return { data, response: res };
  }
}

/**
 * Why a create with `prompt_expand` was refused, when the expansion is the cause (D-020):
 * - `feature_off`: `403 feature_not_enabled` (the account does not have it; nothing held or sent);
 * - `refused`: `422 expansion_refused` / `400 prompt_rejected` (the rewrite was refused; not billed, nothing rendered);
 * - `writer`: the writer named in `prompt_expand_model` is unknown or not callable (before anything is held).
 * Null for every other error.
 */
export type ExpansionFailure = 'feature_off' | 'refused' | 'writer';

export function expansionFailureOf(err: unknown): ExpansionFailure | null {
  if (!(err instanceof HyperouterError)) return null;
  if (err.code === 'feature_not_enabled') return 'feature_off';
  if (err.code === 'expansion_refused' || err.code === 'prompt_rejected') return 'refused';
  if ((err.code === 'model_not_enabled' || err.code === 'unknown_model') && err.param === 'prompt_expand_model') return 'writer';
  return null;
}
