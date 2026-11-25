/**
 * Credit pricing configuration. Every number here is a PLACEHOLDER from
 * docs/PRD.md → Open decisions until product confirms it. Money amounts that
 * are not decided yet are the literal `[PRICE]` / `[DISCOUNT]` markers; do not
 * invent values.
 */

export const PRICE_PLACEHOLDER = '[PRICE]' as const;
export const DISCOUNT_PLACEHOLDER = '[DISCOUNT]' as const;
export type Placeholder = typeof PRICE_PLACEHOLDER | typeof DISCOUNT_PLACEHOLDER;

/** Credits are counted per 5 seconds of video or per image (PRD rule 2). */
export const VIDEO_CREDIT_UNIT_SECONDS = 5;

export interface CreditPrice {
  credits: number;
  per: 'video_5s' | 'image';
  /** PRD product name this price belongs to. */
  label: string;
  placeholder: true;
}

/**
 * Per-model credit prices, keyed by PRD model (capabilities `creditKey`).
 * Gateway substitutes (D-002) are priced as the PRD model they stand in for.
 */
export const CREDIT_PRICES = {
  'seedance-2.5': { credits: 8, per: 'video_5s', label: 'Seedance 2.5', placeholder: true },
  'minimax-h3': { credits: 6, per: 'video_5s', label: 'MiniMax H3', placeholder: true },
  'wan-3.0': { credits: 7, per: 'video_5s', label: 'Wan 3.0', placeholder: true },
  'wan-2.2': { credits: 2, per: 'video_5s', label: 'Wan 2.2 (cheap video)', placeholder: true },
  'seedream-5.0-pro': { credits: 3, per: 'image', label: 'Seedream 5.0 Pro', placeholder: true },
  'seedream-5.0-lite': { credits: 1, per: 'image', label: 'Seedream 5.0 Lite', placeholder: true },
  'wan-2.7-image': { credits: 2, per: 'image', label: 'Wan 2.7 Image', placeholder: true },
} as const satisfies Record<string, CreditPrice>;

export type CreditKey = keyof typeof CREDIT_PRICES;

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

/** Credit-to-USD rate (open decision). */
export const CREDIT_TO_USD: number | Placeholder = PRICE_PLACEHOLDER;

export class UnpricedModelError extends Error {
  override readonly name = 'UnpricedModelError';
  constructor(readonly creditKey: string) {
    super(`No credit price for ${creditKey}.`);
  }
}

export type CreditItem =
  | { creditKey: string; kind: 'video'; seconds: number }
  | { creditKey: string; kind: 'image'; count?: number };

export function isPriced(creditKey: string): creditKey is CreditKey {
  return Object.prototype.hasOwnProperty.call(CREDIT_PRICES, creditKey);
}

/**
 * Credits for one item: video is charged per started 5-second unit, images per
 * image. Throws UnpricedModelError for models with no price: credits are money,
 * an unpriced model must not run.
 */
export function creditsFor(item: CreditItem): number {
  if (!isPriced(item.creditKey)) throw new UnpricedModelError(item.creditKey);
  const price: CreditPrice = CREDIT_PRICES[item.creditKey];
  if (item.kind === 'video') {
    if (price.per !== 'video_5s') throw new TypeError(`${item.creditKey} is not a video model.`);
    if (!Number.isFinite(item.seconds) || item.seconds <= 0) throw new RangeError('seconds must be positive.');
    return Math.ceil(item.seconds / VIDEO_CREDIT_UNIT_SECONDS) * price.credits;
  }
  if (price.per !== 'image') throw new TypeError(`${item.creditKey} is not an image model.`);
  const count = item.count ?? 1;
  if (!Number.isInteger(count) || count <= 0) throw new RangeError('count must be a positive integer.');
  return count * price.credits;
}

/** Sum of `creditsFor` over items. */
export function creditsForAll(items: readonly CreditItem[]): number {
  return items.reduce((sum, item) => sum + creditsFor(item), 0);
}
