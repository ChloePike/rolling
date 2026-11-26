/**
 * Better Auth on D1 (M1). Methods: email one-time code and Google (D-016: Google
 * ID tokens from Google Identity Services, verified against Google's keys; no
 * client secret, so the OAuth code flow is off).
 *
 * D1 goes straight into `database`: Better Auth's Kysely adapter detects the D1
 * binding and uses its built-in D1 dialect (no interactive transactions; D1
 * batches instead). Tables and snake_case columns come from migration 0004.
 *
 * One instance per isolate and env (cached); options depend on env only.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { waitUntil } from "cloudflare:workers";
import { newId, type IdKind } from "@rolling/core/ids";
import { emailProviderName, enqueueEmail } from "./email";
import { onUserCreated } from "./workspace";
import { purgeAccount } from "./deleteAccount";
import { googleAccessToken } from "./googleAccessToken";

/** Email code: 6 digits, valid 10 minutes, 5 tries per code. */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600;
export const OTP_ALLOWED_ATTEMPTS = 5;
/** Session lifetime 30 days, refreshed (sliding) once a day of use. */
export const SESSION_TTL_SECONDS = 30 * 86_400;
export const COOKIE_PREFIX = "rolling";
/** Session cookie name: `__Secure-rolling.session_token` on https, `rolling.session_token` on http://localhost. */
export function sessionCookieName(env: Env): string {
  return `${authBaseUrl(env).startsWith("https://") ? "__Secure-" : ""}${COOKIE_PREFIX}.session_token`;
}

const ID_KIND: Record<string, IdKind> = { user: "user", session: "session", account: "account", verification: "verification" };

type Auth = Awaited<ReturnType<typeof buildAuth>>;
const cache = new WeakMap<object, Promise<Auth>>();

/** Social providers whose credentials are configured (others are not offered). Google needs only its public client id. */
export function configuredProviders(env: Env): "google"[] {
  return env.GOOGLE_CLIENT_ID ? ["google"] : [];
}

function socialProviders(env: Env): NonNullable<BetterAuthOptions["socialProviders"]> {
  if (!env.GOOGLE_CLIENT_ID) return {};
  // No clientSecret: Better Auth's authorization-code redirect refuses to start without
  // one, and routes/auth.ts closes `/sign-in/social` (without `idToken`), `/callback/*`
  // and `/link-social` anyway. ID-token sign-in verifies against Google's JWKS.
  return { google: { clientId: env.GOOGLE_CLIENT_ID } };
}

export function authBaseUrl(env: Env): string {
  return (env.PUBLIC_APP_URL || "http://localhost:8787").replace(/\/+$/, "");
}

/**
 * Origins the app is served from: PUBLIC_APP_URL plus the optional comma-separated
 * EXTRA_TRUSTED_ORIGINS var (e.g. staging's workers.dev URL next to staging.rolling.actor).
 */
export function trustedOrigins(env: Env): string[] {
  const extra = ((env as { EXTRA_TRUSTED_ORIGINS?: string }).EXTRA_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => /^https?:\/\/[^/]+$/.test(o));
  return [...new Set([authBaseUrl(env), ...extra])];
}

/** The request's own origin when it is trusted, else PUBLIC_APP_URL (Google posts back to the origin the user is on). */
export function originFor(env: Env, requestUrl: string): string {
  const origin = new URL(requestUrl).origin;
  return trustedOrigins(env).includes(origin) ? origin : authBaseUrl(env);
}

async function buildAuth(env: Env) {
  const isDev = env.ENVIRONMENT === "development";
  if (!env.BETTER_AUTH_SECRET && !isDev) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  // Fail fast on email misconfiguration (e.g. EMAIL_PROVIDER=test-inbox in production).
  emailProviderName(env);
  const baseURL = authBaseUrl(env);
  return betterAuth({
    appName: env.APP_NAME || "Rolling",
    baseURL,
    basePath: "/api/auth",
    // Development and tests only: a fixed, non-secret value.
    secret: env.BETTER_AUTH_SECRET || "development-only-secret-not-for-production-use",
    database: env.DB,
    telemetry: { enabled: false },
    trustedOrigins: trustedOrigins(env),
    // Rate limits use the Workers rate-limit bindings (routes/auth.ts); Better Auth's
    // in-memory limiter is per isolate and would not hold across Workers.
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: false },
    user: {
      modelName: "users",
      fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
      // Reached only through `POST /api/me/delete` (emailed code → one-time token); `/api/auth/delete-user*` is blocked.
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await purgeAccount(env, user.id);
        },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 86_400,
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    account: {
      modelName: "accounts",
      // Google verifies emails (we also refuse `email_verified: false`), so a returning email-code user links.
      accountLinking: { enabled: true, trustedProviders: ["google", "email-otp"] },
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    socialProviders: socialProviders(env),
    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_TTL_SECONDS,
        allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        storeOTP: "hashed",
        // Email change: a code to the new address (`/api/auth/email-otp/request-email-change`, then `/change-email`).
        changeEmail: { enabled: true },
        async sendVerificationOTP({ email, otp, type }) {
          if (type === "change-email") {
            await enqueueEmail(env, { to: email, template: "change-email-code", data: { code: otp, expiresInMinutes: OTP_TTL_SECONDS / 60 } });
            return;
          }
          if (type !== "sign-in") return; // Only sign-in and email change are offered.
          await enqueueEmail(env, {
            to: email,
            template: "sign-in-code",
            data: { code: otp, expiresInMinutes: OTP_TTL_SECONDS / 60 },
          });
        },
      }),
      // D-017: access tokens from the GIS token client (our own button's popup).
      googleAccessToken(env.GOOGLE_CLIENT_ID),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            await onUserCreated(env, user.id, {
              email: user.email,
              name: user.name,
              acceptLanguage: ctx?.headers?.get("accept-language") ?? ctx?.request?.headers.get("accept-language") ?? null,
            });
          },
        },
      },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // `__Secure-` prefix on https; plain names on http://localhost (cookies keep `Secure`,
      // which browsers accept on localhost).
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        generateId: ({ model }) => {
          const kind = ID_KIND[model];
          return kind ? newId(kind) : crypto.randomUUID();
        },
        validateSchema: false,
      },
      backgroundTasks: { handler: (p) => waitUntil(p) },
    },
  });
}

export function getAuth(env: Env): Promise<Auth> {
  let auth = cache.get(env);
  if (!auth) {
    auth = buildAuth(env);
    auth.catch(() => cache.delete(env));
    cache.set(env, auth);
  }
  return auth;
}

/** Test seam: forget cached instances (after changing env bindings). */
export function resetAuthCache(env: Env): void {
  cache.delete(env);
}
