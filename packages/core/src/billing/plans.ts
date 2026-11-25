/**
 * Stripe catalog derived from `pricing/config.ts` (D-006). Subscription prices
 * are found by lookup key, so price ids never live in code or config.
 */
import { AUTO_TOP_UP, PLAN_ORDER, PLANS, SEAT_PRICE, TEAM_SEATS, TOP_UP, type PlanId } from '../pricing/config';
import type { PlanInterval } from '../credits/types';

export const PLAN_INTERVALS: readonly PlanInterval[] = ['month', 'year'];

/** Stripe product id per plan (custom ids make the sync script idempotent). */
export function planProductId(plan: PlanId): string {
  return `rolling_plan_${plan}`;
}

/** Stripe price lookup key, e.g. `rolling_plus_month`. */
export function planLookupKey(plan: PlanId, interval: PlanInterval): string {
  return `rolling_${plan}_${interval}`;
}

export function parsePlanLookupKey(key: string | null | undefined): { planId: PlanId; interval: PlanInterval } | null {
  const m = /^rolling_(starter|plus|pro|team)_(month|year)$/.exec(key ?? '');
  return m ? { planId: m[1] as PlanId, interval: m[2] as PlanInterval } : null;
}

/** Price in cents. Throws if config still holds a placeholder. */
export function planPriceCents(plan: PlanId, interval: PlanInterval): number {
  const usd = interval === 'month' ? PLANS[plan].priceMonthlyUsd : PLANS[plan].priceYearlyUsd;
  if (typeof usd !== 'number') throw new Error(`Price for ${plan}/${interval} is not decided yet.`);
  return Math.round(usd * 100);
}

/** Product of the Team per-seat price (D-013). */
export const TEAM_SEAT_PRODUCT_ID = 'rolling_plan_team_seat';

/** Lookup key of the Team per-seat price, e.g. `rolling_team_seat_month`. Quantity = seats − 1. */
export function teamSeatLookupKey(interval: PlanInterval): string {
  return `rolling_team_seat_${interval}`;
}

export function parseTeamSeatLookupKey(key: string | null | undefined): { interval: PlanInterval } | null {
  const m = /^rolling_team_seat_(month|year)$/.exec(key ?? '');
  return m ? { interval: m[1] as PlanInterval } : null;
}

/** Per-seat price in cents. */
export function teamSeatPriceCents(interval: PlanInterval): number {
  return Math.round((interval === 'month' ? SEAT_PRICE.priceMonthlyUsd : SEAT_PRICE.priceYearlyUsd) * 100);
}

export interface StripeSeatPrice {
  interval: PlanInterval;
  lookupKey: string;
  productId: string;
  unitAmount: number;
  currency: 'usd';
}

export function stripeSeatPrices(): StripeSeatPrice[] {
  return PLAN_INTERVALS.map((interval) => ({
    interval,
    lookupKey: teamSeatLookupKey(interval),
    productId: TEAM_SEAT_PRODUCT_ID,
    unitAmount: teamSeatPriceCents(interval),
    currency: 'usd' as const,
  }));
}

export interface StripePlanPrice {
  planId: PlanId;
  interval: PlanInterval;
  lookupKey: string;
  productId: string;
  unitAmount: number;
  currency: 'usd';
}

export function stripePlanPrices(): StripePlanPrice[] {
  return PLAN_ORDER.flatMap((planId) =>
    PLAN_INTERVALS.map((interval) => ({
      planId,
      interval,
      lookupKey: planLookupKey(planId, interval),
      productId: planProductId(planId),
      unitAmount: planPriceCents(planId, interval),
      currency: 'usd' as const,
    })),
  );
}

/** Public plan catalog for `GET /api/billing/plans` (USD; other currencies later). */
export function publicPlanCatalog() {
  return {
    currency: 'USD',
    plans: PLAN_ORDER.map((id) => {
      const p = PLANS[id];
      return {
        id,
        label: p.label,
        monthlyCredits: p.monthlyCredits,
        prices: { month: planPriceCents(id, 'month'), year: planPriceCents(id, 'year') },
        yearlyDiscount: p.yearlyDiscount,
        topUpBonus: p.topUpBonus,
        concurrentJobs: p.concurrentJobs,
        maxVideoResolution: p.maxVideoResolution,
        maxImageResolution: p.maxImageResolution,
        voiceCloning: p.voiceCloning,
        kind: p.kind,
        seats: p.seats,
      };
    }),
    /** Team extra seat (D-013): price per interval and what each seat adds. */
    teamSeat: {
      prices: { month: teamSeatPriceCents('month'), year: teamSeatPriceCents('year') },
      monthlyCredits: SEAT_PRICE.monthlyCredits,
      concurrentJobs: SEAT_PRICE.concurrentJobs,
      maxConcurrentJobs: SEAT_PRICE.maxConcurrentJobs,
      agentAllowanceUsd: SEAT_PRICE.agentAllowanceUsd,
      minSeats: TEAM_SEATS.min,
      maxSeats: TEAM_SEATS.max,
    },
    topUp: {
      minCents: TOP_UP.minUsd * 100,
      maxCents: TOP_UP.maxUsd * 100,
      tiers: TOP_UP.tiers.map((t) => ({ minCents: t.minUsd * 100, bonus: t.bonus })),
      presetsCents: TOP_UP.presetsUsd.map((u) => u * 100),
    },
    autoTopUp: { thresholdCredits: AUTO_TOP_UP.belowCredits, amountCents: AUTO_TOP_UP.amountUsd * 100 },
  };
}
