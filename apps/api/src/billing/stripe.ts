/** Stripe client and D1 helpers shared by the billing routes, the webhook and BillingWorkflow. */
import { parsePlanLookupKey, planLookupKey, StripeClient, idOf, subscriptionPeriod, type StripeSubscription } from "@rolling/core/billing";
import type { PlanInterval } from "@rolling/core/credits";
import type { PlanId } from "@rolling/core/pricing/config";
import { ApiError } from "../lib/errors";

export function stripeConfigured(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

export function stripeFor(env: Env): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, "INTERNAL", "Payments are not configured");
  return new StripeClient({ secretKey: env.STRIPE_SECRET_KEY, apiVersion: env.STRIPE_API_VERSION || undefined, baseUrl: env.STRIPE_API_BASE || undefined });
}

/** Price ids by lookup key, cached per isolate for 10 minutes. */
const priceCache = new Map<string, { id: string; at: number }>();
const PRICE_TTL_MS = 10 * 60 * 1000;

export async function planPriceId(stripe: StripeClient, plan: PlanId, interval: PlanInterval): Promise<string> {
  const key = planLookupKey(plan, interval);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.id;
  const list = await stripe.listPricesByLookupKeys([key]);
  const price = list.data.find((p) => p.lookup_key === key && p.active);
  if (!price) throw new ApiError(503, "INTERNAL", "Plan price is not set up in Stripe", { lookupKey: key });
  priceCache.set(key, { id: price.id, at: Date.now() });
  return price.id;
}

export function clearPriceCache(): void {
  priceCache.clear();
}

export interface WorkspaceBilling {
  id: string;
  stripe_customer_id: string | null;
}

export async function workspaceBilling(env: Env, workspaceId: string): Promise<WorkspaceBilling | null> {
  return env.DB.prepare("SELECT id, stripe_customer_id FROM workspaces WHERE id = ?").bind(workspaceId).first<WorkspaceBilling>();
}

/** The workspace's Stripe customer, created on first checkout (idempotent per workspace). */
export async function ensureCustomer(env: Env, stripe: StripeClient, workspaceId: string, email: string | null): Promise<string> {
  const ws = await workspaceBilling(env, workspaceId);
  if (!ws) throw new ApiError(404, "NOT_FOUND", "Workspace not found", { workspaceId });
  if (ws.stripe_customer_id) return ws.stripe_customer_id;
  const customer = await stripe.createCustomer({ email: email ?? undefined, metadata: { workspaceId } }, `customer:${workspaceId}`);
  await env.DB.prepare("UPDATE workspaces SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customer.id, workspaceId).run();
  const after = await workspaceBilling(env, workspaceId);
  return after?.stripe_customer_id ?? customer.id;
}

export async function workspaceForCustomer(env: Env, customerId: string | null, fallback?: string | null): Promise<string | null> {
  if (customerId) {
    const row = await env.DB.prepare("SELECT id FROM workspaces WHERE stripe_customer_id = ?").bind(customerId).first<{ id: string }>();
    if (row) return row.id;
  }
  if (fallback) {
    const row = await env.DB.prepare("SELECT id, stripe_customer_id FROM workspaces WHERE id = ?").bind(fallback).first<WorkspaceBilling>();
    if (row) {
      if (!row.stripe_customer_id && customerId) {
        await env.DB.prepare("UPDATE workspaces SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customerId, row.id).run();
      }
      return row.id;
    }
  }
  return null;
}

export interface SubscriptionState {
  id: string;
  workspaceId: string;
  planId: PlanId;
  interval: PlanInterval;
  status: string;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  priceId: string;
}

/** Normalizes a Stripe subscription (plan from the price lookup key; times in ms). Null when it is not one of our plans. */
export function readSubscription(sub: StripeSubscription, workspaceId: string): SubscriptionState | null {
  const price = sub.items?.data?.[0]?.price;
  const plan = parsePlanLookupKey(price?.lookup_key);
  const period = subscriptionPeriod(sub);
  if (!plan || !period || !price) return null;
  return {
    id: sub.id,
    workspaceId,
    planId: plan.planId,
    interval: plan.interval,
    status: sub.status,
    periodStart: period.start * 1000,
    periodEnd: period.end * 1000,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    priceId: price.id,
  };
}

export async function upsertSubscription(env: Env, s: SubscriptionState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, stripe_price_id, current_period_start)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (id) DO UPDATE SET plan = excluded.plan, interval = excluded.interval, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at, stripe_price_id = excluded.stripe_price_id, current_period_start = excluded.current_period_start`,
  )
    .bind(s.id, s.workspaceId, s.planId, s.interval, s.status, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, Date.now(), s.priceId, s.periodStart)
    .run();
}

export interface SubscriptionRow {
  id: string;
  plan: PlanId;
  interval: PlanInterval;
  status: string;
  current_period_end: number;
  current_period_start: number | null;
  cancel_at_period_end: number;
}

/** The workspace's most recent subscription row (any status). */
export async function latestSubscription(env: Env, workspaceId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare(
    "SELECT id, plan, interval, status, current_period_end, current_period_start, cancel_at_period_end FROM subscriptions WHERE workspace_id = ? ORDER BY current_period_end DESC, updated_at DESC LIMIT 1",
  )
    .bind(workspaceId)
    .first<SubscriptionRow>();
}

export { idOf };
