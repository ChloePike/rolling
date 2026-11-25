import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import { authMiddleware, requireMember, requireRole } from "../src/auth/context";
import { ApiError, errorResponse } from "../src/lib/errors";
import { BASE, codeFrom, cookieFrom, freshEmail, freshIp, getMe, grantPlan, json, ORIGIN, sendCode, signIn, waitForEmail } from "./auth-helpers";

/** Calls the Worker directly with a modified env (SELF always uses the test config). */
async function call(req: Request, overrides: Partial<Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("email code sign-up and sign-in", () => {
  it("signs up, creates a personal workspace and prefs, and sets a secure session cookie", async () => {
    const email = freshEmail("signup");
    const ip = freshIp();
    const { res, cookie } = await signIn(email, { "cf-connecting-ip": ip, "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("rolling.session_token="))!;
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const { res: meRes, body } = await getMe(cookie);
    expect(meRes.status).toBe(200);
    expect(body.user).toMatchObject({ email, emailVerified: true });
    expect(body.user.id).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.workspace).toEqual({ id: body.user.id.replace("usr_", "ws_"), name: "Personal", kind: "personal", matureAllowed: true });
    expect(body.role).toBe("owner");
    expect(body.workspaces).toEqual([{ id: body.workspace.id, name: "Personal", kind: "personal", role: "owner", plan: null }]);
    expect(body.prefs).toEqual({
      language: "ja",
      currency: "JPY",
      creationMode: "simple",
      defaultRatio: "9:16",
      defaultModel: "auto",
      confirmThreshold: 300,
      notifications: { done: true, low: true, renewal: true, product: false },
      theme: "system",
      matureContent: false,
    });
    expect(body).toMatchObject({ plan: null, isMember: false, matureAllowed: false, monthlyCreditLimit: null });
    expect(body.balance).toEqual({ plan: expect.any(Number), purchased: expect.any(Number), held: expect.any(Number), planExpiresAt: null });

    // Session row in D1.
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1").bind(body.user.id).first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("signs an existing user in without creating a second workspace", async () => {
    const email = freshEmail("again");
    const ip = freshIp();
    const first = await signIn(email, { "cf-connecting-ip": ip });
    const me1 = await getMe(first.cookie);
    await env.DB.prepare("DELETE FROM auth_email_sends").run(); // skip the resend cooldown
    const second = await signIn(email, { "cf-connecting-ip": ip });
    const me2 = await getMe(second.cookie);
    expect(me2.body.user.id).toBe(me1.body.user.id);
    const ws = await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?1").bind(me1.body.user.id).first<{ n: number }>();
    expect(ws?.n).toBe(1);
  });

  it("emails a 6-digit code that expires in 10 minutes", async () => {
    const email = freshEmail("mail");
    expect((await sendCode(email, { "cf-connecting-ip": freshIp() })).status).toBe(200);
    const [msg] = await waitForEmail(email);
    expect(msg!.subject).toMatch(/^Your Rolling sign-in code is \d{6}$/);
    expect(msg!.text).toContain("It expires in 10 minutes.");
    // Stored hashed, never in plain text.
    const row = await env.DB.prepare("SELECT value FROM verifications WHERE identifier LIKE ?1").bind(`%${email}%`).first<{ value: string }>();
    expect(row?.value).not.toContain(codeFrom(msg!.text));
  });

  it("rejects a wrong code, then accepts the right one", async () => {
    const email = freshEmail("wrong");
    const ip = freshIp();
    await sendCode(email, { "cf-connecting-ip": ip });
    const code = codeFrom((await waitForEmail(email))[0]!.text);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await SELF.fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email, otp: wrong }, { "cf-connecting-ip": ip }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_CODE", data: { authCode: "INVALID_OTP" } } });
    const ok = await SELF.fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email, otp: code }, { "cf-connecting-ip": ip }));
    expect(ok.status).toBe(200);
  });

  it("rejects an expired code", async () => {
    const email = freshEmail("expired");
    const ip = freshIp();
    await sendCode(email, { "cf-connecting-ip": ip });
    const code = codeFrom((await waitForEmail(email))[0]!.text);
    await env.DB.prepare("UPDATE verifications SET expires_at = ?2 WHERE identifier LIKE ?1")
      .bind(`%${email}%`, new Date(Date.now() - 1000).toISOString())
      .run();
    const res = await SELF.fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email, otp: code }, { "cf-connecting-ip": ip }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "CODE_EXPIRED" } });
  });

  it("validates the request body with the error envelope", async () => {
    const res = await sendCode("not-an-email", { "cf-connecting-ip": freshIp() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    const short = await SELF.fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email: freshEmail(), otp: "12" }, { "cf-connecting-ip": freshIp() }));
    expect(await short.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("enforces the 30 s resend cooldown and the per email + IP limit", async () => {
    const email = freshEmail("limit");
    const ip = freshIp();
    expect((await sendCode(email, { "cf-connecting-ip": ip })).status).toBe(200);
    const again = await sendCode(email, { "cf-connecting-ip": ip });
    expect(again.status).toBe(429);
    const body = (await again.json()) as any;
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.data.retryAfter).toBeGreaterThan(0);
    expect(body.error.data.retryAfter).toBeLessThanOrEqual(30);

    // Past the cooldown, the binding (5 per minute per email + IP) still stops a burst.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("DELETE FROM auth_email_sends").run();
      statuses.push((await sendCode(email, { "cf-connecting-ip": ip })).status);
    }
    expect(statuses).toContain(429);
    const limited = await sendCode(email, { "cf-connecting-ip": ip });
    expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED", data: { retryAfter: 60 } } });
    // Another IP is not affected.
    await env.DB.prepare("DELETE FROM auth_email_sends").run();
    expect((await sendCode(email, { "cf-connecting-ip": freshIp() })).status).toBe(200);
  });

  it("logs out: the session row is deleted and the cookie stops working", async () => {
    const { cookie } = await signIn(freshEmail("logout"), { "cf-connecting-ip": freshIp() });
    const { body } = await getMe(cookie);
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("rolling.session_token=;") || /rolling\.session_token=;|Max-Age=0/i.test(c))).toBe(true);
    expect((await getMe(cookie)).res.status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1").bind(body.user.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
    // Logging out again (no session) still answers 200.
    expect((await SELF.fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it("lists available providers (social ones only when configured)", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/providers`);
    expect(await res.json()).toEqual({ emailCode: true, google: false, apple: false });
    const configured = await call(new Request(`${BASE}/api/auth/providers`), {
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "s",
      APPLE_CLIENT_ID: "a",
      APPLE_CLIENT_SECRET: "jwt",
    });
    expect(await configured.json()).toEqual({ emailCode: true, google: true, apple: true });
  });

  it("returns 401 with an unknown session cookie", async () => {
    const { res } = await getMe("rolling.session_token=nope.nope");
    expect(res.status).toBe(401);
  });
});

describe("Google OAuth (fake provider endpoint)", () => {
  afterEach(() => vi.restoreAllMocks());

  function unsignedJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
  }

  it("redirects to Google, handles the callback, and creates the user and workspace", async () => {
    const googleEnv = { GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "secret-456" };
    const email = freshEmail("google");
    const realFetch = globalThis.fetch;
    const tokenCalls: { url: string; body: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        tokenCalls.push({ url, body: String(init?.body ?? (input instanceof Request ? await input.text() : "")) });
        return Response.json({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: unsignedJwt({ sub: "google-sub-1", email, email_verified: true, name: "Ada Lovelace", picture: "https://example.com/a.png", aud: "client-123", iss: "https://accounts.google.com" }),
        });
      }
      return realFetch(input as RequestInfo, init);
    });

    const start = await call(new Request(`${BASE}/api/auth/sign-in/social`, json({ provider: "google", callbackURL: "/home" })), googleEnv);
    expect(start.status).toBe(200);
    const { url, redirect } = (await start.json()) as { url: string; redirect: boolean };
    expect(redirect).toBe(true);
    const authUrl = new URL(url);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe("client-123");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    const state = authUrl.searchParams.get("state")!;
    const stateCookie = cookieFrom(start);

    const cb = await call(
      new Request(`${BASE}/api/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: "manual" }),
      googleEnv,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/home");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body).toContain("code=fake-code");
    const session = cookieFrom(cb)
      .split("; ")
      .filter((c) => c.startsWith("rolling.session_token="))
      .join("; ");
    expect(session).not.toBe("");

    const me = await call(new Request(`${BASE}/api/me`, { headers: { cookie: session } }), googleEnv);
    expect(me.status).toBe(200);
    const body = (await me.json()) as any;
    expect(body.user).toMatchObject({ email, name: "Ada Lovelace", emailVerified: true });
    expect(body.workspace.kind).toBe("personal");
    const acct = await env.DB.prepare("SELECT provider_id, account_id FROM accounts WHERE user_id = ?1").bind(body.user.id).first();
    expect(acct).toEqual({ provider_id: "google", account_id: "google-sub-1" });
  });

  it("redirects to the error page on a bad state", async () => {
    const res = await call(
      new Request(`${BASE}/api/auth/callback/google?code=x&state=forged`, { redirect: "manual" }),
      { GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "secret-456" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("rolling.session_token=") && !c.startsWith("rolling.session_token=;"))).toBe(false);
  });
});

describe("auth context helpers", () => {
  const probe = new Hono<AppEnv>()
    .use("*", authMiddleware)
    .get("/member", (c) => c.json({ ok: requireMember(c).workspaceId }))
    .get("/owner", (c) => c.json({ ok: requireRole(c, "owner").role }))
    .get("/editor", (c) => c.json({ ok: requireRole(c, "editor").role }));
  probe.onError((err, c) => (err instanceof ApiError ? errorResponse(c, err.status, err.code, err.message, err.data) : c.text(String(err), 500)));

  async function hit(path: string, headers: Record<string, string>) {
    const ctx = createExecutionContext();
    const res = await probe.fetch(new Request(`${BASE}${path}`, { headers }), env, ctx);
    return { status: res.status, body: (await res.json()) as any };
  }

  it("requireMember answers NO_PLAN without an active plan, and passes with one", async () => {
    const { cookie } = await signIn(freshEmail("member"), { "cf-connecting-ip": freshIp() });
    const before = await hit("/member", { cookie });
    expect(before.status).toBe(402);
    expect(before.body.error.code).toBe("NO_PLAN");
    const { body } = await getMe(cookie);
    // An expired or canceled subscription does not count.
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, updated_at) VALUES (?1, ?2, 'plus', 'month', 'active', ?3, 0)",
    )
      .bind(`sub_old_${body.workspace.id}`, body.workspace.id, Date.now() - 1000)
      .run();
    await grantPlan(body.workspace.id, "starter", "canceled");
    expect((await hit("/member", { cookie })).status).toBe(402);
    await grantPlan(body.workspace.id, "plus", "trialing");
    expect(await hit("/member", { cookie })).toEqual({ status: 200, body: { ok: body.workspace.id } });
    const me = await getMe(cookie);
    expect(me.body).toMatchObject({ isMember: true, plan: { id: "plus", status: "trialing", interval: "month", perks: { seats: 1, maxVideoResolution: "1080p" } } });
  });

  it("requireUser answers 401 when signed out; requireRole checks the role", async () => {
    expect((await hit("/member", {})).status).toBe(401);
    expect((await hit("/owner", { "x-dev-user": "dev_owner_1" })).body).toEqual({ ok: "owner" });
    // A viewer in a team workspace.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (id, name, kind, mature_allowed, created_at) VALUES ('ws_team_roles', 'Team', 'team', 1, 0)"),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_team_roles', 'dev_viewer_1', 'viewer')"),
    ]);
    const viewer = { "x-dev-user": "dev_viewer_1", "x-workspace-id": "ws_team_roles" };
    const res = await hit("/editor", viewer);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "FORBIDDEN", data: { required: "editor", role: "viewer" } });
  });

  it("matureAllowed needs a plan, the preference and the workspace switch (D-005)", async () => {
    const { cookie } = await signIn(freshEmail("mature"), { "cf-connecting-ip": freshIp() });
    const { body } = await getMe(cookie);
    const patch = (b: unknown) => SELF.fetch(`${BASE}/api/me/prefs`, { method: "PATCH", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(b) });
    const denied = await patch({ matureContent: true });
    expect(denied.status).toBe(402);
    expect(await denied.json()).toMatchObject({ error: { code: "NO_PLAN" } });
    await grantPlan(body.workspace.id, "pro");
    const ok = await patch({ matureContent: true });
    expect(await ok.json()).toMatchObject({ prefs: { matureContent: true }, matureAllowed: true });
    expect((await getMe(cookie)).body.matureAllowed).toBe(true);
    await env.DB.prepare("UPDATE workspaces SET mature_allowed = 0 WHERE id = ?1").bind(body.workspace.id).run();
    expect((await getMe(cookie)).body.matureAllowed).toBe(false);
  });

  it("ignores the dev header outside development", async () => {
    const res = await call(new Request(`${BASE}/api/me`, { headers: { "x-dev-user": "dev_someone" } }), { ENVIRONMENT: "staging" } as unknown as Partial<Env>);
    expect(res.status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { "x-dev-user": "dev_someone" } })).status).toBe(200);
  });
});
