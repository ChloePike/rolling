/**
 * Abuse protection (D-007): agent turns are free for members, with a daily
 * per-workspace limit. Values are placeholders until the owner sets them;
 * premium LLMs weigh more until D-009's open item (metering vs. plan limits)
 * is decided.
 */
import type { PlanId } from '@rolling/core/pricing/config';
import { isPremiumLlm } from './routing';

export const DAILY_TURN_LIMITS: Record<PlanId, number> = { starter: 150, plus: 400, pro: 1500 };
export const PREMIUM_LLM_TURN_WEIGHT = 10;

export function turnWeight(publicLlmId: string): number {
  return isPremiumLlm(publicLlmId) ? PREMIUM_LLM_TURN_WEIGHT : 1;
}

/** UTC day key, e.g. `2026-11-25`. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Start of the next UTC day (when the limit resets). */
export function nextDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
