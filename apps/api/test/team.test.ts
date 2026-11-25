/**
 * Team plan (D-013): checkout with seats, seat changes, webhooks and grants
 * for added seats, invite gating. Stripe is the in-memory fake.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearPriceCache } from "../src/billing/stripe";
import { grantPlan } from "./auth-helpers";
import { FakeStripe, stripeEnv, webhookRequest } from "./fake-stripe";

const DAY = 86_400_000;
const testEnv = { ...env, ...stripeEnv } as Env;
const fake = new FakeStripe();
let seq = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", fake.fetch);
  clearPriceCache();
});
afterAll(() => vi.unstubAllGlobals());

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function newUser(prefix = "team") {
  const userId = `${prefix}_${++seq}_${Date.now().toString(36)}`;
  return { userId, workspaceId: `ws_dev_${userId}` };
}

async function api(userId: string, method: string, path: string, body?: unknown, workspaceId?: string) {
  const res = await call(
    new Request(`https://example.com${path}`, {
      method,
      headers: { "content-type": "application/json", "x-dev-user": userId, ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function hook(event: { id?: string; type: string; object: unknown }) {
  const res = await call(await webhookRequest(event));
  return (await res.json()) as any;
}

const credits = (workspaceId: string) => env.CREDITS.get(env.CREDITS.idFromName(workspaceId));
const sec = (ms: number) => Math.floor(ms / 1000);

async function addMember(workspaceId: string, userId: string) {
  await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?1, ?2, 'editor')").bind(workspaceId, userId).run();
}

describe("Team checkout, seats and webhooks (fake Stripe)", () => {
  const { userId, workspaceId } = newUser("tlife");
  const now = Date.now();
  const p1 = { start: now - 10 * DAY, end: now + 20 * DAY };
  let customer = "";
  let subId = "";

  it("checkout has the base price and the seat price with quantity seats − 1", async () => {
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "team", interval: "month", seats: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seats: 3, amountCents: 7900 + 2 * 2500 });
    const form = (fake.sessions.get(r.body.sessionId) as { form: Record<string, string> }).form;
    customer = form.customer!;
    expect(form).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_rolling_team_month",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_rolling_team_seat_month",
      "line_items[1][quantity]": "2",
      "metadata[planId]": "team",
      "metadata[seats]": "3",
      "subscription_data[metadata][seats]": "3",
    });
    expect((await api(userId, "GET", `/api/billing/checkout/${r.body.sessionId}`)).body).toMatchObject({ planId: "team", seats: 3 });
  });

  it("refuses seats on personal plans and bad seat counts", async () => {
    const other = newUser();
    expect((await api(other.userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "plus", interval: "month", seats: 2 })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await api(other.userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "team", interval: "month", seats: 0 })).body.error.code).toBe("VALIDATION_FAILED");
  });

  it("invoice.paid grants 2,500 + 500 per extra seat and the workspace becomes a team workspace", async () => {
    subId = fake.addSubscription({ customer, lookupKey: "rolling_team_month", seatQuantity: 2, ...p1 }).id;
    await hook({ type: "checkout.session.completed", object: { id: "cs_team_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", customer, subscription: subId, metadata: { kind: "plan", workspaceId } } });
    const row = await env.DB.prepare("SELECT plan, seats FROM subscriptions WHERE id = ?").bind(subId).first();
    expect(row).toEqual({ plan: "team", seats: 3 });
    expect(await env.DB.prepare("SELECT kind FROM workspaces WHERE id = ?").bind(workspaceId).first()).toEqual({ kind: "team" });
    await hook({
      type: "invoice.paid",
      object: { id: "in_team_1", object: "invoice", customer, status: "paid", billing_reason: "subscription_create", amount_paid: 12900, subscription: subId, lines: { data: [{ period: { start: sec(p1.start), end: sec(p1.end) } }] } },
    });
    expect((await credits(workspaceId).balance()).plan).toBe(3500);
    expect(await credits(workspaceId).summary()).toMatchObject({ planId: "team", seats: 3 });
    const summary = (await api(userId, "GET", "/api/billing")).body;
    expect(summary).toMatchObject({ plan: "team", seats: { purchased: 3, used: 1 } });
    const me = (await api(userId, "GET", "/api/me")).body;
    expect(me.plan.perks).toMatchObject({ monthlyCredits: 3500, concurrentJobs: 14, seats: 3 });
  });

  it("previews the prorated charge for added seats", async () => {
    const r = await api(userId, "GET", "/api/billing/seats/preview?seats=5");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seats: 5, current: 3, used: 1, interval: "month", renewalCents: 7900 + 4 * 2500, addedMonthlyCredits: 1000 });
    // 2 seats × $25 for ~2/3 of the period left.
    expect(r.body.prorationCents).toBeGreaterThan(3200);
    expect(r.body.prorationCents).toBeLessThanOrEqual(3400);
  });

  it("adding seats charges now (always_invoice) and grants the prorated credits once", async () => {
    const before = (await credits(workspaceId).balance()).plan;
    const r = await api(userId, "PATCH", "/api/billing/seats", { seats: 5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seats: { purchased: 5, used: 1 }, changed: true });
    const update = fake.calls.filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`).at(-1)!;
    expect(update.form).toMatchObject({ proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", "items[0][quantity]": "4" });
    expect(update.idempotencyKey).toBeTruthy();
    // 2 seats × 500 credits × ~2/3 of the slice.
    expect(r.body.granted).toBeGreaterThan(640);
    expect(r.body.granted).toBeLessThanOrEqual(667);
    expect((await credits(workspaceId).balance()).plan).toBe(before + r.body.granted);

    // The webhooks for the same change grant nothing more.
    const sub = fake.subscriptions.get(subId)!;
    await hook({ type: "customer.subscription.updated", object: sub });
    await hook({ type: "invoice.paid", object: { id: "in_team_seats", object: "invoice", customer, status: "paid", billing_reason: "subscription_update", amount_paid: 3300, subscription: subId } });
    expect((await credits(workspaceId).balance()).plan).toBe(before + r.body.granted);
    expect(await env.DB.prepare("SELECT seats FROM subscriptions WHERE id = ?").bind(subId).first()).toEqual({ seats: 5 });
  });

  it("a seat added in the Stripe dashboard is granted by customer.subscription.updated, idempotently", async () => {
    const sub = fake.subscriptions.get(subId)!;
    sub.items.data[1]!.quantity = 5; // 6 seats
    const before = (await credits(workspaceId).balance()).plan;
    await hook({ id: "evt_seat_dash", type: "customer.subscription.updated", object: sub });
    const after = (await credits(workspaceId).balance()).plan;
    expect(after - before).toBeGreaterThan(300);
    expect(after - before).toBeLessThanOrEqual(334);
    await hook({ id: "evt_seat_dash", type: "customer.subscription.updated", object: sub });
    await hook({ id: "evt_seat_dash_again", type: "customer.subscription.updated", object: sub });
    expect((await credits(workspaceId).balance()).plan).toBe(after);
    expect((await credits(workspaceId).summary()).seats).toBe(6);
  });

  it("refuses lowering below the seats in use; lowering takes effect without a refund", async () => {
    for (let i = 0; i < 3; i++) await addMember(workspaceId, `${userId}_m${i}`);
    const r = await api(userId, "PATCH", "/api/billing/seats", { seats: 3 });
    expect(r).toMatchObject({ status: 409, body: { error: { code: "SEATS_IN_USE", data: { seats: 3, used: 4 } } } });
    const ok = await api(userId, "PATCH", "/api/billing/seats", { seats: 4 });
    expect(ok.body).toMatchObject({ seats: { purchased: 4, used: 4 }, granted: 0 });
    const update = fake.calls.filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/${subId}`).at(-1)!;
    expect(update.form).toMatchObject({ proration_behavior: "none", "items[0][quantity]": "3" });
    expect(update.form.payment_behavior).toBeUndefined();
    expect((await credits(workspaceId).summary()).seats).toBe(4);
    // Re-adding a seat in the same slice grants nothing new (the high-water mark is 6).
    const again = await api(userId, "PATCH", "/api/billing/seats", { seats: 5 });
    expect(again.body).toMatchObject({ seats: { purchased: 5 }, granted: 0 });
  });

  it("invite gating: free seat → invite; full → SEATS_REQUIRED; removing a member frees a seat", async () => {
    // 5 seats, 4 members.
    const a = await api(userId, "POST", "/api/workspace/invites", { email: `a_${seq}@team.test`, role: "editor" });
    expect(a.status).toBe(201);
    const b = await api(userId, "POST", "/api/workspace/invites", { email: `b_${seq}@team.test`, role: "viewer" });
    expect(b).toMatchObject({ status: 402, body: { error: { code: "SEATS_REQUIRED", data: { seats: 5, used: 5, needed: 6 } } } });
    expect((await api(userId, "GET", "/api/workspace/members")).body.seats).toEqual({ used: 5, limit: 5, team: true });
    expect((await api(userId, "DELETE", `/api/workspace/members/${userId}_m0`)).status).toBe(200);
    expect((await api(userId, "POST", "/api/workspace/invites", { email: `b_${seq}@team.test`, role: "viewer" })).status).toBe(201);
  });

  it("a declined charge leaves seats unchanged (PAYMENT_FAILED)", async () => {
    fake.declineNextCharge = true;
    const r = await api(userId, "PATCH", "/api/billing/seats", { seats: 8 });
    expect(r).toMatchObject({ status: 402, body: { error: { code: "PAYMENT_FAILED" } } });
    expect((await credits(workspaceId).summary()).seats).toBe(5);
  });

  it("only owners change seats; a second Team checkout is refused", async () => {
    expect((await api(`${userId}_m1`, "PATCH", "/api/billing/seats", { seats: 6 }, workspaceId)).status).toBe(403);
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "team", interval: "month", seats: 6 });
    expect(r.body.error).toMatchObject({ code: "CONFLICT", data: { reason: "already_subscribed" } });
  });
});

describe("personal plan → Team (fake Stripe)", () => {
  it("switches the subscription in place; invoice.paid grants Team credits for the seats", async () => {
    const { userId, workspaceId } = newUser("tswitch");
    const r0 = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "plus", interval: "month" });
    const customer = (fake.sessions.get(r0.body.sessionId) as { form: Record<string, string> }).form.customer!;
    const now = Date.now();
    const p = { start: now - DAY, end: now + 29 * DAY };
    const sub = fake.addSubscription({ customer, lookupKey: "rolling_plus_month", workspaceId, ...p });
    await hook({ type: "customer.subscription.created", object: sub });
    await hook({ type: "invoice.paid", object: { id: `in_plus_${sub.id}`, object: "invoice", customer, status: "paid", billing_reason: "subscription_create", amount_paid: 1500, subscription: sub.id, lines: { data: [{ period: { start: sec(p.start), end: sec(p.end) } }] } } });
    expect((await credits(workspaceId).balance()).plan).toBe(800);

    // Inviting needs Team.
    expect((await api(userId, "POST", "/api/workspace/invites", { email: `x_${seq}@team.test`, role: "editor" })).body.error).toMatchObject({ code: "TEAM_REQUIRED", data: { currentPlan: "plus" } });
    expect((await api(userId, "PATCH", "/api/billing/seats", { seats: 2 })).body.error).toMatchObject({ code: "TEAM_REQUIRED", data: { currentPlan: "plus" } });

    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "team", interval: "month", seats: 2 });
    expect(r.body).toMatchObject({ url: null, switched: true, planId: "team", seats: 2, amountCents: 10400 });
    const update = fake.calls.filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/${sub.id}`).at(-1)!;
    expect(update.form).toMatchObject({
      "items[0][price]": "price_rolling_team_month",
      "items[1][price]": "price_rolling_team_seat_month",
      "items[1][quantity]": "1",
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    expect(await env.DB.prepare("SELECT kind FROM workspaces WHERE id = ?").bind(workspaceId).first()).toEqual({ kind: "team" });
    // Limits now; no seat credits on the Plus slice before the invoice.
    expect((await credits(workspaceId).balance()).plan).toBe(800);
    await hook({ type: "customer.subscription.updated", object: fake.subscriptions.get(sub.id) });
    await hook({ type: "invoice.paid", object: { id: `in_switch_${sub.id}`, object: "invoice", customer, status: "paid", billing_reason: "subscription_update", amount_paid: 8000, subscription: sub.id } });
    expect((await credits(workspaceId).balance()).plan).toBe(3000);
    expect(await credits(workspaceId).summary()).toMatchObject({ planId: "team", seats: 2, grantedPlanId: "team" });
    expect((await api(userId, "POST", "/api/workspace/invites", { email: `x_${seq}@team.test`, role: "editor" })).status).toBe(201);
  });

  it("requires a seat for everyone already in the workspace", async () => {
    const { userId, workspaceId } = newUser("tseats");
    await api(userId, "GET", "/api/billing");
    await addMember(workspaceId, `${userId}_old`);
    const r = await api(userId, "POST", "/api/billing/checkout", { kind: "plan", planId: "team", interval: "year", seats: 1 });
    expect(r).toMatchObject({ status: 402, body: { error: { code: "SEATS_REQUIRED", data: { seats: 1, used: 2, needed: 2 } } } });
  });

  it("Team limits follow seats for direct grants (concurrency in the ledger)", async () => {
    const { userId, workspaceId } = newUser("tlimit");
    await api(userId, "GET", "/api/billing");
    await grantPlan(workspaceId, "team", "active", 3);
    expect((await api(userId, "GET", "/api/workspace/members")).body.seats).toEqual({ used: 1, limit: 3, team: true });
  });
});
