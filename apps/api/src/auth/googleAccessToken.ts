/**
 * Google sign-in with an OAuth access token from the GIS token client (D-017):
 * our own design button opens Google's popup (`initTokenClient`, implicit grant,
 * no client secret) and the SPA posts the access token here.
 *
 * Verification (nothing the client sends besides the token is trusted):
 * 1. `GET https://oauth2.googleapis.com/tokeninfo?access_token=` — `aud` and
 *    `azp` must equal GOOGLE_CLIENT_ID (a token minted for another app is
 *    refused), not expired, scope includes email.
 * 2. `GET https://openidconnect.googleapis.com/v1/userinfo` with the token —
 *    `sub` (must match tokeninfo), `email`, `email_verified` (required), name, picture.
 *
 * The user and session are then created or linked through Better Auth's
 * `handleOAuthUserInfo` + `setSessionCookie`, the same path its ID-token sign-in
 * takes (same account-linking rules). The endpoint is a Better Auth plugin, so
 * Better Auth's Origin check (cookie-bearing POSTs) and Fetch-Metadata CSRF check
 * apply as for every other auth POST.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { z } from "zod";

export const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const EMAIL_SCOPES = new Set(["email", "https://www.googleapis.com/auth/userinfo.email"]);

export type AccessTokenFailure = "INVALID_TOKEN" | "SCOPE" | "EMAIL_NOT_VERIFIED";

export class GoogleTokenError extends Error {
  constructor(readonly reason: AccessTokenFailure, message: string) {
    super(message);
  }
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: true;
  name: string;
  picture?: string;
}

interface TokenInfo {
  aud?: string;
  azp?: string;
  sub?: string;
  scope?: string;
  exp?: string | number;
  expires_in?: string | number;
  error?: string;
  error_description?: string;
}

interface UserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** Verifies `accessToken` with Google and returns the profile Google reports for it. */
export async function verifyGoogleAccessToken(clientId: string, accessToken: string, now = Date.now()): Promise<GoogleProfile> {
  const infoRes = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`, { headers: { accept: "application/json" } });
  // 400 `invalid_token` for unknown, revoked and expired tokens.
  if (!infoRes.ok) throw new GoogleTokenError("INVALID_TOKEN", "Invalid or expired Google access token");
  const info = (await infoRes.json().catch(() => null)) as TokenInfo | null;
  if (!info || info.error) throw new GoogleTokenError("INVALID_TOKEN", "Invalid or expired Google access token");
  if (info.aud !== clientId) throw new GoogleTokenError("INVALID_TOKEN", "The token was not issued to this app");
  if (info.azp !== undefined && info.azp !== clientId) throw new GoogleTokenError("INVALID_TOKEN", "The token was not issued to this app");
  const exp = Number(info.exp);
  const expiresIn = info.expires_in === undefined ? 1 : Number(info.expires_in);
  if (!Number.isFinite(exp) || exp * 1000 <= now || !(expiresIn > 0)) throw new GoogleTokenError("INVALID_TOKEN", "Invalid or expired Google access token");
  const scopes = (info.scope ?? "").split(/\s+/);
  if (!scopes.some((s) => EMAIL_SCOPES.has(s))) throw new GoogleTokenError("SCOPE", "The token does not allow reading the email address");

  const userRes = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!userRes.ok) throw new GoogleTokenError("INVALID_TOKEN", "Invalid or expired Google access token");
  const user = (await userRes.json().catch(() => null)) as UserInfo | null;
  if (!user || typeof user.sub !== "string" || !user.sub) throw new GoogleTokenError("INVALID_TOKEN", "Google returned no account");
  if (info.sub !== undefined && info.sub !== user.sub) throw new GoogleTokenError("INVALID_TOKEN", "Google returned a different account");
  if (typeof user.email !== "string" || !user.email) throw new GoogleTokenError("SCOPE", "The token does not allow reading the email address");
  if (user.email_verified !== true && user.email_verified !== "true") throw new GoogleTokenError("EMAIL_NOT_VERIFIED", "This Google account's email is not verified");
  return {
    sub: user.sub,
    email: user.email.toLowerCase(),
    emailVerified: true,
    name: typeof user.name === "string" ? user.name : "",
    ...(typeof user.picture === "string" ? { picture: user.picture } : {}),
  };
}

const Body = z.object({
  accessToken: z.string().min(20).max(4096),
  intent: z.enum(["signin", "link"]).optional(),
});

function refuse(err: GoogleTokenError): APIError {
  return APIError.from(err.reason === "EMAIL_NOT_VERIFIED" ? "FORBIDDEN" : "UNAUTHORIZED", { code: err.reason, message: err.message });
}

/**
 * Better Auth plugin: `POST /api/auth/google/access-token { accessToken, intent? }`.
 * routes/auth.ts validates, rate limits and forwards; this endpoint verifies the
 * token itself, so reaching it directly gains nothing.
 */
export function googleAccessToken(clientId: string | undefined): BetterAuthPlugin {
  return {
    id: "google-access-token",
    endpoints: {
      googleAccessToken: createAuthEndpoint(
        "/google/access-token",
        { method: "POST", body: Body, use: [formCsrfMiddleware] },
        async (ctx) => {
          if (!clientId) throw APIError.from("NOT_FOUND", { code: "NOT_CONFIGURED", message: "Google sign-in is not configured" });
          let profile: GoogleProfile;
          try {
            profile = await verifyGoogleAccessToken(clientId, ctx.body.accessToken);
          } catch (err) {
            if (err instanceof GoogleTokenError) throw refuse(err);
            throw APIError.from("BAD_GATEWAY", { code: "GOOGLE_UNAVAILABLE", message: "Could not reach Google. Try again." });
          }

          if (ctx.body.intent === "link") {
            // Settings → Sign-in methods: link to the signed-in user; an account owned by someone else is refused.
            const session = await getSessionFromCtx(ctx);
            if (!session) throw APIError.from("UNAUTHORIZED", { code: "UNAUTHENTICATED", message: "Sign in first" });
            const adapter = ctx.context.internalAdapter;
            const existing = await adapter.findAccountByKey({ providerId: "google", accountId: profile.sub });
            if (existing && existing.userId !== session.user.id) {
              throw APIError.from("CONFLICT", { code: "ACCOUNT_IN_USE", message: "That Google account is linked to another user" });
            }
            if (!existing) await adapter.linkAccount({ userId: session.user.id, providerId: "google", accountId: profile.sub, scope: "openid,email,profile" });
            return ctx.json({ linked: true });
          }

          const result = await handleOAuthUserInfo(ctx, {
            userInfo: { id: profile.sub, email: profile.email, emailVerified: true, name: profile.name, image: profile.picture },
            // The access token is not stored: we never call Google on the user's behalf.
            account: { providerId: "google", accountId: profile.sub, scope: "openid,email,profile" },
            source: { method: "oauth", oauth: { providerId: "google", profile: { ...profile } } },
          });
          if (result.error || !result.data) {
            throw APIError.from("UNAUTHORIZED", { code: "OAUTH_LINK_ERROR", message: result.error ?? "Sign-in failed" });
          }
          const { data } = result;
          await setSessionCookie(ctx, data);
          return ctx.json({ user: { id: data.user.id, email: data.user.email, name: data.user.name } });
        },
      ),
    },
  };
}
