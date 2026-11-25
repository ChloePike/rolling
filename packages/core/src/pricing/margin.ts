/**
 * Monthly gross margin report (ops; D-006, D-012, D-013). Pure: the script
 * `apps/api/scripts/margin-report.ts` loads the rows from D1 and prints the
 * result. Per plan × interval:
 *
 *   revenue    = subscriptions (monthly price, or yearly price ÷ 12) + top-ups paid in the month
 *   costs      = gateway cost of credits consumed (credits × $0.01 ÷ 3.0 markup)
 *              + agent usage USD (all turns, unmetered DeepSeek included)
 *              + card fees (4.65% + $0.30 per charge; a yearly charge counts 1/12 per month)
 *              + 2% infrastructure
 *   margin     = 1 − costs ÷ revenue
 *
 * Flags plans under the floor: 50% (personal plans), 60% (Team).
 */
import { PLANS, type PlanId, MARKUP, USD_PER_CREDIT, teamPriceCents } from './config';

export const CARD_FEE_RATE = 0.0465;
export const CARD_FEE_FIXED_USD = 0.3;
export const INFRA_RATE = 0.02;

export type MarginKey = `${PlanId}/${'month' | 'year'}` | 'none';

export interface MarginSubscription {
  workspaceId: string;
  plan: PlanId;
  interval: 'month' | 'year';
  seats: number;
}

export interface MarginInput {
  /** Subscriptions active in the month (one per workspace: the latest). */
  subscriptions: MarginSubscription[];
  /** Completed top-up checkouts in the month. */
  topUps: { workspaceId: string; amountCents: number }[];
  /** Credits consumed (settled) per workspace in the month. */
  creditsConsumed: { workspaceId: string; credits: number }[];
  /** Agent gateway cost per workspace in the month (D1 `agent_usage`). */
  agentUsd: { workspaceId: string; usd: number }[];
}

export interface MarginRow {
  key: MarginKey;
  workspaces: number;
  revenueUsd: number;
  subscriptionUsd: number;
  topUpUsd: number;
  creditsConsumed: number;
  creditCostUsd: number;
  agentUsd: number;
  cardFeesUsd: number;
  infraUsd: number;
  grossMarginUsd: number;
  /** null without revenue. */
  margin: number | null;
  floor: number;
  belowFloor: boolean;
}

/** Monthly-equivalent subscription price in USD (yearly ÷ 12; Team by seats). */
export function monthlySubscriptionUsd(s: Pick<MarginSubscription, 'plan' | 'interval' | 'seats'>): number {
  const plan = PLANS[s.plan];
  const usd =
    plan.kind === 'team'
      ? teamPriceCents(s.seats, s.interval) / 100
      : ((s.interval === 'month' ? plan.priceMonthlyUsd : plan.priceYearlyUsd) as number);
  return s.interval === 'month' ? usd : usd / 12;
}

/** Gateway cost of consumed credits (credits are priced at 3× gateway cost). */
export function creditCostUsd(credits: number): number {
  return (credits * USD_PER_CREDIT) / MARKUP;
}

export function marginFloor(key: MarginKey): number {
  return key.startsWith('team/') ? 0.6 : 0.5;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeMarginReport(input: MarginInput): MarginRow[] {
  const keyOf = new Map<string, MarginKey>();
  for (const s of input.subscriptions) keyOf.set(s.workspaceId, `${s.plan}/${s.interval}`);
  const acc = new Map<MarginKey, { ws: Set<string>; sub: number; top: number; credits: number; agent: number; charges: number }>();
  const bucket = (ws: string) => {
    const key = keyOf.get(ws) ?? 'none';
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { ws: new Set(), sub: 0, top: 0, credits: 0, agent: 0, charges: 0 }));
    a.ws.add(ws);
    return a;
  };
  for (const s of input.subscriptions) {
    const a = bucket(s.workspaceId);
    a.sub += monthlySubscriptionUsd(s);
    a.charges += s.interval === 'month' ? 1 : 1 / 12;
  }
  for (const t of input.topUps) {
    const a = bucket(t.workspaceId);
    a.top += t.amountCents / 100;
    a.charges += 1;
  }
  for (const c of input.creditsConsumed) bucket(c.workspaceId).credits += c.credits;
  for (const g of input.agentUsd) bucket(g.workspaceId).agent += g.usd;

  const rows: MarginRow[] = [];
  for (const [key, a] of acc) {
    const revenue = a.sub + a.top;
    const creditCost = creditCostUsd(a.credits);
    const fees = revenue * CARD_FEE_RATE + a.charges * CARD_FEE_FIXED_USD;
    const infra = revenue * INFRA_RATE;
    const gross = revenue - creditCost - a.agent - fees - infra;
    const margin = revenue > 0 ? gross / revenue : null;
    const floor = marginFloor(key);
    rows.push({
      key,
      workspaces: a.ws.size,
      revenueUsd: r2(revenue),
      subscriptionUsd: r2(a.sub),
      topUpUsd: r2(a.top),
      creditsConsumed: a.credits,
      creditCostUsd: r2(creditCost),
      agentUsd: Math.round(a.agent * 1e4) / 1e4,
      cardFeesUsd: r2(fees),
      infraUsd: r2(infra),
      grossMarginUsd: r2(gross),
      margin: margin === null ? null : Math.round(margin * 1000) / 1000,
      floor,
      belowFloor: margin !== null ? margin < floor : gross < 0,
    });
  }
  const order = (k: MarginKey) => (k === 'none' ? 99 : Object.keys(PLANS).indexOf(k.split('/')[0]!) * 2 + (k.endsWith('/year') ? 1 : 0));
  return rows.sort((x, y) => order(x.key) - order(y.key));
}
