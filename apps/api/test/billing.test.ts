import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureCatalog } from "@rolling/core/models/__fixtures__/catalog";
import type { LedgerOutcome } from "@rolling/core/credits";
import { quoteTopUp } from "@rolling/core/pricing/config";
import worker from "../src/index";
import { chargeAutoTopUp, creditAutoTopUp, prepareAutoTopUp } from "../src/billing/autoTopUp";
import { clearPriceCache, stripeFor } from "../src/billing/stripe";
import { grantPlan } from "./auth-helpers";
import { FakeStripe, stripeEnv, webhookRequest } from "./fake-stripe";

const DAY = 86_400_000;
const testEnv = { ...env, ...stripeEnv } as Env;
const fake = new FakeStripe();
let userSeq = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", fake.fetch);
  clearPriceCache();
});
afterAll(() => vi.unstubAllGlobals());

async function call(req: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...testEnv, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function newUser(prefix = "bill") {
  const userId = `${prefix}_${++userSeq}_${Date.now().toString(36)}`;
  return { userId, workspaceId: `ws_dev_${userId}` };
}

async function api(userId: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers["x-dev-user"] = userId;
  const res = await call(new Request(`https://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
}

async function hook(event: { id?: string; type: string; object: unknown }) {
  const res = await call(await webhookRequest(event));
  return { status: res.status, body: (await res.json()) as any };
}

function unwrap<T>(o: LedgerOutcome<T>): T {
  if (!o.ok) throw new Error(o.error.code);
  return o.value;
}

function credits(workspaceId: string) {
  return env.CREDITS.get(env.CREDITS.idFromName(workspaceId));
}

async function bootstrap(userId: string) {
  // The auth middleware creates the personal workspace on first request.
  expect((await api(userId, "GET", "/api/billing")).status).toBe(200);
}

async function waitForLedger(workspaceId: string, atLeast: number) {
  for (let i = 0; i < 80; i++) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ledger_lines WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>())!.n;
    if (n >= atLeast) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("ledger mirror did not arrive");
}

describe("POST /api/stripe/webhook signature", () => {
  const event = { type: "ping.test", object: {} };

  it("accepts a valid signature and records the event once", async () => {
    const r1 = await call(await webhookRequest({ ...event, id: "evt_sig_ok" }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true, handled: false });
    const r2 = await call(await webhookRequest({ ...event, id: "evt_sig_ok" }));
    expect(await r2.json()).toEqual({ received: true, duplicate: true });
    expect(await env.DB.prepare("SELECT type FROM stripe_events WHERE id = 'evt_sig_ok'").first()).toEqual({ type: "ping.test" });
  });

  it("rejects a wrong secret, a stale timestamp and a missing header", async () => {
    const bad = await call(await webhookRequest(event, { secret: "whsec_wrong" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "BAD_REQUEST", data: { reason: "no_signature_match" } } });
    const stale = await call(await webhookRequest(event, { timestampSec: Math.floor(Date.now() / 1000) - 600 }));
    expect(await stale.json()).toMatchObject({ error: { data: { reason: "timestamp_outside_tolerance" } } });
    const none = await call(new Request("https://example.com/api/stripe/webhook", { method: "POST", body: "{}" }));
    expect(await none.json()).toMatchObject({ error: { data: { reason: "missing_header" } } });
  });

  it("answers 503 when the webhook secret is not configured", async () => {
    const res = await call(await webhookRequest(event), { STRIPE_WEBHOOK_SECRET: undefined });
    expect(res.status).toBe(503);
  });
});

describe("checkout validation", () => {
  it("requires sign-in", async () => {
    expect((await api(null, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 1000 })).status).toBe(401);
  });

  it("refuses top-ups for non-members with NO_PLAN", async () => {
    const { userId } = newUser();
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 2500 });
    expect(r).toMatchObject({ status: 402, body: { error: { code: "NO_PLAN" } } });
  });

  it("checks top-up amount bounds and whole cents", async () => {
    const { userId, workspaceId } = newUser();
    await bootstrap(userId);
    await grantPlan(workspaceId, "plus");
    for (const amountCents of [999, 1_000_001]) {
      const r = await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents });
      expect(r).toMatchObject({ status: 400, body: { error: { code: "VALIDATION_FAILED", data: { minCents: 1000, maxCents: 1_000_000 } } } });
    }
    expect((await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 1000.5 })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 1000, returnTo: "//evil.example" })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await api(userId, "POST", "/api/billing/checkout", { kind: "pack", priceId: "x" })).body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a second plan checkout for a member (use the portal)", async () => {
    const { userId, workspaceId } = newUser();
    await bootstrap(userId);
    await grantPlan(workspaceId, "starter");
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "pro", interval: "year" });
    expect(r).toMatchObject({ status: 409, body: { error: { code: "CONFLICT", data: { reason: "already_subscribed" } } } });
  });

  it("portal needs a billing account", async () => {
    const { userId } = newUser();
    expect((await api(userId, "POST", "/api/billing/portal", {})).body.error.code).toBe("NO_PLAN");
  });

  it("auto top-up needs a plan and a valid amount", async () => {
    const { userId, workspaceId } = newUser();
    expect((await api(userId, "PATCH", "/api/billing/auto-topup", { enabled: true })).body.error.code).toBe("NO_PLAN");
    await grantPlan(workspaceId, "plus");
    expect((await api(userId, "PATCH", "/api/billing/auto-topup", { enabled: true, amountCents: 500 })).body.error.code).toBe("VALIDATION_FAILED");
    const r = await api(userId, "PATCH", "/api/billing/auto-topup", { enabled: true });
    expect(r).toEqual({ status: 200, body: { autoTopUp: { enabled: true, thresholdCredits: 200, amountCents: 1000 } } });
    expect((await api(userId, "GET", "/api/billing")).body.autoTopUp).toEqual({ enabled: true, thresholdCredits: 200, amountCents: 1000 });
  });
});

describe("GET /api/billing/plans", () => {
  it("lists plans, top-up rules and the caller's plan", async () => {
    const pub = await api(null, "GET", "/api/billing/plans");
    expect(pub.status).toBe(200);
    expect(pub.body.plans.map((p: { id: string; prices: unknown }) => [p.id, p.prices])).toEqual([
      ["starter", { month: 500, year: 4800 }],
      ["plus", { month: 1500, year: 14400 }],
      ["pro", { month: 4900, year: 47000 }],
      ["team", { month: 7900, year: 75800 }],
    ]);
    expect(pub.body.topUp).toMatchObject({ minCents: 1000, maxCents: 1_000_000, presetsCents: [1000, 2500, 5000, 10000, 25000] });
    expect(pub.body.current).toBeNull();
    const { userId } = newUser();
    expect((await api(userId, "GET", "/api/billing/plans")).body.current).toEqual({ plan: null, isMember: false });
  });
});

describe("subscription and top-up lifecycle (fake Stripe)", () => {
  const { userId, workspaceId } = newUser("life");
  const now = Date.now();
  const p1 = { start: now - DAY, end: now + 29 * DAY };
  const p2 = { start: p1.end, end: p1.end + 30 * DAY };
  let sessionId = "";
  let customer = "";
  let subId = "";

  it("plan checkout creates a Stripe customer and a subscription session with resume metadata", async () => {
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "plus", interval: "month", resume: { runQuoteId: "qt_pending" }, returnTo: "/canvas/prj_1" });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    sessionId = r.body.sessionId;
    const form = (fake.sessions.get(sessionId) as { form: Record<string, string> }).form;
    customer = form.customer!;
    expect(form).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_rolling_plus_month",
      "metadata[kind]": "plan",
      "metadata[workspaceId]": workspaceId,
      "metadata[resumeQuoteId]": "qt_pending",
      "subscription_data[metadata][workspaceId]": workspaceId,
      success_url: "http://localhost:8787/canvas/prj_1?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    });
    expect(fake.calls.find((c) => c.path === "/v1/customers")?.idempotencyKey).toBe(`customer:${workspaceId}`);
    const ws = await env.DB.prepare("SELECT stripe_customer_id FROM workspaces WHERE id = ?").bind(workspaceId).first();
    expect(ws).toEqual({ stripe_customer_id: customer });
    expect((await api(userId, "GET", `/api/billing/checkout/${sessionId}`)).body).toMatchObject({ status: "open", kind: "plan", resume: { runQuoteId: "qt_pending" } });
  });

  it("checkout.session.completed stores the subscription; invoice.paid grants plan credits", async () => {
    subId = fake.addSubscription({ customer, lookupKey: "rolling_plus_month", ...p1 }).id;
    const done = await hook({
      type: "checkout.session.completed",
      object: { id: sessionId, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", customer, subscription: subId, metadata: { kind: "plan", workspaceId } },
    });
    expect(done).toEqual({ status: 200, body: { received: true, handled: true } });
    const row = await env.DB.prepare("SELECT plan, interval, status, current_period_end, current_period_start, stripe_price_id FROM subscriptions WHERE id = ?").bind(subId).first();
    expect(row).toEqual({ plan: "plus", interval: "month", status: "active", current_period_end: Math.floor(p1.end / 1000) * 1000, current_period_start: Math.floor(p1.start / 1000) * 1000, stripe_price_id: "price_rolling_plus_month" });

    const paid = await hook({
      type: "invoice.paid",
      object: { id: "in_first", object: "invoice", customer, status: "paid", billing_reason: "subscription_create", amount_paid: 1500, parent: { subscription_details: { subscription: subId } }, lines: { data: [{ period: { start: Math.floor(p1.start / 1000), end: Math.floor(p1.end / 1000) } }] } },
    });
    expect(paid.body.handled).toBe(true);
    expect(await credits(workspaceId).balance()).toMatchObject({ plan: 800, purchased: 0, held: 0, planExpiresAt: Math.floor(p1.end / 1000) * 1000 });

    const ret = await api(userId, "GET", `/api/billing/checkout/${sessionId}`);
    expect(ret.body).toMatchObject({ status: "complete", kind: "plan", planId: "plus", resume: { runQuoteId: "qt_pending" } });
    const summary = (await api(userId, "GET", "/api/billing")).body;
    expect(summary).toMatchObject({ plan: "plus", interval: "month", status: "active", renewsAt: Math.floor(p1.end / 1000) * 1000, balance: { plan: 800 } });
  });

  it("top-up checkout quotes credits server-side; the webhook credits them once", async () => {
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 2500, resume: { runQuoteId: "qt_more" } });
    const expected = quoteTopUp(2500, "plus").credits;
    expect(r.body).toMatchObject({ credits: expected });
    expect(expected).toBe(2725);
    const form = (fake.sessions.get(r.body.sessionId) as { form: Record<string, string> }).form;
    expect(form).toMatchObject({
      mode: "payment",
      customer,
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][currency]": "usd",
      "payment_intent_data[setup_future_usage]": "off_session",
      "metadata[credits]": "2725",
      "metadata[plan]": "plus",
      "metadata[amountCents]": "2500",
    });
    const metadata = Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
    const session = { id: r.body.sessionId, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer, amount_total: 2500, currency: "usd", payment_intent: "pi_topup_1", metadata };
    expect((await hook({ type: "checkout.session.completed", object: session })).body.handled).toBe(true);
    // Same payment in another event (e.g. async_payment_succeeded): credited once.
    await hook({ type: "checkout.session.async_payment_succeeded", object: session });
    expect((await credits(workspaceId).balance()).purchased).toBe(2725);
    expect((await api(userId, "GET", `/api/billing/checkout/${r.body.sessionId}`)).body).toMatchObject({ status: "complete", kind: "topUp", credits: 2725, resume: { runQuoteId: "qt_more" } });

    // A session whose paid amount does not match its metadata is not credited.
    const tampered = { ...session, id: "cs_tampered", payment_intent: "pi_topup_2", amount_total: 1000 };
    expect((await hook({ type: "checkout.session.completed", object: tampered })).body.handled).toBe(false);
    expect((await credits(workspaceId).balance()).purchased).toBe(2725);
  });

  it("renewal expires leftover plan credits and grants the new period", async () => {
    const stub = credits(workspaceId);
    const catalog = fixtureCatalog.models.filter((m) => m.id === "bytedance/seedance-2.5");
    const q = unwrap(await stub.quote([{ ref: "n1", modelId: "bytedance/seedance-2.5", request: { resolution: "720p", seconds: 5 } }], catalog));
    const h = unwrap(await stub.hold({ quoteId: q.quoteId, runId: "run_life", userId, idemKey: "life-hold" }));
    await stub.settle(h.jobs[0]!.jobId, 347, "life-settle");
    expect((await stub.balance()).plan).toBe(800 - 347);

    const sub = fake.subscriptions.get(subId)!;
    sub.items.data[0]!.current_period_start = Math.floor(p2.start / 1000);
    sub.items.data[0]!.current_period_end = Math.floor(p2.end / 1000);
    await hook({
      type: "invoice.paid",
      object: { id: "in_renew", object: "invoice", customer, status: "paid", billing_reason: "subscription_cycle", amount_paid: 1500, subscription: subId, lines: { data: [{ period: { start: Math.floor(p2.start / 1000), end: Math.floor(p2.end / 1000) } }] } },
    });
    expect(await stub.balance()).toMatchObject({ plan: 800, purchased: 2725, planExpiresAt: Math.floor(p2.end / 1000) * 1000 });
    // A late, older invoice does not grant again.
    await hook({
      type: "invoice.paid",
      object: { id: "in_first_retry", object: "invoice", customer, status: "paid", billing_reason: "subscription_cycle", subscription: subId, lines: { data: [{ period: { start: Math.floor(p1.start / 1000), end: Math.floor(p1.end / 1000) } }] } },
    });
    expect((await stub.balance()).plan).toBe(800);
    const audit = await stub.audit();
    expect(audit.ok).toBe(true);
    expect(audit.fromLines.spent).toBe(347);
  });

  it("mirrors the ledger to D1 and pages it over REST and GraphQL", async () => {
    await waitForLedger(workspaceId, 6);
    const page1 = (await api(userId, "GET", "/api/billing/ledger?first=2")).body;
    expect(page1.lines).toHaveLength(2);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    const page2 = (await api(userId, "GET", `/api/billing/ledger?first=2&after=${page1.pageInfo.endCursor}`)).body;
    expect(page2.lines.map((l: { id: string }) => l.id)).not.toContain(page1.lines[0].id);
    expect(page1.lines[0].createdAt).toBeGreaterThanOrEqual(page2.lines[0].createdAt);
    expect((await api(userId, "GET", "/api/billing/ledger?after=%%%")).status).toBe(400);
    const all = (await api(userId, "GET", "/api/billing/ledger?first=100")).body.lines as { kind: string; amount: number; stripeRef: string | null }[];
    expect(all.find((l) => l.kind === "purchase")).toMatchObject({ amount: 2725, stripeRef: "pi_topup_1" });

    const gql = await call(
      new Request("https://example.com/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dev-user": userId },
        body: JSON.stringify({
          query: "{ billing { plan interval status renewsAt cancelAtPeriodEnd balance { plan purchased held planExpiresAt } autoTopUp { enabled } } ledger(first: 2) { edges { cursor node { kind bucket amount } } pageInfo { hasNextPage endCursor } } }",
        }),
      }),
    );
    const data = ((await gql.json()) as any).data;
    expect(data.billing).toMatchObject({ plan: "plus", interval: "month", status: "active", cancelAtPeriodEnd: false, balance: { plan: 800, purchased: 2725, held: 0 }, autoTopUp: null });
    expect(data.ledger.edges).toHaveLength(2);
    expect(data.ledger.pageInfo).toEqual({ hasNextPage: true, endCursor: data.ledger.edges[1].cursor });
    const anon = await call(new Request("https://example.com/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ billing { plan } }" }) }));
    expect(((await anon.json()) as any).errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  it("customer.subscription.updated records cancel at period end", async () => {
    const sub = fake.subscriptions.get(subId)!;
    sub.cancel_at_period_end = true;
    expect((await hook({ type: "customer.subscription.updated", object: sub })).body.handled).toBe(true);
    const summary = (await api(userId, "GET", "/api/billing")).body;
    expect(summary).toMatchObject({ plan: "plus", cancelAtPeriodEnd: true, renewsAt: null });
  });

  it("invoice.payment_failed stores the past_due status", async () => {
    const sub = fake.subscriptions.get(subId)!;
    sub.status = "past_due";
    expect((await hook({ type: "invoice.payment_failed", object: { id: "in_fail", object: "invoice", customer, status: "open", subscription: subId } })).body.handled).toBe(true);
    expect(await env.DB.prepare("SELECT status FROM subscriptions WHERE id = ?").bind(subId).first()).toEqual({ status: "past_due" });
  });

  it("portal returns a Stripe portal URL for the customer", async () => {
    const r = await api(userId, "POST", "/api/billing/portal", { returnTo: "/settings/billing" });
    expect(r).toEqual({ status: 200, body: { url: `https://billing.stripe.test/p/${customer}` } });
    const inv = await api(userId, "GET", "/api/billing/invoices");
    expect(inv.body.invoices[0]).toMatchObject({ id: "in_1", amountCents: 1500, currency: "USD", url: "https://invoice.stripe.test/in_1" });
  });

  it("customer.subscription.deleted ends the plan: plan credits expire, purchased stay", async () => {
    const sub = fake.subscriptions.get(subId)!;
    sub.status = "canceled";
    expect((await hook({ type: "customer.subscription.deleted", object: sub })).body.handled).toBe(true);
    expect(await credits(workspaceId).balance()).toMatchObject({ plan: 0, purchased: 2725 });
    expect((await credits(workspaceId).summary()).planId).toBeNull();
    expect((await api(userId, "GET", "/api/billing")).body).toMatchObject({ plan: null, status: "canceled" });
    // Top-ups are members only again.
    expect((await api(userId, "POST", "/api/billing/checkout", { kind: "topUp", amountCents: 1000 })).body.error.code).toBe("NO_PLAN");
  });
});

describe("auto top-up (BillingWorkflow steps)", () => {
  it("charges the saved card off-session and credits the account once", async () => {
    const { userId, workspaceId } = newUser("atu");
    await bootstrap(userId);
    const stripe = stripeFor(testEnv);
    const customer = (await stripe.createCustomer({ metadata: { workspaceId } }, `customer:${workspaceId}`)).id;
    await env.DB.prepare("UPDATE workspaces SET stripe_customer_id = ? WHERE id = ?").bind(customer, workspaceId).run();
    const now = Date.now();
    const sub = fake.addSubscription({ customer, lookupKey: "rolling_pro_month", start: now, end: now + 30 * DAY });
    await hook({ type: "customer.subscription.created", object: sub });
    const stub = credits(workspaceId);
    await stub.grant({ planId: "pro", interval: "month", start: now, end: now + 30 * DAY }, "atu-grant");

    const params = { kind: "autoTopUp" as const, workspaceId, amountCents: 1000, window: "w1" };
    expect(await prepareAutoTopUp(testEnv, stripe, params)).toEqual({ skip: "auto top-up is off" });
    await stub.setAutoTopUp({ enabled: true, thresholdCredits: 200, amountCents: 1000 });
    const plan = await prepareAutoTopUp(testEnv, stripe, params);
    expect(plan).toEqual({ customerId: customer, paymentMethodId: "pm_card_visa", planId: "pro", credits: quoteTopUp(1000, "pro").credits });
    if ("skip" in plan) throw new Error("unexpected skip");

    fake.declineNextCharge = true;
    expect(await chargeAutoTopUp(stripe, params, plan, "autotopup:test-1")).toEqual({ ok: false, reason: "Your card has insufficient funds.", code: "insufficient_funds" });

    const charge = await chargeAutoTopUp(stripe, params, plan, "autotopup:test-2");
    if (!charge.ok) throw new Error(charge.reason);
    const piCall = fake.calls.filter((c) => c.path === "/v1/payment_intents").at(-1)!;
    expect(piCall).toMatchObject({ idempotencyKey: "autotopup:test-2", form: { off_session: "true", confirm: "true", amount: "1000", customer, "metadata[kind]": "autoTopUp" } });
    await creditAutoTopUp(testEnv, params, plan, charge.paymentIntentId);
    // The payment_intent.succeeded webhook backup does not credit twice.
    await hook({ type: "payment_intent.succeeded", object: { id: charge.paymentIntentId, object: "payment_intent", status: "succeeded", amount: 1000, currency: "usd", metadata: { kind: "autoTopUp", workspaceId, credits: String(plan.credits) } } });
    expect((await stub.balance()).purchased).toBe(1100);
  });
});
