import { PLAN_ORDER, quoteTopUp, TOP_UP, type PlanId } from '@rolling/core/pricing/config';

/**
 * Top-up quotes for the UI (D-006): any amount from TOP_UP.minUsd to
 * TOP_UP.maxUsd, presets as chips. Credits come from `quoteTopUp`, so tier and
 * plan bonuses follow the pricing config; the server re-quotes at checkout.
 * Shared by the header credits popover, the credits paywall, Settings →
 * Billing and Upgrade.
 */
export interface TopUpOption {
  id: string;
  amountUsd: number;
  credits: number;
  bonusCredits: number;
  /** Tier bonus plus the plan bonus (0..1). */
  bonusRate: number;
}

/** Quote for `amountUsd`; `plan` null lists the amount without a plan bonus (non-members see what members get). */
export function topUpFor(amountUsd: number, plan: PlanId | null): TopUpOption {
  const q = quoteTopUp(Math.round(amountUsd * 100), plan ?? PLAN_ORDER[0]!);
  const planBonus = plan ? q.planBonus : 0;
  const bonusRate = q.tierBonus + planBonus;
  const bonusCredits = Math.floor(q.baseCredits * (Math.round(bonusRate * 1e6) / 1e6));
  return { id: `topup_${amountUsd}`, amountUsd, credits: q.baseCredits + bonusCredits, bonusCredits, bonusRate };
}

/** The suggested amounts (chips). */
export function topUpPresets(plan: PlanId | null): TopUpOption[] {
  return TOP_UP.presetsUsd.map((usd) => topUpFor(usd, plan));
}

export type TopUpAmountProblem = 'invalid' | 'min' | 'max';

/**
 * Parses a typed dollar amount ("40", "40.50"). Null for an empty field,
 * `{ error }` when it cannot be bought, `{ usd }` otherwise.
 */
export function parseTopUpAmount(text: string): { usd: number } | { error: TopUpAmountProblem } | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'invalid' };
  const usd = Number(t);
  if (usd < TOP_UP.minUsd) return { error: 'min' };
  if (usd > TOP_UP.maxUsd) return { error: 'max' };
  return { usd };
}

/** USD through Intl; whole amounts without cents ($15), others with cents ($39.17). */
export function formatUsd(
  amount: number,
  formatNumber: (n: number, o: { style: 'currency'; currency: string; minimumFractionDigits: number; maximumFractionDigits: number }) => string,
): string {
  const whole = Number.isInteger(amount);
  return formatNumber(amount, { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}
