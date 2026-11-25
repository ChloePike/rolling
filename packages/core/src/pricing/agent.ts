/**
 * Agent allowance math (D-012). Pure helpers shared by the API (CreditAccount
 * agent ledger, routes) and the web client (mock until wiring).
 *
 * Money inside the allowance ledger is integer micro-USD (1e-6 USD) so sums
 * never drift; the API reports USD.
 */
import { addMonths } from '../credits/ledger';
import type { ChatUsage } from '../models/types';
import { AGENT_TURN_TOKENS } from './config';

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return Math.round(micros) / MICROS_PER_USD;
}

/**
 * Current allowance period. With the subscription's `current_period_start`
 * as anchor, periods are monthly slices from it (a yearly plan resets monthly
 * on the same day); without one, the calendar month in UTC.
 */
export function agentAllowancePeriod(now: number, anchor: number | null | undefined): { start: number; resetsAt: number } {
  if (anchor !== null && anchor !== undefined && Number.isFinite(anchor) && anchor <= now) {
    const d0 = new Date(anchor);
    const d1 = new Date(now);
    let k = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + (d1.getUTCMonth() - d0.getUTCMonth());
    while (k > 0 && addMonths(anchor, k) > now) k--;
    while (addMonths(anchor, k + 1) <= now) k++;
    return { start: addMonths(anchor, k), resetsAt: addMonths(anchor, k + 1) };
  }
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), resetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

export interface TokenPrice {
  prompt: number;
  completion: number;
}

/** Default turn estimate from token prices: 10k prompt + 1.2k completion tokens. */
export function defaultTurnEstimateUsd(price: TokenPrice | null): number {
  if (!price) return 0;
  return price.prompt * AGENT_TURN_TOKENS.prompt + price.completion * AGENT_TURN_TOKENS.completion;
}

/** Cost of one LLM response: the gateway's `usage.cost`, else tokens × list price. */
export function responseCostUsd(usage: Pick<ChatUsage, 'promptTokens' | 'completionTokens' | 'costUsd'>, price: TokenPrice | null): number {
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return usage.costUsd;
  if (!price) return 0;
  return usage.promptTokens * price.prompt + usage.completionTokens * price.completion;
}

/**
 * What an LLM call was for. Turn, retry and summary calls are charged to the
 * workspace's allowance; classifier calls (Auto model choice, safety) are not.
 */
export type AgentCallPurpose = 'turn' | 'retry' | 'summary' | 'classifier';

const CHARGED: ReadonlySet<AgentCallPurpose> = new Set(['turn', 'retry', 'summary']);

/** Sums the charged cost of a turn's LLM calls. */
export class AgentCostMeter {
  private charged = 0;
  private free = 0;

  add(purpose: AgentCallPurpose, usage: Pick<ChatUsage, 'promptTokens' | 'completionTokens' | 'costUsd'>, price: TokenPrice | null): number {
    const usd = responseCostUsd(usage, price);
    if (CHARGED.has(purpose)) this.charged += usd;
    else this.free += usd;
    return usd;
  }

  /** USD charged to the allowance. */
  get chargedUsd(): number {
    return this.charged;
  }

  /** USD of uncharged calls (classifiers), for telemetry. */
  get freeUsd(): number {
    return this.free;
  }
}

/** Turns left at an estimate; 0 when the estimate is unknown or the allowance is used up. */
export function turnsLeft(allowanceUsd: number, usedUsd: number, estTurnUsd: number): number {
  const left = allowanceUsd - usedUsd;
  if (left <= 0) return 0;
  if (!(estTurnUsd > 0)) return 0;
  return Math.floor(left / estTurnUsd + 1e-9);
}

/** Rolling average of a model's recent turn costs, or null without history. */
export function rollingAverage(costs: readonly number[]): number | null {
  const xs = costs.filter((c) => Number.isFinite(c) && c > 0);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Recent settled turns used for the rolling estimate. */
export const AGENT_ESTIMATE_WINDOW = 20;
