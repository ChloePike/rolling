/**
 * API errors. Every `/api` route answers failures with the envelope
 * `{ error: { code, message, data } }` (docs/api.md); the client turns it into
 * an `ApiError` with a typed `data` per code, so callers branch on `code`.
 * Codes mirror `apps/api/src/lib/errors.ts`.
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'NO_PLAN'
  | 'PLAN_REQUIRED'
  | 'RESOLUTION_LOCKED'
  | 'INSUFFICIENT_CREDITS'
  | 'QUOTE_EXPIRED'
  | 'MEMBER_LIMIT_REACHED'
  | 'CONCURRENCY_LIMIT'
  | 'SEAT_LIMIT_REACHED'
  | 'TEAM_REQUIRED'
  | 'SEATS_REQUIRED'
  | 'SEATS_IN_USE'
  | 'PAYMENT_FAILED'
  | 'AGENT_ALLOWANCE_EXHAUSTED'
  | 'HANDLE_TAKEN'
  | 'OWNER_OF_TEAM'
  | 'AVATAR_REJECTED'
  | 'SAFETY_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL'
  /** Client side: the request never got an answer (offline, DNS, CORS). */
  | 'NETWORK'
  /** Client side: an answer that is not the envelope (e.g. a proxy page). */
  | 'UNKNOWN'
  /** Client side (mock runs): the job failed and its hold was released. */
  | 'RUN_FAILED';

/** Typed `data` for the codes the UI acts on. */
export interface ApiErrorData {
  NO_PLAN: { workspaceId?: string };
  PLAN_REQUIRED: { plan?: string; currentPlan?: string | null };
  RESOLUTION_LOCKED: { resolution?: string; kind?: 'video' | 'image'; lowestPlan?: string | null };
  INSUFFICIENT_CREDITS: { needed: number; balance: number };
  TEAM_REQUIRED: { currentPlan: string | null };
  SEATS_REQUIRED: { seats: number; used: number; needed: number };
  SEATS_IN_USE: { seats: number; used: number };
  AGENT_ALLOWANCE_EXHAUSTED: { allowanceUsd: number; usedUsd: number; resetsAt: number; model: string };
  RATE_LIMITED: { retryAfter?: number };
  TOO_MANY_ATTEMPTS: { authCode?: string };
  INVALID_CODE: { authCode?: string };
  CODE_EXPIRED: { authCode?: string };
  CONCURRENCY_LIMIT: { limit: number; active: number; requested: number };
  MEMBER_LIMIT_REACHED: { limit: number; used: number; needed: number };
  VALIDATION_FAILED: { field?: string; target?: string; issues?: { path: (string | number)[]; code: string; message: string }[]; minCents?: number; maxCents?: number };
  CONFLICT: { reason?: string; state?: string; status?: string };
  FORBIDDEN: { required?: string; role?: string; email?: string };
  PAYMENT_FAILED: { seats?: number; current?: number };
  HANDLE_TAKEN: { handle?: string };
  OWNER_OF_TEAM: { workspaces?: { id: string; name: string; members: number }[] };
  AVATAR_REJECTED: { reason?: 'rating' | 'blocked'; rating?: string };
}

export type DataFor<C extends ApiErrorCode> = C extends keyof ApiErrorData ? ApiErrorData[C] : Record<string, unknown>;

const KNOWN = new Set<string>([
  'BAD_REQUEST', 'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INVALID_CODE',
  'CODE_EXPIRED', 'TOO_MANY_ATTEMPTS', 'NO_PLAN', 'PLAN_REQUIRED', 'RESOLUTION_LOCKED', 'INSUFFICIENT_CREDITS', 'QUOTE_EXPIRED', 'MEMBER_LIMIT_REACHED',
  'CONCURRENCY_LIMIT', 'SEAT_LIMIT_REACHED', 'TEAM_REQUIRED', 'SEATS_REQUIRED', 'SEATS_IN_USE', 'PAYMENT_FAILED',
  'AGENT_ALLOWANCE_EXHAUSTED', 'HANDLE_TAKEN', 'OWNER_OF_TEAM', 'AVATAR_REJECTED', 'SAFETY_UNAVAILABLE', 'NOT_IMPLEMENTED', 'INTERNAL',
]);

export class ApiError<C extends ApiErrorCode = ApiErrorCode> extends Error {
  readonly name = 'ApiError';
  constructor(
    readonly code: C,
    message: string,
    readonly status: number,
    readonly data: DataFor<C> = {} as DataFor<C>,
  ) {
    super(message || code);
  }

  /** Narrows to one code: `if (err.is('SEATS_REQUIRED')) err.data.needed`. */
  is<K extends ApiErrorCode>(code: K): this is ApiError<K> {
    return (this.code as ApiErrorCode) === code;
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** Builds the typed error from a parsed body (envelope or not) and the HTTP status. */
export function errorFromBody(status: number, body: unknown): ApiError {
  const env = (body as { error?: { code?: unknown; message?: unknown; data?: unknown } } | null)?.error;
  if (env && typeof env.code === 'string') {
    const code = (KNOWN.has(env.code) ? env.code : 'UNKNOWN') as ApiErrorCode;
    const data = env.data && typeof env.data === 'object' ? (env.data as Record<string, unknown>) : {};
    return new ApiError(code, typeof env.message === 'string' ? env.message : env.code, status, data as never);
  }
  const fallback: ApiErrorCode =
    status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL' : 'UNKNOWN';
  return new ApiError(fallback, `HTTP ${status}`, status);
}
