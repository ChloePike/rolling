import type { JobError } from '../../types';

/**
 * Job failure codes that a new submission (same or fallback model) may fix.
 * Everything else (content/vendor rejections, invalid input) fails for good.
 */
const RETRYABLE_JOB_CODES = new Set([
  'upstream_error',
  'provider_busy',
  'all_venues_failed',
  'timeout',
  'internal',
  'server_error',
  'no_price',
  'venue_busy',
  'rate_limited',
  'network_error',
]);

/**
 * Normalizes a failed job's `{ code, message }`. Hyperouter never bills a failed
 * image or video job, so every failure is refundable: the hold is released.
 */
export function jobErrorFrom(error: { code?: string | null; message?: string | null } | null | undefined): JobError {
  const code = error?.code || 'unknown_error';
  return {
    code,
    message: error?.message || 'The job failed.',
    retryable: RETRYABLE_JOB_CODES.has(code),
    refundable: true,
  };
}

/** Converts `expires_at` (unix seconds, unix ms or RFC 3339) to ms since epoch. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return toEpochMs(n);
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}
