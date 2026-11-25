import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { freshEmail, getMe, signIn } from "./auth-helpers";

const TOKEN = "test-plan-token";
const testEnv = (overrides: Record<string, unknown> = {}) =>
  ({ ...env, EMAIL_PROVIDER: "test-inbox", TEST_INBOX_TOKEN: TOKEN, ...overrides }) as unknown as Env;

async function post(cookie: string, body: unknown, e: Env, token = TOKEN) {
  const ctx = createExecutionContext();
  const res = await app.request(
    "https://example.com/api/test/plan",
    { method: "POST", headers: { "content-type": "application/json", cookie, authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /api/test/plan (staging-only plan grant)", () => {
  it("grants an active plan and its credits to the caller's workspace", async () => {
    const { cookie } = await signIn(freshEmail("testplan"));
    const res = await post(cookie, { planId: "plus", extraCredits: 1000 }, testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: { plan: number; purchased: number } };
    expect(body.balance).toMatchObject({ plan: 800, purchased: 1000 });
    const me = (await getMe(cookie)).body as { isMember: boolean; plan: { id: string } };
    expect(me.isMember).toBe(true);
    expect(me.plan.id).toBe("plus");
  });

  it("is refused in production, without the test inbox, and with a wrong token", async () => {
    const { cookie } = await signIn(freshEmail("testplan2"));
    expect((await post(cookie, { planId: "pro" }, testEnv({ ENVIRONMENT: "production", EMAIL_PROVIDER: "resend", BETTER_AUTH_SECRET: "x".repeat(32) }))).status).toBe(404);
    expect((await post(cookie, { planId: "pro" }, testEnv({ EMAIL_PROVIDER: "" }))).status).toBe(404);
    expect((await post(cookie, { planId: "pro" }, testEnv(), "wrong")).status).toBe(401);
    expect((await post("", { planId: "pro" }, testEnv())).status).toBe(401);
  });
});
