/**
 * Auto top-up (PRD rule 6, D-006): an off-session Stripe payment for the
 * configured amount, then `CreditAccount.purchase`. Run by BillingWorkflow;
 * the steps are plain functions so they can be tested without the runtime.
 */
import { idOf, StripeError, type StripeClient } from "@rolling/core/billing";
import { quoteTopUp, type PlanId } from "@rolling/core/pricing/config";
import type { AutoTopUpParams } from "../do/CreditAccount";
import { creditAccount, unwrapLedger } from "./credits";
import { latestSubscription, workspaceBilling } from "./stripe";

export type AutoTopUpResult =
  | { status: "credited"; paymentIntentId: string; credits: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; code?: string };

export interface AutoTopUpPlan {
  customerId: string;
  paymentMethodId: string;
  planId: PlanId;
  credits: number;
}

/** Step 1: who to charge, with which card, for how many credits. */
export async function prepareAutoTopUp(env: Env, stripe: StripeClient, p: AutoTopUpParams): Promise<AutoTopUpPlan | { skip: string }> {
  const ws = await workspaceBilling(env, p.workspaceId);
  if (!ws?.stripe_customer_id) return { skip: "no Stripe customer" };
  const sub = await latestSubscription(env, p.workspaceId);
  if (!sub || !["active", "trialing"].includes(sub.status) || sub.current_period_end <= Date.now()) return { skip: "no active plan" };
  const summary = await creditAccount(env, p.workspaceId).summary();
  if (!summary.autoTopUp?.enabled) return { skip: "auto top-up is off" };
  const customer = await stripe.getCustomer(ws.stripe_customer_id);
  let pm = idOf(customer.invoice_settings?.default_payment_method ?? null);
  if (!pm) pm = idOf((await stripe.getSubscription(sub.id)).default_payment_method ?? null);
  if (!pm) return { skip: "no saved payment method" };
  return { customerId: ws.stripe_customer_id, paymentMethodId: pm, planId: sub.plan, credits: quoteTopUp(p.amountCents, sub.plan).credits };
}

/** Step 2: the off-session charge. Idempotent by the workflow instance id. */
export async function chargeAutoTopUp(stripe: StripeClient, p: AutoTopUpParams, plan: AutoTopUpPlan, idempotencyKey: string) {
  try {
    const pi = await stripe.createPaymentIntent(
      {
        amount: p.amountCents,
        currency: "usd",
        customer: plan.customerId,
        payment_method: plan.paymentMethodId,
        off_session: true,
        confirm: true,
        description: "Credits top-up",
        metadata: { kind: "autoTopUp", workspaceId: p.workspaceId, credits: String(plan.credits), plan: plan.planId, amountCents: String(p.amountCents), window: p.window },
      },
      idempotencyKey,
    );
    return pi.status === "succeeded" ? { ok: true as const, paymentIntentId: pi.id } : { ok: false as const, reason: `payment ${pi.status}` };
  } catch (e) {
    // Declines and authentication-required are final for an off-session charge.
    if (e instanceof StripeError && e.status === 402) return { ok: false as const, reason: e.message, code: e.declineCode ?? e.code };
    throw e;
  }
}

/** Step 3: the credits. Same idempotency key as the `payment_intent.succeeded` webhook backup. */
export async function creditAutoTopUp(env: Env, p: AutoTopUpParams, plan: AutoTopUpPlan, paymentIntentId: string) {
  unwrapLedger(await creditAccount(env, p.workspaceId).purchase(plan.credits, paymentIntentId, `topup:${paymentIntentId}`, "auto"));
}
