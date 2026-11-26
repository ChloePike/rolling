/**
 * `/api/auth/*` — Better Auth (email code, Google) plus our own guards:
 * rate limits per email + IP, a 30 s resend cooldown, logout, and Better Auth
 * errors rewritten into the API error envelope.
 *
 * Google (D-016) is ID-token only, with no client secret: the SPA gets a nonce
 * (`GET /nonce`), Google Identity Services returns an ID token (popup / One Tap →
 * `POST /sign-in/social` with `idToken`; redirect mode → Google posts it to
 * `POST /google/credential`). Better Auth's OAuth code flow (`/sign-in/social`
 * without `idToken`, `/callback/*`, `/link-social`) is closed.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, errorEnvelope, type ErrorCode } from "../lib/errors";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { configuredProviders, getAuth, originFor } from "../auth/betterAuth";
import { clientIp, limitOrThrow, sha256Hex } from "../auth/rateLimit";
import {
  authorizeUrl,
  consumeNonce,
  credentialUri,
  emailVerified,
  GIS_CSRF_COOKIE,
  issueNonce,
  NONCE_TTL_SECONDS,
  peekClaims,
  randomToken,
  readCookie,
  safeAppPath,
  sameValue,
  STATE_COOKIE,
  type NonceData,
} from "../auth/google";

/** Seconds between two codes to the same address. */
export const RESEND_COOLDOWN_SECONDS = 30;

const Email = z.string().trim().toLowerCase().email().max(254);
const SendCodeBody = z.object({ email: Email, type: z.literal("sign-in") });
const RequestEmailChangeBody = z.object({ newEmail: Email }).strict();
const ChangeEmailBody = z.object({ newEmail: Email, otp: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits") }).strict();
const SignInBody = z.object({ email: Email, otp: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits") }).passthrough();
const Nonce = z.string().min(16).max(256);
/** Google ID-token sign-in (popup, One Tap). The redirect (code) flow is not offered. */
const IdTokenSignInBody = z.object({
  provider: z.literal("google"),
  idToken: z.object({ token: z.string().min(20).max(8192), nonce: Nonce }),
  callbackURL: z.string().max(512).optional(),
});

const AUTH_CODE_MAP: Record<string, ErrorCode> = {
  INVALID_OTP: "INVALID_CODE",
  OTP_EXPIRED: "CODE_EXPIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
};

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL";
  return "BAD_REQUEST";
}

/** Rewrites Better Auth JSON errors (`{ code, message }`) into `{ error: { code, message, data } }`. */
async function toEnvelope(res: Response): Promise<Response> {
  if (res.status < 400 || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: string; message?: string } | null;
  if (!body || "error" in body) return res;
  const authCode = typeof body.code === "string" ? body.code : undefined;
  const code = (authCode && AUTH_CODE_MAP[authCode]) || codeForStatus(res.status);
  const status = code === "TOO_MANY_ATTEMPTS" ? 429 : res.status;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(errorEnvelope(code, body.message || "Sign-in failed", authCode ? { authCode } : {})), {
    status,
    headers,
  });
}

async function readJson(c: Context<AppEnv>): Promise<{ text: string; json: unknown }> {
  const text = await c.req.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Body must be valid JSON");
  }
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_FAILED", "Request validation failed", {
      target: "json",
      issues: r.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    });
  }
  return r.data;
}

/** Forwards to Better Auth with a (re)built body. */
async function forward(c: Context<AppEnv>, body?: string): Promise<Response> {
  const auth = await getAuth(c.env);
  const req = body === undefined ? c.req.raw : new Request(c.req.raw.url, { method: c.req.method, headers: c.req.raw.headers, body });
  return toEnvelope(await auth.handler(req));
}

/**
 * Reserves the resend slot for `email`: succeeds when the last code went out at
 * least RESEND_COOLDOWN_SECONDS ago (atomic upsert), else RATE_LIMITED with `retryAfter`.
 */
async function reserveSend(env: Env, emailHash: string, now: number): Promise<void> {
  const cutoff = now - RESEND_COOLDOWN_SECONDS * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO auth_email_sends (email, last_sent_at) VALUES (?1, ?2)
     ON CONFLICT (email) DO UPDATE SET last_sent_at = excluded.last_sent_at WHERE auth_email_sends.last_sent_at <= ?3
     RETURNING last_sent_at`,
  )
    .bind(emailHash, now, cutoff)
    .first<{ last_sent_at: number }>();
  if (!row) {
    const last = await env.DB.prepare("SELECT last_sent_at FROM auth_email_sends WHERE email = ?1").bind(emailHash).first<{ last_sent_at: number }>();
    const retryAfter = Math.max(1, Math.ceil(((last?.last_sent_at ?? now) + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000));
    throw new ApiError(429, "RATE_LIMITED", "Wait a moment before asking for another code", { retryAfter });
  }
}


/** Headers Better Auth may use when called internally (no cookies, no Origin). */
function internalHeaders(req: Request): Headers {
  const h = new Headers();
  for (const k of ["user-agent", "cf-connecting-ip", "accept-language"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  return h;
}

/** Copies Better Auth's Set-Cookie headers onto `res`. */
function withCookies(res: Response, from: Headers): Response {
  for (const v of from.getSetCookie()) res.headers.append("set-cookie", v);
  return res;
}

function stateCookie(value: string, maxAge: number): string {
  // SameSite=None: Google posts the form cross-site; Lax cookies would not come along.
  return `${STATE_COOKIE}=${value}; Path=/api/auth/google; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}

/** 303 back into the app; failures land on `/login?error=<code>` (the login page explains them). */
function seeOther(origin: string, path: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 303, headers: { location: new URL(path, origin).toString(), "cache-control": "no-store" } });
  for (const v of cookies) res.headers.append("set-cookie", v);
  return res;
}

function failTo(origin: string, error: string, data?: NonceData | null): Response {
  const q = new URLSearchParams({ error });
  if (data?.redirect) q.set("redirect", data.redirect);
  const page = data?.linkUserId ? "/settings/account" : "/login";
  return seeOther(origin, `${page}?${q}`, [stateCookie("", 0)]);
}

/**
 * Links the Google account in `token` to `userId` (Settings → Sign-in methods).
 * Verifies the token like sign-in does; refuses an account that belongs to someone else.
 */
async function linkGoogle(env: Env, userId: string, token: string, nonce: string, sub: string): Promise<"ok" | "invalid_token" | "account_in_use"> {
  const auth = await getAuth(env);
  const ctx = await auth.$context;
  const provider = ctx.socialProviders.find((p) => p.id === "google");
  if (!provider || !(await verifyProviderIdToken(provider, token, nonce))) return "invalid_token";
  const existing = await ctx.internalAdapter.findAccountByKey({ providerId: "google", accountId: sub });
  if (existing) return existing.userId === userId ? "ok" : "account_in_use";
  await ctx.internalAdapter.linkAccount({ userId, providerId: "google", accountId: sub });
  return "ok";
}

export const authRoutes = new Hono<AppEnv>()
  /** Which sign-in methods are available (the login screen hides unconfigured ones). */
  .get("/providers", (c) => {
    const google = configuredProviders(c.env).includes("google") ? { clientId: c.env.GOOGLE_CLIENT_ID!, loginUri: credentialUri(originFor(c.env, c.req.url)) } : false;
    return c.json({ emailCode: true, google });
  })
  /**
   * A single-use nonce for Google ID-token sign-in (5 minutes). `?redirect=` is kept
   * with it for the redirect fallback (where Google posts the token, not the SPA).
   */
  .get("/nonce", async (c) => {
    if (!configuredProviders(c.env).includes("google")) throw new ApiError(404, "NOT_FOUND", "Google sign-in is not configured");
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${clientIp(c.req.raw)}`);
    const redirect = safeAppPath(c.req.query("redirect"));
    const nonce = await issueNonce(c.env, redirect ? { redirect } : {});
    c.header("cache-control", "no-store");
    return c.json({ nonce, expiresIn: NONCE_TTL_SECONDS });
  })
  /**
   * Google ID-token sign-in (popup, One Tap): `{ provider: "google", idToken: { token, nonce } }`.
   * Requires a live nonce from `GET /nonce` (used once) and `email_verified`; Better Auth
   * checks the signature (Google JWKS), `aud`, `iss`, `exp` and that the token carries the nonce.
   */
  .post("/sign-in/social", async (c) => {
    const { json } = await readJson(c);
    const body = parse(IdTokenSignInBody, json);
    if (!configuredProviders(c.env).includes("google")) throw new ApiError(404, "NOT_FOUND", "Google sign-in is not configured");
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${clientIp(c.req.raw)}`);
    const { token, nonce } = body.idToken;
    const claims = peekClaims(token);
    if (!claims) throw new ApiError(401, "UNAUTHENTICATED", "Invalid ID token", { reason: "INVALID_TOKEN" });
    if (claims.nonce !== nonce) throw new ApiError(401, "UNAUTHENTICATED", "The ID token was not issued for this nonce", { reason: "NONCE" });
    const data = await consumeNonce(c.env, nonce);
    if (!data) throw new ApiError(401, "UNAUTHENTICATED", "Sign-in expired. Try again.", { reason: "NONCE" });
    if (!emailVerified(claims)) throw new ApiError(403, "FORBIDDEN", "This Google account's email is not verified", { reason: "EMAIL_NOT_VERIFIED" });
    const res = await forward(c, JSON.stringify({ provider: "google", idToken: { token, nonce } }));
    if (!res.ok) return res;
    const out = (await res.json()) as { user?: unknown };
    const reply = c.json({ user: out.user ?? null, redirectTo: safeAppPath(body.callbackURL) ?? data.redirect ?? "/" });
    for (const v of res.headers.getSetCookie()) reply.headers.append("set-cookie", v);
    return reply;
  })
  /**
   * Script-free fallback (GIS blocked, or Settings linking): OIDC implicit request with
   * `response_mode=form_post`, so Google posts `id_token` + `state` to `/google/credential`.
   * `?intent=link` links Google to the signed-in user instead of signing in.
   */
  .get("/google/start", async (c) => {
    const origin = originFor(c.env, c.req.url);
    if (!configuredProviders(c.env).includes("google")) return seeOther(origin, "/login?error=unavailable");
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${clientIp(c.req.raw)}`);
    const data: NonceData = {};
    const redirect = safeAppPath(c.req.query("redirect"));
    if (redirect) data.redirect = redirect;
    if (c.req.query("intent") === "link") {
      const auth = await getAuth(c.env);
      const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
      if (!session) return seeOther(origin, `/login?${new URLSearchParams({ redirect: redirect ?? "/settings/account" })}`);
      data.linkUserId = session.user.id;
    }
    const nonce = await issueNonce(c.env, data);
    const state = randomToken();
    const res = new Response(null, { status: 302, headers: { location: authorizeUrl(c.env, origin, nonce, state), "cache-control": "no-store" } });
    res.headers.append("set-cookie", stateCookie(state, NONCE_TTL_SECONDS));
    return res;
  })
  /**
   * Where Google posts the credential (cross-site form POST, so Better Auth's Origin
   * check does not apply here; the double-submit token does):
   * - GIS redirect mode: `credential` + `g_csrf_token` (must equal the `g_csrf_token` cookie);
   * - `/google/start`: `id_token` + `state` (must equal the `rolling.g_state` cookie).
   * Verifies the token (JWKS, aud, iss, exp, email_verified, nonce when present; the
   * nonce is required for `/google/start`), signs in through Better Auth's ID-token path
   * and 303s to the saved redirect (default `/`). Failures 303 to `/login?error=<code>`.
   */
  .post("/google/credential", async (c) => {
    const env = c.env;
    const origin = originFor(env, c.req.url);
    if (!configuredProviders(env).includes("google")) return failTo(origin, "unavailable");
    await limitOrThrow(env.RATE_LIMIT, `auth-ip:${clientIp(c.req.raw)}`);
    const form = await c.req.formData().catch(() => null);
    const field = (k: string) => {
      const v = form?.get(k);
      return typeof v === "string" ? v : "";
    };
    const cookies = c.req.header("cookie");
    let token = "";
    let nonceRequired = false;
    if (field("credential")) {
      const sent = field("g_csrf_token");
      const cookie = readCookie(cookies, GIS_CSRF_COOKIE) ?? "";
      if (!sent || !cookie || !sameValue(sent, cookie)) return failTo(origin, "csrf");
      token = field("credential");
    } else if (field("id_token")) {
      const sent = field("state");
      const cookie = readCookie(cookies, STATE_COOKIE) ?? "";
      if (!sent || !cookie || !sameValue(sent, cookie)) return failTo(origin, "csrf");
      token = field("id_token");
      nonceRequired = true;
    } else {
      // Google reports a refusal (`error=access_denied`) with the state only.
      return failTo(origin, field("error") === "access_denied" ? "access_denied" : "invalid_request");
    }
    const claims = peekClaims(token);
    if (!claims) return failTo(origin, "invalid_token");
    let data: NonceData | null = null;
    const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
    if (nonce) {
      data = await consumeNonce(env, nonce);
      if (!data) return failTo(origin, "nonce");
    } else if (nonceRequired) {
      return failTo(origin, "nonce");
    }
    if (!emailVerified(claims)) return failTo(origin, "email_not_verified", data);
    if (data?.linkUserId) {
      const r = await linkGoogle(env, data.linkUserId, token, nonce, claims.sub);
      if (r !== "ok") return failTo(origin, r, data);
      return seeOther(origin, data.redirect ?? "/settings/account", [stateCookie("", 0)]);
    }
    const auth = await getAuth(env);
    try {
      const { headers } = await auth.api.signInSocial({
        body: { provider: "google", idToken: nonce ? { token, nonce } : { token } },
        headers: internalHeaders(c.req.raw),
        returnHeaders: true,
      });
      return withCookies(seeOther(origin, data?.redirect ?? "/", [stateCookie("", 0)]), headers);
    } catch {
      return failTo(origin, "invalid_token", data);
    }
  })
  /** The OAuth code flow needs a client secret we do not have (D-016): closed. */
  .on(["GET", "POST"], ["/callback/*", "/link-social", "/oauth2/*"], (c) => c.json(errorEnvelope("NOT_FOUND", "Route not found"), 404))
  .post("/email-otp/send-verification-otp", async (c) => {
    const { json } = await readJson(c);
    const body = parse(SendCodeBody, json);
    const ip = clientIp(c.req.raw);
    const emailHash = await sha256Hex(body.email);
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${ip}`);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `otp-send:${emailHash}:${ip}`, "Too many codes requested. Try again in a minute.");
    await reserveSend(c.env, emailHash, Date.now());
    return forward(c, JSON.stringify(body));
  })
  .post("/sign-in/email-otp", async (c) => {
    const { json } = await readJson(c);
    const body = parse(SignInBody, json);
    const ip = clientIp(c.req.raw);
    const emailHash = await sha256Hex(body.email);
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${ip}`);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `otp-verify:${emailHash}:${ip}`, "Too many attempts. Try again in a minute.");
    return forward(c, JSON.stringify({ email: body.email, otp: body.otp }));
  })
  /** Email change, step 1: a code to the new address (Better Auth email OTP `change-email`). Signed in. */
  .post("/email-otp/request-email-change", async (c) => {
    const { json } = await readJson(c);
    const body = parse(RequestEmailChangeBody, json);
    const ip = clientIp(c.req.raw);
    const emailHash = await sha256Hex(`change:${body.newEmail}`);
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${ip}`);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `email-change:${emailHash}:${ip}`, "Too many codes requested. Try again in a minute.");
    await reserveSend(c.env, emailHash, Date.now());
    return forward(c, JSON.stringify(body));
  })
  /** Email change, step 2: `{ newEmail, otp }` → the account's email becomes `newEmail` (verified). */
  .post("/email-otp/change-email", async (c) => {
    const { json } = await readJson(c);
    const body = parse(ChangeEmailBody, json);
    const ip = clientIp(c.req.raw);
    await limitOrThrow(c.env.RATE_LIMIT, `auth-ip:${ip}`);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `email-change-verify:${await sha256Hex(body.newEmail)}:${ip}`, "Too many attempts. Try again in a minute.");
    const res = await forward(c, JSON.stringify(body));
    if (res.status === 400) {
      const env = (await res.clone().json().catch(() => null)) as { error?: { message?: string } } | null;
      if (env?.error?.message === "Email already in use") {
        return c.json(errorEnvelope("CONFLICT", "That email belongs to another account", { reason: "EMAIL_IN_USE" }), 409);
      }
    }
    return res;
  })
  /** Account deletion goes through `POST /api/me/delete` (emailed code); Better Auth's own routes are closed. */
  .on(["GET", "POST"], ["/delete-user", "/delete-user/*"], (c) => c.json(errorEnvelope("NOT_FOUND", "Route not found"), 404))
  /** Ends the current session (D1 row deleted, cookie cleared). Always 200. */
  .post("/logout", async (c) => {
    const auth = await getAuth(c.env);
    const out = c.json({ ok: true });
    try {
      const { headers } = await auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true });
      for (const v of headers.getSetCookie()) out.headers.append("set-cookie", v);
    } catch {
      // No session: nothing to end.
    }
    return out;
  })
  // Better Auth's own endpoints: get-session, sign-out, list-accounts, unlink-account, ...
  .on(["GET", "POST"], "/*", (c) => forward(c));
