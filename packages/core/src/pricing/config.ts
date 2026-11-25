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
 * Both numbers are PLACEHOLDERS (open decision "per-model credit prices").
 * USD_PER_CREDIT is chosen so the PRD's anchor, Seedance 2.5 at 720p for 5 s =
 * 8 credits, still holds:
 *
 *   usdCost = 5 s × $0.23112/s = $1.1556
 *   credits = ceil(1.1556 × 1.0 ÷ 0.15) = ceil(7.704) = 8
 */
export const MARKUP = 1.0;
export const USD_PER_CREDIT = 0.15;

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

export interface PlanConfig {
  id: PlanId;
  label: string;
  /** Credits granted per billing period (placeholder). */
  monthlyCredits: number;
  priceMonthlyUsd: number | Placeholder;
  priceYearlyUsd: number | Placeholder;
  yearlyDiscount: number | Placeholder;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  starter: {
    id: 'starter',
    label: 'Starter',
    monthlyCredits: 1000,
    priceMonthlyUsd: PRICE_PLACEHOLDER,
    priceYearlyUsd: PRICE_PLACEHOLDER,
    yearlyDiscount: DISCOUNT_PLACEHOLDER,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyCredits: 3000,
    priceMonthlyUsd: PRICE_PLACEHOLDER,
    priceYearlyUsd: PRICE_PLACEHOLDER,
    yearlyDiscount: DISCOUNT_PLACEHOLDER,
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    monthlyCredits: 10000,
    priceMonthlyUsd: PRICE_PLACEHOLDER,
    priceYearlyUsd: PRICE_PLACEHOLDER,
    yearlyDiscount: DISCOUNT_PLACEHOLDER,
  },
};

/** Credit packs (members only). Sizes and prices are open decisions. */
export const CREDIT_PACKS: { credits: number; priceUsd: number | Placeholder }[] = [
  { credits: 1000, priceUsd: PRICE_PLACEHOLDER },
];

/** Runs at or above this many credits show the confirm dialog (PRD rule 5). */
export const DEFAULT_CONFIRM_THRESHOLD_CREDITS = 20;

/** Optional auto top-up: below `belowCredits`, buy `buyCredits` (PRD rule 6). */
export const AUTO_TOP_UP = { belowCredits: 200, buyCredits: 1000 } as const;
