/** Stripe client and D1 helpers shared by the billing routes, the webhook and BillingWorkflow. */
import { parsePlanLookupKey, parseTeamSeatLookupKey, planLookupKey, StripeClient, idOf, subscriptionPeriod, teamSeatLookupKey, type StripeSubscription } from "@rolling/core/billing";
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
  return priceIdByLookupKey(stripe, planLookupKey(plan, interval));
}

/** The Team per-seat price (D-013), quantity = seats − 1. */
export async function teamSeatPriceId(stripe: StripeClient, interval: PlanInterval): Promise<string> {
  return priceIdByLookupKey(stripe, teamSeatLookupKey(interval));
}

async function priceIdByLookupKey(stripe: StripeClient, key: string): Promise<string> {
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
  /** Members including the owner: Team seat quantity + 1; 1 for personal plans (D-013). */
  seats: number;
  /** Subscription item ids of the base price and the Team seat price (null without one). */
  baseItemId: string;
  seatItemId: string | null;
}

/**
 * Normalizes a Stripe subscription (plan from the price lookup key; times in ms). Null when it is not one of our plans.
 * Team subscriptions carry two items: the base price and the per-seat price with quantity seats − 1.
 */
export function readSubscription(sub: StripeSubscription, workspaceId: string): SubscriptionState | null {
  const items = sub.items?.data ?? [];
  const base = items.find((i) => parsePlanLookupKey(i.price?.lookup_key));
  const seatItem = items.find((i) => parseTeamSeatLookupKey(i.price?.lookup_key)) ?? null;
  const price = base?.price;
  const plan = parsePlanLookupKey(price?.lookup_key);
  const period = subscriptionPeriod({ ...sub, items: { data: base ? [base] : items } });
  if (!plan || !period || !price || !base) return null;
  const seats = plan.planId === "team" ? 1 + Math.max(0, Math.floor(seatItem?.quantity ?? 0)) : 1;
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
    seats,
    baseItemId: base.id,
    seatItemId: seatItem?.id ?? null,
  };
}

export async function upsertSubscription(env: Env, s: SubscriptionState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, stripe_price_id, current_period_start, seats)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (id) DO UPDATE SET plan = excluded.plan, interval = excluded.interval, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at, stripe_price_id = excluded.stripe_price_id, current_period_start = excluded.current_period_start,
       seats = excluded.seats`,
  )
    .bind(s.id, s.workspaceId, s.planId, s.interval, s.status, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, Date.now(), s.priceId, s.periodStart, s.seats)
    .run();
  // D-013: a workspace on Team is a team workspace (its owner's personal workspace converts in place).
  if (s.planId === "team" && (s.status === "active" || s.status === "trialing")) {
    await env.DB.prepare("UPDATE workspaces SET kind = 'team' WHERE id = ? AND kind <> 'team'").bind(s.workspaceId).run();
  }
}

export interface SubscriptionRow {
  id: string;
  plan: PlanId;
  interval: PlanInterval;
  status: string;
  current_period_end: number;
  current_period_start: number | null;
  cancel_at_period_end: number;
  seats: number;
}

/** The workspace's most recent subscription row (any status). */
export async function latestSubscription(env: Env, workspaceId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare(
    "SELECT id, plan, interval, status, current_period_end, current_period_start, cancel_at_period_end, seats FROM subscriptions WHERE workspace_id = ? ORDER BY current_period_end DESC, updated_at DESC LIMIT 1",
  )
    .bind(workspaceId)
    .first<SubscriptionRow>();
}

/** Statuses that keep a plan live (with the period not over). */
export const LIVE_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

export function isLive(sub: SubscriptionRow | null, now = Date.now()): sub is SubscriptionRow {
  return !!sub && LIVE_STATUSES.includes(sub.status) && sub.current_period_end > now;
}

/**
 * Seats in use (D-013): members (owner included) plus pending, unexpired
 * invites, which reserve a seat until accepted, revoked or expired.
 */
export async function seatsInUse(db: D1Database, workspaceId: string, now = Date.now()): Promise<{ members: number; pending: number; used: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1) AS members,
              (SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS pending`,
    )
    .bind(workspaceId, now)
    .first<{ members: number; pending: number }>();
  const members = row?.members ?? 0;
  const pending = row?.pending ?? 0;
  return { members, pending, used: members + pending };
}

export { idOf };
