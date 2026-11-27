import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
      enhancePrompt: true,
      reviewResults: true,
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

  it("returns 401 with an unknown session cookie", async () => {
    const { res } = await getMe("rolling.session_token=nope.nope");
    expect(res.status).toBe(401);
  });
});

describe("Google ID-token sign-in (D-016, fake JWKS)", () => {
  const CLIENT_ID = "client-123.apps.googleusercontent.com";
  const googleEnv = { GOOGLE_CLIENT_ID: CLIENT_ID };
  const KID = "test-kid-1";
  let keys: CryptoKeyPair;
  let otherKeys: CryptoKeyPair;
  let jwksCalls = 0;

  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

  async function sign(claims: Record<string, unknown>, key: CryptoKey = keys.privateKey, kid = KID): Promise<string> {
    const head = `${b64json({ alg: "RS256", typ: "JWT", kid })}.${b64json(claims)}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head)));
    return `${head}.${b64url(sig)}`;
  }

  function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: `google-sub-${crypto.randomUUID()}`,
      email: freshEmail("google"),
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://example.com/a.png",
      iat: now - 10,
      exp: now + 3600,
      ...over,
    };
  }

  beforeAll(async () => {
    const gen = () =>
      crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
    keys = await gen();
    otherKeys = await gen();
  });

  beforeEach(async () => {
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
        jwksCalls++;
        return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
      }
      if (url.startsWith("https://oauth2.googleapis.com/")) throw new Error("code exchange must not be used");
      return realFetch(input as RequestInfo, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function nonce(redirect?: string): Promise<string> {
    const res = await call(new Request(`${BASE}/api/auth/nonce${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`, { headers: { "cf-connecting-ip": freshIp() } }), googleEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { nonce: string; expiresIn: number };
    expect(body.expiresIn).toBe(300);
    return body.nonce;
  }

  function signInWith(token: string, n: string) {
    return call(new Request(`${BASE}/api/auth/sign-in/social`, json({ provider: "google", idToken: { token, nonce: n } }, { "cf-connecting-ip": freshIp() })), googleEnv);
  }

  function sessionOf(res: Response): string {
    return cookieFrom(res)
      .split("; ")
      .filter((c) => c.startsWith("rolling.session_token="))
      .join("; ");
  }

  it("exposes the public client id and the credential endpoint, no secret needed", async () => {
    const off = await SELF.fetch(`${BASE}/api/auth/providers`);
    expect(await off.json()).toEqual({ emailCode: true, google: false });
    const on = await call(new Request(`${BASE}/api/auth/providers`), googleEnv);
    expect(await on.json()).toEqual({ emailCode: true, google: { clientId: CLIENT_ID, loginUri: `${ORIGIN}/api/auth/google/credential` } });
    // A second trusted origin (staging's workers.dev URL): Google posts back to the origin in use.
    const extra = { ...googleEnv, EXTRA_TRUSTED_ORIGINS: "https://old.example.workers.dev, https://other.example" } as Partial<Env>;
    const viaExtra = await call(new Request("https://old.example.workers.dev/api/auth/providers"), extra);
    expect(((await viaExtra.json()) as any).google.loginUri).toBe("https://old.example.workers.dev/api/auth/google/credential");
    const untrusted = await call(new Request("https://evil.example/api/auth/providers"), extra);
    expect(((await untrusted.json()) as any).google.loginUri).toBe(`${ORIGIN}/api/auth/google/credential`);
  });

  it("popup / One Tap: a valid token with a fresh nonce creates the user, workspace and session", async () => {
    const n = await nonce("/templates");
    const c = claims({ nonce: n });
    const res = await signInWith(await sign(c), n);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { user: { email: string }; redirectTo: string };
    expect(body.user.email).toBe(c.email);
    expect(body.redirectTo).toBe("/templates");
    expect(body).not.toHaveProperty("token");
    expect(jwksCalls).toBeGreaterThan(0);
    const session = sessionOf(res);
    expect(session).not.toBe("");
    const me = await call(new Request(`${BASE}/api/me`, { headers: { cookie: session } }), googleEnv);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as any;
    expect(meBody.user).toMatchObject({ email: c.email, name: "Ada Lovelace", emailVerified: true });
    expect(meBody.workspace.kind).toBe("personal");
    const acct = await env.DB.prepare("SELECT provider_id, account_id FROM accounts WHERE user_id = ?1").bind(meBody.user.id).first();
    expect(acct).toEqual({ provider_id: "google", account_id: c.sub });
    // The nonce is stored hashed, and is gone once used.
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM verifications WHERE identifier LIKE 'google-nonce:%' AND value LIKE ?1").bind(`%${n}%`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("links to an existing email-code account with the same address", async () => {
    const email = freshEmail("both");
    const first = await signIn(email, { "cf-connecting-ip": freshIp() });
    const me1 = await getMe(first.cookie);
    const n = await nonce();
    const res = await signInWith(await sign(claims({ email, nonce: n })), n);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(me1.body.user.id);
  });

  it("refuses a wrong audience, an expired token and a bad signature", async () => {
    for (const [label, make] of [
      ["wrong aud", async (n: string) => sign(claims({ nonce: n, aud: "someone-else.apps.googleusercontent.com" }))],
      ["wrong iss", async (n: string) => sign(claims({ nonce: n, iss: "https://evil.example" }))],
      ["expired", async (n: string) => sign(claims({ nonce: n, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }))],
      ["bad signature", async (n: string) => sign(claims({ nonce: n }), otherKeys.privateKey)],
    ] as const) {
      const n = await nonce();
      const res = await signInWith(await make(n), n);
      expect(res.status, label).toBe(401);
      expect(((await res.json()) as any).error.code, label).toBe("UNAUTHENTICATED");
      expect(sessionOf(res), label).toBe("");
    }
  });

  it("refuses a wrong, unknown or reused nonce", async () => {
    // The token carries a different nonce than the one sent.
    const a = await nonce();
    const b = await nonce();
    const mismatch = await signInWith(await sign(claims({ nonce: a })), b);
    expect(mismatch.status).toBe(401);
    expect(((await mismatch.json()) as any).error.data.reason).toBe("NONCE");
    // A nonce we never issued.
    const forged = "f".repeat(43);
    const unknown = await signInWith(await sign(claims({ nonce: forged })), forged);
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as any).error.data.reason).toBe("NONCE");
    // Used once, then refused.
    const n = await nonce();
    const token = await sign(claims({ nonce: n }));
    expect((await signInWith(token, n)).status).toBe(200);
    const again = await signInWith(token, n);
    expect(again.status).toBe(401);
    expect(((await again.json()) as any).error.data.reason).toBe("NONCE");
    // Expired nonce row.
    const old = await nonce();
    await env.DB.prepare("UPDATE verifications SET expires_at = ?1 WHERE identifier LIKE 'google-nonce:%'").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await signInWith(await sign(claims({ nonce: old })), old)).status).toBe(401);
  });

  it("refuses an unverified email", async () => {
    const n = await nonce();
    const res = await signInWith(await sign(claims({ nonce: n, email_verified: false })), n);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatchObject({ code: "FORBIDDEN", data: { reason: "EMAIL_NOT_VERIFIED" } });
    expect(sessionOf(res)).toBe("");
  });

  it("closes the OAuth code flow (no client secret)", async () => {
    const start = await call(new Request(`${BASE}/api/auth/sign-in/social`, json({ provider: "google", callbackURL: "/" })), googleEnv);
    expect(start.status).toBe(400);
    expect((await call(new Request(`${BASE}/api/auth/callback/google?code=x&state=y`, { redirect: "manual" }), googleEnv)).status).toBe(404);
    expect((await call(new Request(`${BASE}/api/auth/link-social`, json({ provider: "google" })), googleEnv)).status).toBe(404);
  });

  describe("redirect fallback: POST /api/auth/google/credential", () => {
    function post(form: Record<string, string>, cookie?: string) {
      const body = new URLSearchParams(form).toString();
      return call(
        new Request(`${BASE}/api/auth/google/credential`, {
          method: "POST",
          // A cross-site form post from Google.
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://accounts.google.com", "cf-connecting-ip": freshIp(), ...(cookie ? { cookie } : {}) },
          body,
          redirect: "manual",
        }),
        googleEnv,
      );
    }

    it("refuses a g_csrf_token that does not match the cookie", async () => {
      const n = await nonce();
      const token = await sign(claims({ nonce: n }));
      const res = await post({ credential: token, g_csrf_token: "aaaa" }, "g_csrf_token=bbbb");
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).search).toContain("error=csrf");
      expect(sessionOf(res)).toBe("");
      const none = await post({ credential: token, g_csrf_token: "aaaa" });
      expect(new URL(none.headers.get("location")!).search).toContain("error=csrf");
    });

    it("GIS redirect mode: a valid credential sets the session and 303s to the saved redirect", async () => {
      const n = await nonce("/templates");
      const c = claims({ nonce: n });
      const res = await post({ credential: await sign(c), g_csrf_token: "csrf-123" }, "g_csrf_token=csrf-123");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/templates`);
      const session = sessionOf(res);
      expect(session).not.toBe("");
      const me = await call(new Request(`${BASE}/api/me`, { headers: { cookie: session } }), googleEnv);
      expect(((await me.json()) as any).user.email).toBe(c.email);
    });

    it("a token without a nonce lands on / ; a bad audience is refused", async () => {
      const ok = await post({ credential: await sign(claims()), g_csrf_token: "x1" }, "g_csrf_token=x1");
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe(`${ORIGIN}/`);
      expect(sessionOf(ok)).not.toBe("");

      const n = await nonce();
      const bad = await post({ credential: await sign(claims({ nonce: n, aud: "other.apps.googleusercontent.com" })), g_csrf_token: "x2" }, "g_csrf_token=x2");
      expect(bad.status).toBe(303);
      expect(new URL(bad.headers.get("location")!).search).toContain("error=invalid_token");
      expect(sessionOf(bad)).toBe("");

      const unverified = await post({ credential: await sign(claims({ email_verified: false })), g_csrf_token: "x3" }, "g_csrf_token=x3");
      expect(new URL(unverified.headers.get("location")!).search).toContain("error=email_not_verified");
    });

    it("script-free start: /google/start → Google (nonce, state cookie) → form_post id_token + state", async () => {
      const start = await call(new Request(`${BASE}/api/auth/google/start?redirect=%2Fupgrade`, { headers: { "cf-connecting-ip": freshIp() }, redirect: "manual" }), googleEnv);
      expect(start.status).toBe(302);
      const url = new URL(start.headers.get("location")!);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("response_type")).toBe("id_token");
      expect(url.searchParams.get("response_mode")).toBe("form_post");
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/credential`);
      const state = url.searchParams.get("state")!;
      const n = url.searchParams.get("nonce")!;
      const setCookie = start.headers.getSetCookie().find((c) => c.startsWith("rolling.g_state="))!;
      expect(setCookie).toMatch(/SameSite=None/i);
      expect(setCookie).toMatch(/HttpOnly/i);

      // Wrong state, then a token without the nonce: both refused.
      expect(new URL((await post({ id_token: await sign(claims({ nonce: n })), state: "nope" }, `rolling.g_state=${state}`)).headers.get("location")!).search).toContain("error=csrf");
      expect(new URL((await post({ id_token: await sign(claims()), state }, `rolling.g_state=${state}`)).headers.get("location")!).search).toContain("error=nonce");

      const res = await post({ id_token: await sign(claims({ nonce: n })), state }, `rolling.g_state=${state}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/upgrade`);
      expect(sessionOf(res)).not.toBe("");
    });

    it("links Google to the signed-in user (Settings), refusing an account owned by someone else", async () => {
      const email = freshEmail("link");
      const { cookie } = await signIn(email, { "cf-connecting-ip": freshIp() });
      const me = await getMe(cookie);
      const start = await call(new Request(`${BASE}/api/auth/google/start?intent=link&redirect=%2Fsettings%2Faccount`, { headers: { cookie, "cf-connecting-ip": freshIp() }, redirect: "manual" }), googleEnv);
      const url = new URL(start.headers.get("location")!);
      const state = url.searchParams.get("state")!;
      const sub = `google-sub-${crypto.randomUUID()}`;
      const res = await post({ id_token: await sign(claims({ sub, email: "other-address@example.com", nonce: url.searchParams.get("nonce")! })), state }, `rolling.g_state=${state}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/settings/account`);
      expect(sessionOf(res)).toBe("");
      const acct = await env.DB.prepare("SELECT user_id FROM accounts WHERE provider_id = 'google' AND account_id = ?1").bind(sub).first<{ user_id: string }>();
      expect(acct?.user_id).toBe(me.body.user.id);
    });
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
