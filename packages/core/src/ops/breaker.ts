/**
 * Gateway circuit breaker (D-030), pure state transitions. Persisted per
 * gateway in D1 (`gateway_breaker`) so every isolate sees the same state.
 *
 * - Closed: failures (5xx, timeouts, network errors) inside `windowMs` are
 *   counted; `threshold` of them open the breaker for `openMs`.
 * - Open: calls fail fast (`GATEWAY_UNAVAILABLE`), nothing is held.
 * - When `openUntil` has passed the breaker is half-open: calls are let
 *   through; the first success closes it, a failure opens it again at once.
 *   The status probe's success also closes it.
 * Client errors (4xx such as content rejections or bad requests) never count.
 */
export interface BreakerConfig {
  threshold: number;
  windowMs: number;
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, windowMs: 60_000, openMs: 60_000 };

export interface BreakerState {
  state: 'closed' | 'open';
  failures: number;
  windowStart: number;
  openedAt: number | null;
  openUntil: number | null;
  lastError: string | null;
}

export const CLOSED: BreakerState = { state: 'closed', failures: 0, windowStart: 0, openedAt: null, openUntil: null, lastError: null };

export type BreakerPhase = 'closed' | 'open' | 'half_open';

export function phaseOf(s: BreakerState, now: number): BreakerPhase {
  if (s.state !== 'open') return 'closed';
  return s.openUntil !== null && now >= s.openUntil ? 'half_open' : 'open';
}

/** True when calls must fail fast. */
export function isOpen(s: BreakerState, now: number): boolean {
  return phaseOf(s, now) === 'open';
}

export function onSuccess(s: BreakerState): BreakerState {
  if (s.state === 'closed' && s.failures === 0) return s;
  return { ...CLOSED };
}

export function onFailure(s: BreakerState, now: number, error: string, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerState {
  const phase = phaseOf(s, now);
  if (phase === 'open') return { ...s, lastError: error };
  if (phase === 'half_open') return { state: 'open', failures: cfg.threshold, windowStart: now, openedAt: now, openUntil: now + cfg.openMs, lastError: error };
  const inWindow = s.failures > 0 && now - s.windowStart < cfg.windowMs;
  const failures = inWindow ? s.failures + 1 : 1;
  const windowStart = inWindow ? s.windowStart : now;
  if (failures >= cfg.threshold) return { state: 'open', failures, windowStart, openedAt: now, openUntil: now + cfg.openMs, lastError: error };
  return { state: 'closed', failures, windowStart, openedAt: null, openUntil: null, lastError: error };
}

/** Which gateway failures count toward the breaker: network (0), timeouts (408, 504) and 5xx. */
export function countsAsOutage(status: number): boolean {
  return status === 0 || status === 408 || status >= 500;
}

export const GATEWAY_UNAVAILABLE_MESSAGE = 'Generation is temporarily unavailable. Try again in a few minutes. No credits were charged.';
