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

export type PlanId = 'starter' | 'pro' | 'studio';

/**
 * Plans are the entry ticket (D-006): membership unlocks generating and buying
 * packs, and includes a small monthly grant. Revenue comes mainly from packs.
 * Tiers differ by perks and by a discount on packs, not by credit volume.
 */
export interface PlanConfig {
  id: PlanId;
  label: string;
  /** Included credits per month; expire at the next billing date (PRD rule 3). */
  monthlyCredits: number;
  priceMonthlyUsd: number | Placeholder;
  priceYearlyUsd: number | Placeholder;
  yearlyDiscount: number | Placeholder;
  /** Discount on credit packs for members of this plan (0..1). */
  packDiscount: number;
  /** Generation jobs that may run at once per workspace. */
  concurrentJobs: number;
  /** Highest output resolution the plan may request. */
  maxResolution: '1080p' | '4K';
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
    packDiscount: 0,
    concurrentJobs: 2,
    maxResolution: '1080p',
    voiceCloning: false,
    seats: 1,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyCredits: 800,
    priceMonthlyUsd: 15,
    priceYearlyUsd: 144,
    yearlyDiscount: 0.2,
    packDiscount: 0.05,
    concurrentJobs: 5,
    maxResolution: '4K',
    voiceCloning: true,
    seats: 1,
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    monthlyCredits: 2500,
    priceMonthlyUsd: 49,
    priceYearlyUsd: 470,
    yearlyDiscount: 0.2,
    packDiscount: 0.1,
    concurrentJobs: 10,
    maxResolution: '4K',
    voiceCloning: true,
    seats: 10,
  },
};

/**
 * Credit packs (members only; purchased credits never expire). Larger packs
 * carry bonus credits. Sizes are capped so that the largest pack with the
 * largest member discount still keeps gross margin at or above 50%.
 */
export interface CreditPack {
  id: string;
  priceUsd: number;
  credits: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'pack_10', priceUsd: 10, credits: 1000 },
  { id: 'pack_25', priceUsd: 25, credits: 2600 },
  { id: 'pack_50', priceUsd: 50, credits: 5500 },
  { id: 'pack_100', priceUsd: 100, credits: 11500 },
  { id: 'pack_250', priceUsd: 250, credits: 28500 },
];

/** Price of a pack for a member of `plan`, in USD cents (rounded down to the cent). */
export function packPriceCents(pack: CreditPack, plan: PlanId): number {
  return Math.floor(pack.priceUsd * 100 * (1 - PLANS[plan].packDiscount));
}

/** Runs at or above this many credits show the confirm dialog (PRD rule 5; 300 ≈ $3, the old “20 credits” rescaled to $0.01 credits, D-006). */
export const DEFAULT_CONFIRM_THRESHOLD_CREDITS = 300;

/** Optional auto top-up: below `belowCredits`, buy `buyCredits` (PRD rule 6). */
export const AUTO_TOP_UP = { belowCredits: 200, packId: 'pack_10' } as const;
