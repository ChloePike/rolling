import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { chargeAutoTopUp, creditAutoTopUp, prepareAutoTopUp, type AutoTopUpResult } from "../billing/autoTopUp";
import { stripeConfigured, stripeFor } from "../billing/stripe";
import type { AutoTopUpParams } from "../do/CreditAccount";

export type BillingWorkflowParams = AutoTopUpParams;

/**
 * Off-session billing. Today: auto top-up, started by CreditAccount after a
 * commit leaves the balance below the threshold (one instance per window, so
 * the instance id is the payment idempotency key). Period grants and expiry
 * are driven by `invoice.paid` and the CreditAccount alarm, not by this workflow.
 */
export class BillingWorkflow extends WorkflowEntrypoint<Env, BillingWorkflowParams> {
  override async run(event: WorkflowEvent<BillingWorkflowParams>, step: WorkflowStep): Promise<AutoTopUpResult> {
    const p = event.payload;
    if (p?.kind !== "autoTopUp") return { status: "skipped", reason: "unknown kind" };
    if (!stripeConfigured(this.env)) return { status: "skipped", reason: "payments are not configured" };
    const stripe = stripeFor(this.env);

    const plan = await step.do("prepare", async () => prepareAutoTopUp(this.env, stripe, p));
    if ("skip" in plan) return { status: "skipped", reason: plan.skip };

    const charge = await step.do("charge", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () =>
      chargeAutoTopUp(stripe, p, plan, `autotopup:${event.instanceId}`),
    );
    if (!charge.ok) {
      console.warn(JSON.stringify({ msg: "auto top-up declined", workspaceId: p.workspaceId, reason: charge.reason }));
      return { status: "failed", reason: charge.reason, code: "code" in charge ? charge.code : undefined };
    }

    await step.do("credit", async () => creditAutoTopUp(this.env, p, plan, charge.paymentIntentId));
    return { status: "credited", paymentIntentId: charge.paymentIntentId, credits: plan.credits };
  }
}
