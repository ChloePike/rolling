/**
 * `/api/auth/*` — Better Auth (email code, Google, Apple) plus our own guards:
 * rate limits per email + IP, a 30 s resend cooldown, logout, and Better Auth
 * errors rewritten into the API error envelope.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, errorEnvelope, type ErrorCode } from "../lib/errors";
import { configuredProviders, getAuth } from "../auth/betterAuth";
import { clientIp, limitOrThrow, sha256Hex } from "../auth/rateLimit";

/** Seconds between two codes to the same address. */
export const RESEND_COOLDOWN_SECONDS = 30;

const Email = z.string().trim().toLowerCase().email().max(254);
const SendCodeBody = z.object({ email: Email, type: z.literal("sign-in") });
const RequestEmailChangeBody = z.object({ newEmail: Email }).strict();
const ChangeEmailBody = z.object({ newEmail: Email, otp: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits") }).strict();
const SignInBody = z.object({ email: Email, otp: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits") }).passthrough();

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

export const authRoutes = new Hono<AppEnv>()
  /** Which sign-in methods are available (the login screen hides unconfigured ones). */
  .get("/providers", (c) => {
    const social = configuredProviders(c.env);
    return c.json({ emailCode: true, google: social.includes("google"), apple: social.includes("apple") });
  })
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
  // Better Auth's own endpoints: OAuth (sign-in/social, callback/:provider), get-session, sign-out, ...
  .on(["GET", "POST"], "/*", (c) => forward(c));
