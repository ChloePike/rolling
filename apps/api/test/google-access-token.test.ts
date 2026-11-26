import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { BASE, cookieFrom, freshEmail, freshIp, getMe, json, signIn } from "./auth-helpers";

/** D-017: `POST /api/auth/google/access-token` with Google's tokeninfo / userinfo mocked. */
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const googleEnv = { GOOGLE_CLIENT_ID: CLIENT_ID } as Partial<Env>;

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...googleEnv } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface FakeAccount {
  tokeninfo?: Record<string, unknown>;
  tokeninfoStatus?: number;
  userinfo?: Record<string, unknown>;
}

/** Access tokens Google "knows" in this test. */
const accounts = new Map<string, FakeAccount>();
const seen: string[] = [];

function account(over: { tokeninfo?: Record<string, unknown>; userinfo?: Record<string, unknown>; tokeninfoStatus?: number } = {}) {
  const token = `ya29.test-${crypto.randomUUID()}`;
  const sub = `google-sub-${crypto.randomUUID()}`;
  const email = freshEmail("gat");
  const now = Math.floor(Date.now() / 1000);
  const a: FakeAccount = {
    tokeninfo: {
      azp: CLIENT_ID,
      aud: CLIENT_ID,
      sub,
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      exp: String(now + 3500),
      expires_in: "3500",
      email,
      email_verified: "true",
      access_type: "online",
      ...over.tokeninfo,
    },
    tokeninfoStatus: over.tokeninfoStatus,
    userinfo: { sub, email, email_verified: true, name: "Grace Hopper", picture: "https://example.com/g.png", ...over.userinfo },
  };
  accounts.set(token, a);
  return { token, sub, email };
}

beforeEach(() => {
  seen.length = 0;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      seen.push("tokeninfo");
      const a = accounts.get(new URL(url).searchParams.get("access_token") ?? "");
      if (!a || a.tokeninfoStatus) return Response.json({ error: "invalid_token", error_description: "Invalid Value" }, { status: a?.tokeninfoStatus ?? 400 });
      return Response.json(a.tokeninfo);
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      seen.push("userinfo");
      const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "";
      const a = accounts.get(auth.replace(/^Bearer /, ""));
      if (!a) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json(a.userinfo);
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) throw new Error("code exchange must not be used");
    return realFetch(input as RequestInfo, init);
  });
});
afterEach(() => vi.restoreAllMocks());

function post(body: unknown, headers: Record<string, string> = {}) {
  return call(new Request(`${BASE}/api/auth/google/access-token`, json(body, { "cf-connecting-ip": freshIp(), ...headers })));
}

function sessionOf(res: Response): string {
  return cookieFrom(res)
    .split("; ")
    .filter((c) => c.startsWith("rolling.session_token="))
    .join("; ");
}

describe("Google access-token sign-in (D-017, mocked tokeninfo/userinfo)", () => {
  it("valid token: creates the user and workspace from Google's userinfo and sets a session", async () => {
    const a = account();
    const res = await post({ accessToken: a.token, redirect: "/templates" });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { user: { email: string }; redirectTo: string };
    expect(body).toMatchObject({ user: { email: a.email }, redirectTo: "/templates" });
    expect(seen).toEqual(["tokeninfo", "userinfo"]);
    const session = sessionOf(res);
    expect(session).not.toBe("");
    const me = await call(new Request(`${BASE}/api/me`, { headers: { cookie: session } }));
    const meBody = (await me.json()) as any;
    expect(meBody.user).toMatchObject({ email: a.email, name: "Grace Hopper", emailVerified: true });
    expect(meBody.workspace.kind).toBe("personal");
    const acct = await env.DB.prepare("SELECT account_id, access_token FROM accounts WHERE user_id = ?1 AND provider_id = 'google'").bind(meBody.user.id).first();
    expect(acct).toEqual({ account_id: a.sub, access_token: null });
  });

  it("ignores client-sent profile fields and unsafe redirects", async () => {
    const a = account();
    const extra = await post({ accessToken: a.token, email: "attacker@example.com" });
    expect(extra.status).toBe(400);
    const res = await post({ accessToken: a.token, redirect: "https://evil.example/" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).redirectTo).toBe("/");
  });

  it("links to an existing email-code account with the same verified address", async () => {
    const email = freshEmail("gat-both");
    const first = await signIn(email, { "cf-connecting-ip": freshIp() });
    const me1 = await getMe(first.cookie);
    const a = account({ userinfo: { email } });
    const res = await post({ accessToken: a.token });
    expect(res.status, await res.clone().text()).toBe(200);
    const me2 = await call(new Request(`${BASE}/api/me`, { headers: { cookie: sessionOf(res) } }));
    expect(((await me2.json()) as any).user.id).toBe(me1.body.user.id);
  });

  it.each([
    ["wrong aud", { tokeninfo: { aud: "someone-else.apps.googleusercontent.com", azp: "someone-else.apps.googleusercontent.com" } }, 401, "INVALID_TOKEN"],
    ["azp mismatch", { tokeninfo: { azp: "someone-else.apps.googleusercontent.com" } }, 401, "INVALID_TOKEN"],
    ["expired / invalid token (tokeninfo 400)", { tokeninfoStatus: 400 }, 401, "INVALID_TOKEN"],
    ["exp in the past", { tokeninfo: { exp: String(Math.floor(Date.now() / 1000) - 5), expires_in: "0" } }, 401, "INVALID_TOKEN"],
    ["unverified email", { userinfo: { email_verified: false } }, 403, "EMAIL_NOT_VERIFIED"],
    ["missing email scope", { tokeninfo: { scope: "openid https://www.googleapis.com/auth/userinfo.profile" } }, 401, "SCOPE"],
    ["userinfo for a different account", { userinfo: { sub: "someone-else" } }, 401, "INVALID_TOKEN"],
  ])("refuses: %s", async (_name, over, status, reason) => {
    const a = account(over as never);
    const res = await post({ accessToken: a.token });
    expect(res.status, await res.clone().text()).toBe(status);
    const body = (await res.json()) as { error: { data: { reason: string } } };
    expect(body.error.data.reason).toBe(reason);
    expect(sessionOf(res)).toBe("");
    if (reason !== "EMAIL_NOT_VERIFIED") {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?1").bind(a.email).first<{ n: number }>();
      expect(n?.n).toBe(0);
    }
  });

  it("refuses an unknown token without calling userinfo", async () => {
    const res = await post({ accessToken: "ya29.not-a-real-token-at-all" });
    expect(res.status).toBe(401);
    expect(seen).toEqual(["tokeninfo"]);
  });

  it("refuses a cookie-bearing POST from an untrusted Origin (CSRF)", async () => {
    const a = account();
    const res = await post({ accessToken: a.token }, { origin: "https://evil.example", cookie: "rolling.session_token=x" });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("validates the body and is off without GOOGLE_CLIENT_ID", async () => {
    expect((await post({})).status).toBe(400);
    const ctx = createExecutionContext();
    const off = await worker.fetch(new Request(`${BASE}/api/auth/google/access-token`, json({ accessToken: "ya29.aaaaaaaaaaaaaaaaaaaaaaaa" })), { ...env, GOOGLE_CLIENT_ID: "" } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(off.status).toBe(404);
  });

  it("intent link: links Google to the signed-in user, refusing an account owned by someone else", async () => {
    const { cookie } = await signIn(freshEmail("gat-link"), { "cf-connecting-ip": freshIp() });
    const me = await getMe(cookie);
    const a = account({ userinfo: { email: "other-address@example.com" } });
    const res = await post({ accessToken: a.token, intent: "link" }, { cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ linked: true });
    expect(sessionOf(res)).toBe("");
    const acct = await env.DB.prepare("SELECT user_id FROM accounts WHERE provider_id = 'google' AND account_id = ?1").bind(a.sub).first<{ user_id: string }>();
    expect(acct?.user_id).toBe(me.body.user.id);

    const other = await signIn(freshEmail("gat-link2"), { "cf-connecting-ip": freshIp() });
    const again = await post({ accessToken: a.token, intent: "link" }, { cookie: other.cookie });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.data.reason).toBe("ACCOUNT_IN_USE");

    const signedOut = await post({ accessToken: a.token, intent: "link" });
    expect(signedOut.status).toBe(401);
  });

  it("is rate limited per IP before Google is called", async () => {
    const a = account();
    const keys: string[] = [];
    const RATE_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/api/auth/google/access-token`, json({ accessToken: a.token }, { "cf-connecting-ip": "203.0.113.9" })),
      { ...env, ...googleEnv, RATE_LIMIT } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(keys).toEqual(["auth-ip:203.0.113.9"]);
    expect(seen).toEqual([]);
  });
});
