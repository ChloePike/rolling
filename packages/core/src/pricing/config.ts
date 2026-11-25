/**
 * Credit pricing configuration. Every number here is a PLACEHOLDER from
 * docs/PRD.md → Open decisions until product confirms it. Money amounts that
 * are not decided yet are the literal `[PRICE]` / `[DISCOUNT]` markers; do not
 * invent values.
 */
import { usdCost, type PriceRequest } from '../models/catalog';
import type { ListingModel } from '../models/types';

export const PRICE_PLACEHOLDER = '[PRICE]' as const;
export const DISCOUNT_PLACEHOLDER = '[DISCOUNT]' as const;
export type Placeholder = typeof PRICE_PLACEHOLDER | typeof DISCOUNT_PLACEHOLDER;

/**
 * Credits follow live cost (D-002):
 *
 *   credits = ceil(usdCost(model, request) × MARKUP ÷ USD_PER_CREDIT)
 *
 * `usdCost` is the gateway's list price from the synced `GET /v1/models`
 * listing, per (resolution, seconds, audio, input conditions), so every model
 * and resolution is priced without a hand-kept table.
 *
 * Pricing model (owner decision 2026-11-25, see docs/decisions.md D-006):
 * 1 credit = $0.01 retail and a 3.0× markup on gateway list price, which keeps
 * gross margin ≥ 50% on every pack and plan even when every credit is used
 * (after card fees and infrastructure). The Hyperouter top-up fee is ignored.
 *
 *   Seedance 2.5, 720p, 5 s: usdCost = 5 × $0.23112 = $1.1556
 *   credits = ceil(1.1556 × 3.0 ÷ 0.01) = ceil(346.68) = 347
 */
export const MARKUP = 3.0;
export const USD_PER_CREDIT = 0.01;

export class UnpricedModelError extends Error {
  override readonly name = 'UnpricedModelError';
  constructor(readonly modelId: string) {
    super(`No price for ${modelId} with these settings.`);
  }
}

/** Credits for USD at the gateway. Rounds float noise before the ceiling (credits are money). */
export function creditsForUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError('usd must be a non-negative number.');
  return Math.ceil(Math.round(((usd * MARKUP) / USD_PER_CREDIT) * 1e6) / 1e6);
}

/**
 * Credits for one request on a catalog model. Throws UnpricedModelError when
 * the listing has no price for it (e.g. a resolution the model does not offer):
 * an unpriced request must not run.
 */
export function creditsFor(model: ListingModel, request: PriceRequest = {}): number {
  if (request.seconds !== undefined && (!Number.isFinite(request.seconds) || request.seconds <= 0)) {
    throw new RangeError('seconds must be positive.');
  }
  if (request.n !== undefined && (!Number.isInteger(request.n) || request.n <= 0)) {
    throw new RangeError('n must be a positive integer.');
  }
  const usd = usdCost(model, request);
  if (usd === null) throw new UnpricedModelError(model.id);
  return creditsForUsd(usd);
}

/** Sum of `creditsFor` over items (each item is rounded up on its own). */
export function creditsForAll(items: readonly { model: ListingModel; request?: PriceRequest }[]): number {
  return items.reduce((sum, item) => sum + creditsFor(item.model, item.request), 0);
}

export type PlanId = 'starter' | 'plus' | 'pro';

/**
 * Plans are the entry ticket (D-006): membership unlocks generating and
 * topping up, and includes a small monthly grant. Revenue comes mainly from
 * top-ups. Tiers differ by perks and by a bonus on every top-up.
 */
export interface PlanConfig {
  id: PlanId;
  label: string;
  /** Included credits per month; expire at the next billing date (PRD rule 3). */
  monthlyCredits: number;
  priceMonthlyUsd: number | Placeholder;
  priceYearlyUsd: number | Placeholder;
  yearlyDiscount: number | Placeholder;
  /** Extra bonus on every top-up for members of this plan, added to the amount tier bonus (0..1). */
  topUpBonus: number;
  /** Generation jobs that may run at once per workspace. */
  concurrentJobs: number;
  /** Highest video output resolution (also applies to avatar / lip-sync runs). */
  maxVideoResolution: '720p' | '1080p' | '4K';
  /** Highest image output resolution. */
  maxImageResolution: '2K' | '4K';
  voiceCloning: boolean;
  /** Seats in a shared credit pool (1 = personal). */
  seats: number;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  starter: {
    id: 'starter',
    label: 'Starter',
    monthlyCredits: 200,
    priceMonthlyUsd: 5,
    priceYearlyUsd: 48,
    yearlyDiscount: 0.2,
    topUpBonus: 0,
    concurrentJobs: 2,
    maxVideoResolution: '720p',
    maxImageResolution: '2K',
    voiceCloning: false,
    seats: 1,
  },
  plus: {
    id: 'plus',
    label: 'Plus',
    monthlyCredits: 800,
    priceMonthlyUsd: 15,
    priceYearlyUsd: 144,
    yearlyDiscount: 0.2,
    topUpBonus: 0.05,
    concurrentJobs: 5,
    maxVideoResolution: '1080p',
    maxImageResolution: '2K',
    voiceCloning: true,
    seats: 1,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyCredits: 2500,
    priceMonthlyUsd: 49,
    priceYearlyUsd: 470,
    yearlyDiscount: 0.2,
    topUpBonus: 0.1,
    concurrentJobs: 10,
    maxVideoResolution: '4K',
    maxImageResolution: '4K',
    voiceCloning: true,
    seats: 10,
  },
};

export const PLAN_ORDER: readonly PlanId[] = ['starter', 'plus', 'pro'];

/**
 * Output size rank for plan caps. Video labels use their short side (480p, 720p,
 * 768p, 1080p); "1K"/"2K"/"4K" labels map to their nominal short side. Unknown
 * labels rank as Infinity so they are never allowed by accident.
 */
export function resolutionRank(label: string): number {
  const p = /^(\d{3,4})p$/i.exec(label);
  if (p) return Number(p[1]);
  const k = /^(\d)K$/i.exec(label);
  if (k) return { 1: 1080, 2: 1440, 4: 2160 }[Number(k[1]) as 1 | 2 | 4] ?? Number.POSITIVE_INFINITY;
  return Number.POSITIVE_INFINITY;
}

/**
 * Whether a plan may request `resolution` for a `kind` output (D-006).
 * Requests without a resolution (model default) are checked by the caller
 * against the model's default resolution.
 */
export function planAllowsResolution(plan: PlanId, kind: 'video' | 'image', resolution: string): boolean {
  const cap = kind === 'video' ? PLANS[plan].maxVideoResolution : PLANS[plan].maxImageResolution;
  return resolutionRank(resolution) <= resolutionRank(cap);
}

/** The lowest plan that allows `resolution`, for upgrade prompts; null if none does. */
export function lowestPlanFor(kind: 'video' | 'image', resolution: string): PlanId | null {
  return PLAN_ORDER.find((plan) => planAllowsResolution(plan, kind, resolution)) ?? null;
}


/**
 * Top-ups (members only; purchased credits never expire). Any amount from
 * `minUsd` to `maxUsd`, in whole cents. Base credits = amount / $0.01; a bonus
 * is added by amount tier plus the member's plan bonus (additive). Tiers and the
 * plan bonus are capped so that every amount keeps gross margin >= 50%.
 */
export const TOP_UP = {
  minUsd: 10,
  maxUsd: 10_000,
  /** Ascending by `minUsd`; the highest tier the amount reaches applies. */
  tiers: [
    { minUsd: 10, bonus: 0 },
    { minUsd: 25, bonus: 0.04 },
    { minUsd: 50, bonus: 0.1 },
    { minUsd: 100, bonus: 0.15 },
  ],
  /** Suggested amounts shown as chips; any other amount is allowed. */
  presetsUsd: [10, 25, 50, 100, 250],
} as const;

export class TopUpAmountError extends RangeError {
  override readonly name = 'TopUpAmountError';
}

export interface TopUpQuote {
  amountCents: number;
  baseCredits: number;
  tierBonus: number;
  planBonus: number;
  bonusCredits: number;
  credits: number;
}

/** Credits granted for a top-up of `amountCents` by a member of `plan`. */
export function quoteTopUp(amountCents: number, plan: PlanId): TopUpQuote {
  if (!Number.isInteger(amountCents)) throw new TopUpAmountError('Amount must be whole cents.');
  if (amountCents < TOP_UP.minUsd * 100) throw new TopUpAmountError('Top-up is below the minimum.');
  if (amountCents > TOP_UP.maxUsd * 100) throw new TopUpAmountError('Top-up is above the maximum.');
  const baseCredits = Math.floor(amountCents / (USD_PER_CREDIT * 100));
  let tierBonus = 0;
  for (const tier of TOP_UP.tiers) if (amountCents >= tier.minUsd * 100) tierBonus = tier.bonus;
  const planBonus = PLANS[plan].topUpBonus;
  // Round the rate first so float noise never adds or drops a credit.
  const rate = Math.round((tierBonus + planBonus) * 1e6) / 1e6;
  const bonusCredits = Math.floor(baseCredits * rate);
  return { amountCents, baseCredits, tierBonus, planBonus, bonusCredits, credits: baseCredits + bonusCredits };
}

/** Runs at or above this many credits show the confirm dialog (PRD rule 5; 300 ≈ $3, the old “20 credits” rescaled to $0.01 credits, D-006). */
export const DEFAULT_CONFIRM_THRESHOLD_CREDITS = 300;

/** Optional auto top-up: below `belowCredits`, buy `buyCredits` (PRD rule 6). */
export const AUTO_TOP_UP = { belowCredits: 200, amountUsd: TOP_UP.minUsd } as const;
