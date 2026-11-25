/**
 * Stripe webhook effects. Each handler re-reads the object it needs from
 * Stripe where ordering matters (subscriptions), so out-of-order deliveries
 * converge on Stripe's current state. Every effect is idempotent on its own
 * (D1 upserts, CreditAccount idempotency keys), and `stripe_events` skips
 * events that were processed already.
 */
import {
  idOf,
  invoiceSubscriptionId,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeEvent,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeSubscription,
} from "@rolling/core/billing";
import { PLAN_ORDER, quoteTopUp, type PlanId } from "@rolling/core/pricing/config";
import { creditAccount, unwrapLedger } from "./credits";
import { readSubscription, upsertSubscription, workspaceForCustomer, type SubscriptionState } from "./stripe";

export type WebhookOutcome = { handled: boolean; note?: string };

const log = (msg: string, data: Record<string, unknown>) => console.log(JSON.stringify({ msg: `stripe: ${msg}`, ...data }));

/** Fetches the subscription, resolves its workspace and stores it in D1. */
async function syncSubscription(env: Env, stripe: StripeClient, subscriptionId: string, hintWorkspace?: string | null): Promise<SubscriptionState | null> {
  const sub = await stripe.getSubscription(subscriptionId);
  const workspaceId = await workspaceForCustomer(env, idOf(sub.customer), hintWorkspace ?? sub.metadata?.workspaceId ?? null);
  if (!workspaceId) {
    log("subscription without workspace", { subscriptionId });
    return null;
  }
  const state = readSubscription(sub as StripeSubscription, workspaceId);
  if (!state) {
    log("subscription is not a Rolling plan", { subscriptionId });
    return null;
  }
  await upsertSubscription(env, state);
  return state;
}

async function completeCheckoutRow(env: Env, sessionId: string, credits: number | null): Promise<void> {
  await env.DB.prepare("UPDATE checkout_sessions SET status = 'complete', completed_at = COALESCE(completed_at, ?), credits = COALESCE(?, credits) WHERE id = ?")
    .bind(Date.now(), credits, sessionId)
    .run();
}

/** Credits for a paid top-up checkout, re-verified against the amount actually paid. */
async function creditTopUp(env: Env, session: StripeCheckoutSession): Promise<WebhookOutcome> {
  const md = session.metadata ?? {};
  const workspaceId = md.workspaceId;
  const plan = md.plan as PlanId | undefined;
  const pi = idOf(session.payment_intent);
  if (!workspaceId || !plan || !PLAN_ORDER.includes(plan) || !pi) return { handled: false, note: "top-up metadata incomplete" };
  if (session.payment_status !== "paid") return { handled: false, note: "not paid yet" };
  const amount = session.amount_total ?? -1;
  if ((session.currency ?? "").toLowerCase() !== "usd" || String(amount) !== md.amountCents) {
    log("top-up amount mismatch", { sessionId: session.id, amount, expected: md.amountCents });
    return { handled: false, note: "amount mismatch" };
  }
  const credits = quoteTopUp(amount, plan).credits;
  if (String(credits) !== md.credits) log("top-up credits differ from checkout metadata", { sessionId: session.id, credits, metadata: md.credits });
  unwrapLedger(await creditAccount(env, workspaceId).purchase(credits, pi, `topup:${pi}`, "checkout"));
  await completeCheckoutRow(env, session.id, credits);
  return { handled: true };
}

async function onCheckoutCompleted(env: Env, stripe: StripeClient, session: StripeCheckoutSession): Promise<WebhookOutcome> {
  const md = session.metadata ?? {};
  if (session.mode === "subscription") {
    const subId = idOf(session.subscription);
    if (!subId) return { handled: false, note: "no subscription" };
    await workspaceForCustomer(env, idOf(session.customer), md.workspaceId ?? null);
    const state = await syncSubscription(env, stripe, subId, md.workspaceId ?? null);
    await completeCheckoutRow(env, session.id, null);
    return { handled: !!state };
  }
  if (session.mode === "payment" && md.kind === "topUp") return creditTopUp(env, session);
  return { handled: false, note: "not a Rolling checkout" };
}

function maxLinePeriod(inv: StripeInvoice): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const l of inv.lines?.data ?? []) if (l.period && (!best || l.period.end > best.end)) best = l.period;
  return best;
}

/**
 * `invoice.paid`: plan credits for the period. Renewals and first invoices grant
 * the invoice's period (an old invoice delivered late is skipped by the ledger as
 * stale); a paid upgrade mid-period grants the new plan for the current period;
 * other plan changes only update limits.
 */
async function onInvoicePaid(env: Env, stripe: StripeClient, inv: StripeInvoice): Promise<WebhookOutcome> {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return { handled: false, note: "not a subscription invoice" };
  const state = await syncSubscription(env, stripe, subId);
  if (!state) return { handled: false, note: "unknown subscription" };
  const account = creditAccount(env, state.workspaceId);
  if (inv.billing_reason === "subscription_update") {
    // Compare with the plan the current slice was granted for: `customer.subscription.updated`
    // may already have moved the limits to the new plan.
    const current = (await account.summary()).grantedPlanId;
    const upgraded = current === null || PLAN_ORDER.indexOf(state.planId) > PLAN_ORDER.indexOf(current);
    if (!upgraded || (inv.amount_paid ?? 0) <= 0) {
      unwrapLedger(await account.setPlan(state.planId));
      // D-013: a paid Team seat change grants the prorated credits of added seats (once per slice).
      unwrapLedger(await account.setSeats(state.seats, `seats:${inv.id}`));
      return { handled: true, note: "plan limits updated" };
    }
    unwrapLedger(
      await account.grant({ planId: state.planId, interval: state.interval, start: state.periodStart, end: state.periodEnd, seats: state.seats }, `grant:${inv.id}`),
    );
    return { handled: true };
  }
  const line = maxLinePeriod(inv);
  const period = line ? { start: line.start * 1000, end: line.end * 1000 } : { start: state.periodStart, end: state.periodEnd };
  unwrapLedger(await account.grant({ planId: state.planId, interval: state.interval, ...period, seats: state.seats }, `grant:${inv.id}`));
  return { handled: true };
}

async function onSubscriptionChanged(env: Env, stripe: StripeClient, sub: StripeSubscription, deleted: boolean, eventId: string): Promise<WebhookOutcome> {
  const state = await syncSubscription(env, stripe, sub.id);
  if (!state) return { handled: false, note: "unknown subscription" };
  const account = creditAccount(env, state.workspaceId);
  if (deleted || state.status === "canceled" || state.status === "incomplete_expired") {
    // A late event for an old subscription must not end a newer one.
    const other = await env.DB.prepare(
      "SELECT id FROM subscriptions WHERE workspace_id = ? AND id <> ? AND status IN ('active','trialing') AND current_period_end > ? LIMIT 1",
    )
      .bind(state.workspaceId, sub.id, Date.now())
      .first();
    if (other) return { handled: true, note: "another subscription is active" };
    unwrapLedger(await account.cancelPlan(`cancel:${sub.id}`));
  } else if (state.status === "active" || state.status === "trialing") {
    unwrapLedger(await account.setPlan(state.planId));
    // D-013: seat quantity changes; idempotent per event, added seats are granted once per slice.
    unwrapLedger(await account.setSeats(state.seats, `seats:${eventId}`));
  }
  return { handled: true };
}

async function onPaymentFailed(env: Env, stripe: StripeClient, inv: StripeInvoice): Promise<WebhookOutcome> {
  const subId = invoiceSubscriptionId(inv);
  const state = subId ? await syncSubscription(env, stripe, subId) : null;
  const workspaceId = state?.workspaceId ?? (await workspaceForCustomer(env, idOf(inv.customer)));
  if (!workspaceId) return { handled: false, note: "unknown customer" };
  const owner = await env.DB.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' LIMIT 1")
    .bind(workspaceId)
    .first<{ user_id: string }>();
  if (owner) await env.NOTIFY_EMAIL_QUEUE.send({ userId: owner.user_id, template: "billing.payment_failed", data: { workspaceId, invoiceId: inv.id } });
  return { handled: true };
}

/** Backup for auto top-ups: credits land even if BillingWorkflow stopped after charging. */
async function onPaymentIntentSucceeded(env: Env, pi: StripePaymentIntent): Promise<WebhookOutcome> {
  const md = pi.metadata ?? {};
  if (md.kind !== "autoTopUp" || !md.workspaceId || !md.credits) return { handled: false, note: "not an auto top-up" };
  unwrapLedger(await creditAccount(env, md.workspaceId).purchase(Number(md.credits), pi.id, `topup:${pi.id}`, "auto"));
  return { handled: true };
}

export async function handleStripeEvent(env: Env, stripe: StripeClient, event: StripeEvent): Promise<WebhookOutcome> {
  const obj = event.data.object as never;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return onCheckoutCompleted(env, stripe, obj);
    case "checkout.session.expired":
      await env.DB.prepare("UPDATE checkout_sessions SET status = 'expired' WHERE id = ? AND status = 'open'").bind((obj as StripeCheckoutSession).id).run();
      return { handled: true };
    case "invoice.paid":
      return onInvoicePaid(env, stripe, obj);
    case "invoice.payment_failed":
      return onPaymentFailed(env, stripe, obj);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return onSubscriptionChanged(env, stripe, obj, false, event.id);
    case "customer.subscription.deleted":
      return onSubscriptionChanged(env, stripe, obj, true, event.id);
    case "payment_intent.succeeded":
      return onPaymentIntentSucceeded(env, obj);
    default:
      return { handled: false, note: "ignored" };
  }
}
