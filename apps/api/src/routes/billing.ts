/**
 * Account and billing routes (M2, docs/api.md → Account and billing).
 * Handlers stay thin: pricing rules live in `@rolling/core/pricing`, ledger
 * rules in `@rolling/core/credits` (CreditAccount DO), Stripe calls in
 * `../billing/*`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { publicPlanCatalog } from "@rolling/core/billing";
import { quoteTopUp, TOP_UP, TopUpAmountError, AUTO_TOP_UP } from "@rolling/core/pricing/config";
import type { AppEnv } from "../env";
import { billingCaller } from "../billing/context";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { billingSummary, listLedger } from "../billing/read";
import { ensureCustomer, latestSubscription, planPriceId, stripeFor, workspaceBilling } from "../billing/stripe";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

const ReturnTo = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a path on this site");
const Resume = z.object({ runQuoteId: z.string().min(1).max(100) });

export const CheckoutBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    planId: z.enum(["starter", "plus", "pro"]),
    interval: z.enum(["month", "year"]),
    resume: Resume.optional(),
    returnTo: ReturnTo.optional(),
  }),
  z.object({
    kind: z.literal("topUp"),
    amountCents: z.number().int(),
    resume: Resume.optional(),
    returnTo: ReturnTo.optional(),
  }),
]);

const PortalBody = z.object({ returnTo: ReturnTo.optional() }).default({});

const AutoTopUpBody = z.object({
  enabled: z.boolean(),
  thresholdCredits: z.number().int().min(0).max(1_000_000).default(AUTO_TOP_UP.belowCredits),
  amountCents: z.number().int().default(AUTO_TOP_UP.amountUsd * 100),
});

const LedgerQuery = z.object({
  first: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().max(200).optional(),
});

const DEFAULT_RETURN = "/settings/billing";

function appUrl(env: Env, path: string, query: string): string {
  const base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function amountError(e: unknown): never {
  if (e instanceof TopUpAmountError) {
    throw new ApiError(400, "VALIDATION_FAILED", e.message, { field: "amountCents", minCents: TOP_UP.minUsd * 100, maxCents: TOP_UP.maxUsd * 100 });
  }
  throw e;
}

export const billing = new Hono<AppEnv>()
  /** Plans, top-up rules and the caller's current plan (public; `current` only when signed in). */
  .get("/plans", async (c) => {
    const auth = c.get("auth");
    return c.json({ ...publicPlanCatalog(), current: auth ? { plan: auth.plan, isMember: auth.isMember } : null });
  })

  /** Plan, status, renewal, balance split and auto top-up of the current workspace. */
  .get("/", async (c) => {
    const who = await billingCaller(c);
    return c.json(await billingSummary(c.env, who.workspaceId));
  })

  .post("/checkout", validate("json", CheckoutBody), async (c) => {
    const body = c.req.valid("json");
    const who = await billingCaller(c, body.kind === "plan" ? "owner" : "editor");
    const returnTo = body.returnTo ?? DEFAULT_RETURN;
    const success_url = appUrl(c.env, returnTo, "checkout=success&session_id={CHECKOUT_SESSION_ID}");
    const cancel_url = appUrl(c.env, returnTo, "checkout=canceled");
    const resumeQuoteId = body.resume?.runQuoteId;
    const now = Date.now();

    if (body.kind === "plan") {
      const sub = await latestSubscription(c.env, who.workspaceId);
      if (who.isMember || (sub && ["active", "trialing", "past_due"].includes(sub.status) && sub.current_period_end > now)) {
        throw new ApiError(409, "CONFLICT", "This workspace already has a plan; change it in the billing portal", { reason: "already_subscribed" });
      }
      const stripe = stripeFor(c.env);
      const price = await planPriceId(stripe, body.planId, body.interval);
      const customer = await ensureCustomer(c.env, stripe, who.workspaceId, who.email);
      const session = await stripe.createCheckoutSession({
        mode: "subscription",
        customer,
        client_reference_id: who.workspaceId,
        line_items: [{ price, quantity: 1 }],
        success_url,
        cancel_url,
        metadata: { kind: "plan", workspaceId: who.workspaceId, userId: who.userId, planId: body.planId, interval: body.interval, resumeQuoteId },
        subscription_data: { metadata: { workspaceId: who.workspaceId, planId: body.planId, interval: body.interval } },
      });
      await c.env.DB.prepare(
        "INSERT INTO checkout_sessions (id, workspace_id, user_id, kind, plan, interval, resume_quote_id, status, created_at) VALUES (?, ?, ?, 'plan', ?, ?, ?, 'open', ?)",
      )
        .bind(session.id, who.workspaceId, who.userId, body.planId, body.interval, resumeQuoteId ?? null, now)
        .run();
      return c.json({ url: session.url, sessionId: session.id });
    }

    // Top-ups are sold only to members (D-007).
    if (!who.isMember || !who.plan) throw new ApiError(402, "NO_PLAN", "An active plan is required to buy credits", { workspaceId: who.workspaceId });
    let quote;
    try {
      quote = quoteTopUp(body.amountCents, who.plan);
    } catch (e) {
      amountError(e);
    }
    const stripe = stripeFor(c.env);
    const customer = await ensureCustomer(c.env, stripe, who.workspaceId, who.email);
    const metadata = {
      kind: "topUp",
      workspaceId: who.workspaceId,
      userId: who.userId,
      plan: who.plan,
      amountCents: String(quote.amountCents),
      credits: String(quote.credits),
      resumeQuoteId,
    };
    const session = await stripe.createCheckoutSession({
      mode: "payment",
      customer,
      client_reference_id: who.workspaceId,
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "usd", unit_amount: quote.amountCents, product_data: { name: `${quote.credits.toLocaleString("en-US")} credits` } },
        },
      ],
      // Saves the card for auto top-ups (off-session).
      payment_intent_data: { setup_future_usage: "off_session", metadata: { kind: "topUp", workspaceId: who.workspaceId } },
      invoice_creation: { enabled: true },
      success_url,
      cancel_url,
      metadata,
    });
    await c.env.DB.prepare(
      "INSERT INTO checkout_sessions (id, workspace_id, user_id, kind, amount_cents, credits, resume_quote_id, status, created_at) VALUES (?, ?, ?, 'topUp', ?, ?, ?, 'open', ?)",
    )
      .bind(session.id, who.workspaceId, who.userId, quote.amountCents, quote.credits, resumeQuoteId ?? null, now)
      .run();
    return c.json({ url: session.url, sessionId: session.id, credits: quote.credits });
  })

  /** Outcome of a checkout for the return page; `resume` lets the client continue the pending run. */
  .get("/checkout/:sessionId", async (c) => {
    const who = await billingCaller(c);
    const row = await c.env.DB.prepare(
      "SELECT id, kind, plan, interval, amount_cents, credits, resume_quote_id, status, completed_at FROM checkout_sessions WHERE id = ? AND workspace_id = ?",
    )
      .bind(c.req.param("sessionId"), who.workspaceId)
      .first<{ id: string; kind: "plan" | "topUp"; plan: string | null; interval: string | null; amount_cents: number | null; credits: number | null; resume_quote_id: string | null; status: string; completed_at: number | null }>();
    if (!row) throw new ApiError(404, "NOT_FOUND", "Checkout not found");
    return c.json({
      sessionId: row.id,
      kind: row.kind,
      status: row.status,
      planId: row.plan,
      interval: row.interval,
      amountCents: row.amount_cents,
      credits: row.credits,
      completedAt: row.completed_at,
      resume: row.resume_quote_id ? { runQuoteId: row.resume_quote_id } : null,
    });
  })

  .post("/portal", validate("json", PortalBody), async (c) => {
    const who = await billingCaller(c, "owner");
    const ws = await workspaceBilling(c.env, who.workspaceId);
    if (!ws?.stripe_customer_id) throw new ApiError(402, "NO_PLAN", "No billing account yet", { workspaceId: who.workspaceId });
    const stripe = stripeFor(c.env);
    const session = await stripe.createPortalSession({
      customer: ws.stripe_customer_id,
      return_url: appUrl(c.env, c.req.valid("json").returnTo ?? DEFAULT_RETURN, "portal=returned"),
    });
    return c.json({ url: session.url });
  })

  .patch("/auto-topup", validate("json", AutoTopUpBody), async (c) => {
    const body = c.req.valid("json");
    const who = await billingCaller(c, "owner");
    if (body.enabled && !who.isMember) throw new ApiError(402, "NO_PLAN", "An active plan is required for auto top-up", { workspaceId: who.workspaceId });
    try {
      quoteTopUp(body.amountCents, who.plan ?? "starter");
    } catch (e) {
      amountError(e);
    }
    const autoTopUp = unwrapLedger(await creditAccount(c.env, who.workspaceId).setAutoTopUp(body));
    return c.json({ autoTopUp });
  })

  .get("/ledger", validate("query", LedgerQuery), async (c) => {
    const who = await billingCaller(c);
    const q = c.req.valid("query");
    return c.json(await listLedger(c.env, who.workspaceId, q.first, q.after ?? null));
  })

  /** Stripe invoices (plans and top-ups) of the workspace, newest first. */
  .get("/invoices", async (c) => {
    const who = await billingCaller(c, "owner");
    const ws = await workspaceBilling(c.env, who.workspaceId);
    if (!ws?.stripe_customer_id) return c.json({ invoices: [] });
    const list = await stripeFor(c.env).request<{ data: Record<string, unknown>[] }>("GET", "/v1/invoices", { customer: ws.stripe_customer_id, limit: 24 });
    return c.json({
      invoices: list.data.map((i) => ({
        id: i.id,
        number: i.number ?? null,
        createdAt: Number(i.created) * 1000,
        amountCents: i.amount_paid ?? i.total ?? 0,
        currency: String(i.currency ?? "usd").toUpperCase(),
        status: i.status,
        url: i.hosted_invoice_url ?? null,
        pdfUrl: i.invoice_pdf ?? null,
      })),
    });
  });
