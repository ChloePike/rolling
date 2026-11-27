/**
 * Credit pricing configuration. Every number here is a PLACEHOLDER from
 * docs/PRD.md → Open decisions until product confirms it. Money amounts that
 * are not decided yet are the literal `[PRICE]` / `[DISCOUNT]` markers; do not
 * invent values.
 */
import { usdCost, type PriceRequest } from '../models/price';
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

export type PlanId = 'starter' | 'plus' | 'pro' | 'team';

/** Personal plans have one seat; Team buys seats (D-013). */
export type PlanKind = 'personal' | 'team';

/**
 * Plans are the entry ticket (D-006): membership unlocks generating and
 * topping up, and includes a small monthly grant. Revenue comes mainly from
 * top-ups. Tiers differ by perks and by a bonus on every top-up.
 */
export interface PlanConfig {
  id: PlanId;
  label: string;
  kind: PlanKind;
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
  /**
   * Seats included in the base price (D-013): 1 everywhere. Personal plans
   * cannot add seats; Team adds them at `SEAT_PRICE` each.
   */
  seats: number;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  starter: {
    id: 'starter',
    kind: 'personal',
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
    kind: 'personal',
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
    kind: 'personal',
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
    seats: 1,
  },
  /**
   * Team (D-013): Pro perks for a shared workspace. The base price includes
   * the owner's seat; values below are for that one seat, `team*` helpers add
   * what each extra seat brings.
   */
  team: {
    id: 'team',
    label: 'Team',
    kind: 'team',
    monthlyCredits: 2500,
    priceMonthlyUsd: 79,
    priceYearlyUsd: 758,
    yearlyDiscount: 0.2,
    topUpBonus: 0.1,
    concurrentJobs: 10,
    maxVideoResolution: '4K',
    maxImageResolution: '4K',
    voiceCloning: true,
    seats: 1,
  },
};

export const PLAN_ORDER: readonly PlanId[] = ['starter', 'plus', 'pro', 'team'];

/** Personal plans, lowest first (upgrade prompts, the Upgrade page cards). */
export const PERSONAL_PLAN_ORDER: readonly PlanId[] = PLAN_ORDER.filter((p) => PLANS[p].kind === 'personal');

/**
 * Each Team seat beyond the first (D-013). Seats = members including the owner;
 * `seats − 1` is the Stripe quantity of the per-seat price.
 */
export const SEAT_PRICE = {
  priceMonthlyUsd: 25,
  priceYearlyUsd: 240,
  /** Shared plan credits added per month. */
  monthlyCredits: 500,
  /** Concurrent jobs added (capped at `maxConcurrentJobs`). */
  concurrentJobs: 2,
  maxConcurrentJobs: 30,
  /** Agent allowance added per month (D-012). */
  agentAllowanceUsd: 3,
} as const;

/** Seat bounds for a Team workspace. */
export const TEAM_SEATS = { min: 1, max: 200 } as const;

function seatCount(seats: number): number {
  if (!Number.isInteger(seats) || seats < TEAM_SEATS.min || seats > TEAM_SEATS.max) {
    throw new RangeError(`seats must be an integer from ${TEAM_SEATS.min} to ${TEAM_SEATS.max}.`);
  }
  return seats;
}

/** Shared plan credits per month for a Team of `seats` (2,500 + 500 per extra seat). */
export function teamIncludedCredits(seats: number): number {
  return PLANS.team.monthlyCredits + (seatCount(seats) - 1) * SEAT_PRICE.monthlyCredits;
}

/** Concurrent jobs for a Team of `seats` (10 + 2 per extra seat, max 30). */
export function teamConcurrentJobs(seats: number): number {
  return Math.min(SEAT_PRICE.maxConcurrentJobs, PLANS.team.concurrentJobs + (seatCount(seats) - 1) * SEAT_PRICE.concurrentJobs);
}

/** Monthly agent allowance in USD for a Team of `seats` ($12.50 + $3 per extra seat). */
export function teamAgentAllowanceUsd(seats: number): number {
  return Math.round((AGENT_ALLOWANCE_USD.team + (seatCount(seats) - 1) * SEAT_PRICE.agentAllowanceUsd) * 100) / 100;
}

/** Price of a Team of `seats` per interval, in cents (base + seats − 1 extra seats). */
export function teamPriceCents(seats: number, interval: 'month' | 'year'): number {
  const base = interval === 'month' ? PLANS.team.priceMonthlyUsd : PLANS.team.priceYearlyUsd;
  const seat = interval === 'month' ? SEAT_PRICE.priceMonthlyUsd : SEAT_PRICE.priceYearlyUsd;
  return Math.round(((base as number) + (seatCount(seats) - 1) * seat) * 100);
}

/**
 * The share of `amount` left for the rest of a period (`now` in [start, end)),
 * rounded down. Used for the prorated Stripe estimate of added seats and for
 * the extra plan credits added seats bring in the current month slice.
 */
export function prorate(amount: number, start: number, end: number, now: number): number {
  if (!(end > start) || now >= end) return 0;
  if (now <= start) return Math.floor(amount);
  return Math.floor((amount * (end - now)) / (end - start) + 1e-9);
}

/** Seats that count for limits: Team uses the purchased seats, personal plans 1. */
function effectiveSeats(plan: PlanId, seats: number | null | undefined): number {
  return PLANS[plan].kind === 'team' ? Math.max(1, Math.min(TEAM_SEATS.max, Math.floor(seats ?? 1))) : 1;
}

/** Included plan credits per month for `plan` (Team: by seats). */
export function planMonthlyCredits(plan: PlanId, seats?: number | null): number {
  return PLANS[plan].kind === 'team' ? teamIncludedCredits(effectiveSeats(plan, seats)) : PLANS[plan].monthlyCredits;
}

/** Concurrent generation jobs for `plan` (Team: by seats). */
export function planConcurrentJobs(plan: PlanId, seats?: number | null): number {
  return PLANS[plan].kind === 'team' ? teamConcurrentJobs(effectiveSeats(plan, seats)) : PLANS[plan].concurrentJobs;
}

/** Monthly agent allowance in USD for `plan` (Team: by seats, D-012/D-013). */
export function planAgentAllowanceUsd(plan: PlanId, seats?: number | null): number {
  return PLANS[plan].kind === 'team' ? teamAgentAllowanceUsd(effectiveSeats(plan, seats)) : AGENT_ALLOWANCE_USD[plan];
}

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

/**
 * Agent Auto mode (D-021): the per-turn budget the agent may start runs within. It defaults to the
 * user's confirm threshold; the user picks another value next to the mode switch (`prefs.autoBudget`).
 * `choices` are the values the switch offers; `max` bounds what the API accepts.
 */
export const AUTO_BUDGET = { choices: [100, 300, 500, 1_000, 2_000], max: 10_000 } as const;

/** The Auto mode budget for one turn: the user's choice, else the confirm threshold, clamped to `0..AUTO_BUDGET.max`. */
export function autoBudgetCredits(choice: number | null | undefined, confirmThreshold: number): number {
  const v = typeof choice === 'number' && Number.isFinite(choice) ? choice : confirmThreshold;
  return Math.max(0, Math.min(AUTO_BUDGET.max, Math.floor(v)));
}

/** Optional auto top-up: below `belowCredits`, buy `buyCredits` (PRD rule 6). */
export const AUTO_TOP_UP = { belowCredits: 200, amountUsd: TOP_UP.minUsd } as const;

/**
 * Monthly agent allowance per plan, in USD of gateway cost (D-012). Every
 * agent turn deducts its actual LLM cost; resets on the plan's billing period
 * start (monthly slices for yearly plans). Sized so plan gross margin stays
 * ≥ 50% in the worst case (all included credits used + card fees + 2% infra +
 * the whole allowance), see config.test.ts. `team` is the one-seat base;
 * use `planAgentAllowanceUsd(plan, seats)` (D-013 adds $3 per extra seat).
 */
export const AGENT_ALLOWANCE_USD: Record<PlanId, number> = { starter: 1.2, plus: 3.5, pro: 12.5, team: 12.5 };

/** Default turn size for cost estimates before a model has history (D-012). */
export const AGENT_TURN_TOKENS = { prompt: 10_000, completion: 1_200 } as const;

/**
 * Gateway prompt expansion ("Enhance prompt", D-020): the most one rewrite can
 * use, in tokens. Hyperouter bills the rewrite on the same request at the
 * writer's token prices and holds its most up front; we quote and hold our own
 * conservative bound and settle on the request's `usage.cost`.
 * Input: the writer's instructions plus the prompt (one token per character at
 * most) plus each input picture; output: the rewrite, with room for reasoning
 * (DeepSeek reasons before it answers by default).
 */
export const PROMPT_EXPANSION_TOKENS = {
  instructions: 6_000,
  perPicture: 1_500,
  maxPictures: 5,
  output: 8_000,
} as const;

/**
 * Token prices (USD per token) assumed for the gateway's default writer
 * (`x-ai/grok-4.6`) when the synced catalog has no price for it.
 */
export const PROMPT_EXPANSION_DEFAULT_WRITER_PRICE = { prompt: 0.000002, completion: 0.000006 } as const;

/**
 * Post-production (D-033, D-034). Auto captions run on Workers AI Whisper
 * (`@cf/openai/whisper-large-v3-turbo`, $0.000513 per audio minute): a 15-minute
 * cut costs under one cent, less than one credit even at the 3× markup, so
 * captions are free (absorbed) with a daily cap per workspace instead of a
 * quote. FFmpeg container work (resize, smoother motion, reframing, social
 * presets, brand kit) is free like exports. Extend clip and lip-sync are
 * normal runs (quote → hold → settle).
 */
export const POST_PRODUCTION = {
  captions: { credits: 0, usdPerAudioMinute: 0.000513, maxMinutesPerJob: 15, maxMinutesPerDay: 240 },
  resize: { credits: 0, maxSeconds: 120 },
  interpolation: { credits: 0 },
} as const;

/** Resize targets (honest label: Lanczos scaling plus a mild sharpen, not AI upscaling) and their short side. */
export const RESIZE_TARGETS = { '1080p': 1080, '4K': 2160 } as const;
export type ResizeTarget = keyof typeof RESIZE_TARGETS;

/** Whether a plan may resize a `kind` output to `target` (D-006 caps: 1080p video needs Plus, 4K needs Pro). */
export function planAllowsResize(plan: PlanId, kind: 'video' | 'image', target: ResizeTarget): boolean {
  return planAllowsResolution(plan, kind, target);
}

/**
 * Result review (D-024): every generation output is checked by a cheap
 * vision-capable chat model after `store`. The review is covered from the
 * margin, not quoted or held: one credit of render earns at least
 * `USD_PER_CREDIT × (1 − 1 / MARKUP)` ≈ $0.0067 over the gateway cost, and a
 * review is bounded by these tokens (pictures are downscaled to ≤ 1024 px;
 * a video take sends two frames). `expectedUsdPerOutput` is what a review
 * costs on DeepSeek V4.1 Flash; `maxUsdPerOutput` is the most we allow per
 * output at the review model's prices (above it the review is skipped).
 */
export const QUALITY_REVIEW = {
  promptTokens: 1_200,
  tokensPerPicture: 1_100,
  /** Outputs reviewed per job (takes beyond it keep their order). */
  maxTakes: 4,
  /** Pictures per take: an image, or two frames of a clip. */
  maxPicturesPerTake: 2,
  /** Character reference pictures sent for continuity. */
  maxReferences: 2,
  outputTokensPerTake: 450,
  expectedUsdPerOutput: 0.002,
  maxUsdPerOutput: 0.005,
} as const;

/** Worst-case gateway cost of reviewing `takes` outputs at a chat model's token prices (USD per token). */
export function reviewMaxUsd(takes: number, picturesPerTake: number, references: number, price: { prompt: number; completion: number }): number {
  const t = Math.max(1, Math.min(QUALITY_REVIEW.maxTakes, takes));
  const pictures = t * Math.min(QUALITY_REVIEW.maxPicturesPerTake, picturesPerTake) + Math.min(QUALITY_REVIEW.maxReferences, references);
  const prompt = QUALITY_REVIEW.promptTokens + pictures * QUALITY_REVIEW.tokensPerPicture;
  return prompt * price.prompt + t * QUALITY_REVIEW.outputTokensPerTake * price.completion;
}
