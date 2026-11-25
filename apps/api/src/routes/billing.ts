/**
 * Account and billing routes (M2, docs/api.md → Account and billing).
 * Handlers stay thin: pricing rules live in `@rolling/core/pricing`, ledger
 * rules in `@rolling/core/credits` (CreditAccount DO), Stripe calls in
 * `../billing/*`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { publicPlanCatalog } from "@rolling/core/billing";
import { prorate, quoteTopUp, SEAT_PRICE, TEAM_SEATS, teamPriceCents, TOP_UP, TopUpAmountError, AUTO_TOP_UP } from "@rolling/core/pricing/config";
import { teamSeatPriceCents } from "@rolling/core/billing";
import type { AppEnv } from "../env";
import { billingCaller } from "../billing/context";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { billingSummary, listLedger } from "../billing/read";
import { ensureCustomer, idOf, isLive, latestSubscription, planPriceId, readSubscription, seatsInUse, stripeFor, teamSeatPriceId, upsertSubscription, workspaceBilling } from "../billing/stripe";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

const ReturnTo = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a path on this site");
const Resume = z.object({ runQuoteId: z.string().min(1).max(100) });

const Seats = z.number().int().min(TEAM_SEATS.min).max(TEAM_SEATS.max);

export const CheckoutBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    planId: z.enum(["starter", "plus", "pro", "team"]),
    interval: z.enum(["month", "year"]),
    /** Team only (D-013): members including the owner; default 1. */
    seats: Seats.optional(),
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

const SeatsBody = z.object({ seats: Seats }).strict();
const SeatsQuery = z.object({ seats: z.coerce.number().pipe(Seats) });

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
      const team = body.planId === "team";
      if (!team && body.seats !== undefined && body.seats !== 1) {
        throw new ApiError(400, "VALIDATION_FAILED", "Only Team has more than one seat", { field: "seats", planId: body.planId });
      }
      const seats = team ? (body.seats ?? 1) : 1;
      if (team) {
        // Seats cover everyone already in the workspace (members + pending invites).
        const inUse = await seatsInUse(c.env.DB, who.workspaceId, now);
        if (seats < inUse.used) throw new ApiError(402, "SEATS_REQUIRED", "Choose a seat for everyone in the workspace", { seats, used: inUse.used, needed: inUse.used });
      }
      const sub = await latestSubscription(c.env, who.workspaceId);
      const live = who.isMember || isLive(sub, now);
      if (live && team && sub && isLive(sub, now) && sub.plan !== "team") {
        // Personal plan → Team: the subscription switches in place and the workspace becomes a team workspace (D-013).
        return c.json(await switchToTeam(c.env, sub.id, body.interval, seats, who.workspaceId));
      }
      if (live) {
        throw new ApiError(409, "CONFLICT", team ? "This workspace is on Team already; change seats instead" : "This workspace already has a plan; change it in the billing portal", {
          reason: "already_subscribed",
        });
      }
      const stripe = stripeFor(c.env);
      const price = await planPriceId(stripe, body.planId, body.interval);
      const line_items: { price: string; quantity: number }[] = [{ price, quantity: 1 }];
      if (team && seats > 1) line_items.push({ price: await teamSeatPriceId(stripe, body.interval), quantity: seats - 1 });
      const customer = await ensureCustomer(c.env, stripe, who.workspaceId, who.email);
      const planMeta = { workspaceId: who.workspaceId, planId: body.planId, interval: body.interval, seats: team ? String(seats) : undefined };
      const session = await stripe.createCheckoutSession({
        mode: "subscription",
        customer,
        client_reference_id: who.workspaceId,
        line_items,
        success_url,
        cancel_url,
        metadata: { kind: "plan", userId: who.userId, resumeQuoteId, ...planMeta },
        subscription_data: { metadata: planMeta },
      });
      await c.env.DB.prepare(
        "INSERT INTO checkout_sessions (id, workspace_id, user_id, kind, plan, interval, resume_quote_id, status, created_at, seats) VALUES (?, ?, ?, 'plan', ?, ?, ?, 'open', ?, ?)",
      )
        .bind(session.id, who.workspaceId, who.userId, body.planId, body.interval, resumeQuoteId ?? null, now, team ? seats : null)
        .run();
      return c.json({ url: session.url, sessionId: session.id, ...(team ? { seats, amountCents: teamPriceCents(seats, body.interval) } : {}) });
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
      "SELECT id, kind, plan, interval, amount_cents, credits, resume_quote_id, status, completed_at, seats FROM checkout_sessions WHERE id = ? AND workspace_id = ?",
    )
      .bind(c.req.param("sessionId"), who.workspaceId)
      .first<{ id: string; kind: "plan" | "topUp"; plan: string | null; interval: string | null; amount_cents: number | null; credits: number | null; resume_quote_id: string | null; status: string; completed_at: number | null; seats: number | null }>();
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
      seats: row.seats,
      resume: row.resume_quote_id ? { runQuoteId: row.resume_quote_id } : null,
    });
  })

  /**
   * Estimate for changing Team seats (D-013): the prorated charge now for added
   * seats (Stripe invoices the exact amount) and the next renewal price.
   */
  .get("/seats/preview", validate("query", SeatsQuery), async (c) => {
    const who = await billingCaller(c, "owner");
    const { seats } = c.req.valid("query");
    const { sub } = await liveTeam(c.env, who.workspaceId, who.plan);
    const now = Date.now();
    const current = Math.max(1, sub.seats ?? 1);
    const added = Math.max(0, seats - current);
    const start = sub.current_period_start ?? now;
    return c.json({
      seats,
      current,
      used: (await seatsInUse(c.env.DB, who.workspaceId, now)).used,
      interval: sub.interval,
      prorationCents: prorate(added * teamSeatPriceCents(sub.interval), start, sub.current_period_end, now),
      renewalCents: teamPriceCents(seats, sub.interval),
      periodEnd: sub.current_period_end,
      addedMonthlyCredits: added * SEAT_PRICE.monthlyCredits,
    });
  })

  /**
   * Changes Team seats (D-013). Increases are charged now (prorated,
   * `always_invoice`, applied only once paid) and grant the prorated credits of
   * the added seats; decreases take effect now without a refund
   * (`proration_behavior: none`): the next invoice charges the lower count.
   * Lowering below the seats in use (members + pending invites) is refused.
   */
  .patch("/seats", validate("json", SeatsBody), async (c) => {
    const who = await billingCaller(c, "owner");
    const { seats } = c.req.valid("json");
    const { sub } = await liveTeam(c.env, who.workspaceId, who.plan);
    const now = Date.now();
    const inUse = await seatsInUse(c.env.DB, who.workspaceId, now);
    const current = Math.max(1, sub.seats ?? 1);
    if (seats < inUse.used) {
      throw new ApiError(409, "SEATS_IN_USE", "Remove members or revoke invites before lowering seats", { seats, used: inUse.used });
    }
    if (seats === current) return c.json({ seats: { purchased: current, used: inUse.used }, granted: 0, changed: false });
    const stripe = stripeFor(c.env);
    const state = readSubscription(await stripe.getSubscription(sub.id), who.workspaceId);
    if (!state || state.planId !== "team") throw new ApiError(402, "TEAM_REQUIRED", "Seats are part of the Team plan", { currentPlan: state?.planId ?? who.plan });
    const increase = seats > state.seats;
    const items: Record<string, string | number | boolean>[] = [];
    if (state.seatItemId) items.push(seats > 1 ? { id: state.seatItemId, quantity: seats - 1 } : { id: state.seatItemId, deleted: true });
    else if (seats > 1) items.push({ price: await teamSeatPriceId(stripe, state.interval), quantity: seats - 1 });
    const idem = c.req.header("idempotency-key")?.slice(0, 100) || `seats:${sub.id}:${state.seats}->${seats}:${state.periodStart}`;
    const updated = await stripe.updateSubscription(
      sub.id,
      {
        items,
        proration_behavior: increase ? "always_invoice" : "none",
        payment_behavior: increase ? "pending_if_incomplete" : undefined,
        metadata: { workspaceId: who.workspaceId, planId: "team", interval: state.interval, seats: String(seats) },
      },
      idem,
    );
    if (updated.pending_update) {
      throw new ApiError(402, "PAYMENT_FAILED", "The payment for the added seats did not go through", { seats, current: state.seats });
    }
    const next = readSubscription(updated, who.workspaceId);
    if (!next) throw new ApiError(500, "INTERNAL", "Unexpected subscription after the seat change");
    await upsertSubscription(c.env, next);
    // Webhooks apply the same change again; the ledger grants added seats once per slice.
    const result = unwrapLedger(await creditAccount(c.env, who.workspaceId).setSeats(next.seats, `seats:patch:${idem}`));
    return c.json({ seats: { purchased: next.seats, used: inUse.used }, granted: result.granted, changed: true, balance: result.balance });
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

  /**
   * The card on file (owner): the customer's default payment method, else the
   * live subscription's. `{ paymentMethod: null }` without a customer or card.
   * Changes go through the billing portal.
   */
  .get("/payment-method", async (c) => {
    const who = await billingCaller(c, "owner");
    const ws = await workspaceBilling(c.env, who.workspaceId);
    c.header("cache-control", "private, no-store");
    if (!ws?.stripe_customer_id) return c.json({ paymentMethod: null });
    const stripe = stripeFor(c.env);
    const customer = await stripe.request<{ invoice_settings?: { default_payment_method?: string | { id: string } | null } }>("GET", `/v1/customers/${encodeURIComponent(ws.stripe_customer_id)}`);
    let pmId = idOf(customer.invoice_settings?.default_payment_method ?? null);
    if (!pmId) {
      const sub = await latestSubscription(c.env, who.workspaceId);
      if (isLive(sub)) pmId = idOf((await stripe.getSubscription(sub.id)).default_payment_method ?? null);
    }
    if (!pmId) return c.json({ paymentMethod: null });
    const pm = await stripe.request<{ id: string; type: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number; wallet?: { type?: string } | null } }>(
      "GET",
      `/v1/payment_methods/${encodeURIComponent(pmId)}`,
    );
    if (!pm.card) return c.json({ paymentMethod: { id: pm.id, type: pm.type, brand: null, last4: null, expMonth: null, expYear: null, wallet: null } });
    return c.json({
      paymentMethod: {
        id: pm.id,
        type: pm.type,
        brand: pm.card.brand ?? null,
        last4: pm.card.last4 ?? null,
        expMonth: pm.card.exp_month ?? null,
        expYear: pm.card.exp_year ?? null,
        wallet: pm.card.wallet?.type ?? null,
      },
    });
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

/** The workspace's live Team subscription, or `402 TEAM_REQUIRED { currentPlan }`. */
async function liveTeam(env: Env, workspaceId: string, plan: string | null) {
  const sub = await latestSubscription(env, workspaceId);
  if (!isLive(sub) || sub.plan !== "team") throw new ApiError(402, "TEAM_REQUIRED", "Seats are part of the Team plan", { currentPlan: plan });
  return { sub };
}

/**
 * Switches a live personal subscription to Team in place (D-013): the base item
 * moves to the Team price and the seat item is added; charged now (prorated)
 * and applied only once paid. `invoice.paid` (subscription_update) then grants
 * Team credits for the seats, and the workspace becomes a team workspace.
 */
async function switchToTeam(env: Env, subscriptionId: string, interval: "month" | "year", seats: number, workspaceId: string) {
  const stripe = stripeFor(env);
  const state = readSubscription(await stripe.getSubscription(subscriptionId), workspaceId);
  if (!state) throw new ApiError(409, "CONFLICT", "This subscription cannot be switched here; use the billing portal", { reason: "unknown_subscription" });
  const items: Record<string, string | number | boolean>[] = [{ id: state.baseItemId, price: await planPriceId(stripe, "team", interval) }];
  if (seats > 1) items.push({ price: await teamSeatPriceId(stripe, interval), quantity: seats - 1 });
  const updated = await stripe.updateSubscription(
    subscriptionId,
    {
      items,
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      metadata: { workspaceId, planId: "team", interval, seats: String(seats) },
    },
    `switch-team:${subscriptionId}:${interval}:${seats}:${state.periodStart}`,
  );
  if (updated.pending_update) throw new ApiError(402, "PAYMENT_FAILED", "The payment for Team did not go through", { seats });
  const next = readSubscription(updated, workspaceId);
  if (next) {
    await upsertSubscription(env, next);
    // Limits now; credits come with the paid invoice (invoice.paid).
    unwrapLedger(await creditAccount(env, workspaceId).setPlan("team"));
    unwrapLedger(await creditAccount(env, workspaceId).setSeats(next.seats, `seats:switch:${subscriptionId}:${next.seats}:${next.periodStart}`));
  }
  return { url: null, sessionId: null, switched: true, planId: "team" as const, interval, seats, amountCents: teamPriceCents(seats, interval) };
}
