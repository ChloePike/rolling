/**
 * Stripe catalog derived from `pricing/config.ts` (D-006). Subscription prices
 * are found by lookup key, so price ids never live in code or config.
 */
import { AUTO_TOP_UP, PLAN_ORDER, PLANS, TOP_UP, type PlanId } from '../pricing/config';
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
  const m = /^rolling_(starter|plus|pro)_(month|year)$/.exec(key ?? '');
  return m ? { planId: m[1] as PlanId, interval: m[2] as PlanInterval } : null;
}

/** Price in cents. Throws if config still holds a placeholder. */
export function planPriceCents(plan: PlanId, interval: PlanInterval): number {
  const usd = interval === 'month' ? PLANS[plan].priceMonthlyUsd : PLANS[plan].priceYearlyUsd;
  if (typeof usd !== 'number') throw new Error(`Price for ${plan}/${interval} is not decided yet.`);
  return Math.round(usd * 100);
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
        seats: p.seats,
      };
    }),
    topUp: {
      minCents: TOP_UP.minUsd * 100,
      maxCents: TOP_UP.maxUsd * 100,
      tiers: TOP_UP.tiers.map((t) => ({ minCents: t.minUsd * 100, bonus: t.bonus })),
      presetsCents: TOP_UP.presetsUsd.map((u) => u * 100),
    },
    autoTopUp: { thresholdCredits: AUTO_TOP_UP.belowCredits, amountCents: AUTO_TOP_UP.amountUsd * 100 },
  };
}
