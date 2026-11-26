import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { freshEmail, getMe, signIn } from "./auth-helpers";

const TOKEN = "admin-grant-token";
const adminEnv = (overrides: Record<string, unknown> = {}) => ({ ...env, ADMIN_TOKEN: TOKEN, ...overrides }) as unknown as Env;

async function grant(body: unknown, e: Env, token = TOKEN) {
  const ctx = createExecutionContext();
  const res = await app.request(
    "https://example.com/api/admin/grant",
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /api/admin/grant (owner comp grants)", () => {
  it("gives a user's workspace a plan for N months plus extra credits", async () => {
    const email = freshEmail("comp");
    const { cookie } = await signIn(email);
    const res = await grant({ email, planId: "pro", months: 1, extraCredits: 2500 }, adminEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: { plan: number; purchased: number }; periodEnd: number };
    expect(body.balance).toMatchObject({ plan: 2500, purchased: 2500 });
    expect(body.periodEnd).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    const me = (await getMe(cookie)).body as { isMember: boolean; plan: { id: string } };
    expect(me.isMember).toBe(true);
    expect(me.plan.id).toBe("pro");
  });

  it("gives Team with seats for several months", async () => {
    const email = freshEmail("compteam");
    const { cookie } = await signIn(email);
    const res = await grant({ email, planId: "team", months: 3, seats: 3, extraCredits: 10000 }, adminEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seats: number; balance: { purchased: number }; periodEnd: number };
    expect(body.seats).toBe(3);
    expect(body.balance.purchased).toBe(10000);
    expect(body.periodEnd).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);
    const me = (await getMe(cookie)).body as { plan: { id: string } };
    expect(me.plan.id).toBe("team");
  });

  it("is 404 without ADMIN_TOKEN, 401 with a wrong token, 404 for an unknown email", async () => {
    expect((await grant({ email: "nobody@example.com", planId: "pro" }, adminEnv({ ADMIN_TOKEN: undefined }))).status).toBe(404);
    expect((await grant({ email: "nobody@example.com", planId: "pro" }, adminEnv(), "wrong")).status).toBe(401);
    expect((await grant({ email: "nobody-here@example.com", planId: "pro" }, adminEnv())).status).toBe(404);
  });
});
