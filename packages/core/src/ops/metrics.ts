/**
 * Product metrics helpers (D-029): Analytics Engine event shapes and the
 * dashboard arithmetic. Events never carry prompts, emails or names: only ids,
 * model ids, counts, credits and USD.
 */
import { USD_PER_CREDIT } from '../pricing/config';

/** blob1 of every product event (index1 is the same, for sampling per event). */
export const METRIC_EVENTS = ['signup', 'trial_start', 'plan_start', 'generation', 'agent_turn', 'spend', 'request', 'probe', 'breaker'] as const;
export type MetricEvent = (typeof METRIC_EVENTS)[number];

export interface MetricPoint {
  event: MetricEvent;
  /** blob2.. (strings: model, outcome, colo, plan, …). */
  blobs?: (string | null)[];
  /** double1.. (counts, credits, USD, ms). */
  doubles?: number[];
}

/** Nearest-rank percentile over unsorted values (null when empty). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export function successRate(succeeded: number, failed: number): number | null {
  const n = succeeded + failed;
  return n === 0 ? null : succeeded / n;
}

/**
 * Margin of generation and agent use: credits spent are revenue at
 * `USD_PER_CREDIT`; gateway cost is what the gateway billed.
 */
export function margin(creditsSpent: number, gatewayCostUsd: number): { revenueUsd: number; costUsd: number; marginUsd: number; marginPct: number | null } {
  const revenueUsd = Math.round(creditsSpent * USD_PER_CREDIT * 100) / 100;
  const costUsd = Math.round(gatewayCostUsd * 100) / 100;
  const marginUsd = Math.round((revenueUsd - costUsd) * 100) / 100;
  return { revenueUsd, costUsd, marginUsd, marginPct: revenueUsd > 0 ? (revenueUsd - gatewayCostUsd) / revenueUsd : null };
}

/** UTC day key `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last `n` UTC days, oldest first, ending today. */
export function lastDays(n: number, now: number): string[] {
  const out: string[] = [];
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(today - i * 86_400_000));
  return out;
}

/** Route group for request metrics: `/api/<first segment>`; ids never appear. */
export function routeGroup(path: string): string {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'api') return 'web';
  return seg[1] ? `/api/${seg[1].replace(/[^a-z0-9-]/gi, '').slice(0, 24)}` : '/api';
}
