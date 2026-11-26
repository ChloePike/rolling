/**
 * Google sign-in without a client secret (D-016). Google Identity Services (GIS)
 * hands the browser an ID token; we verify it (Better Auth's Google provider:
 * Google JWKS, `aud` = GOOGLE_CLIENT_ID, `iss`, `exp`, max age 1 h) and create
 * the session through Better Auth's ID-token sign-in. On top of that we require
 * `email_verified` and a single-use nonce we issued.
 *
 * Nonces: `issueNonce` returns a random value for GIS (`nonce`); only its
 * SHA-256 is stored, in Better Auth's `verifications` table (identifier
 * `google-nonce:<hash>`, 5 minutes), with where to go after signing in and,
 * for account linking, the signed-in user. `consumeNonce` deletes the row
 * atomically, so a nonce works once.
 */
import { newId } from "@rolling/core/ids";
import { sha256Hex } from "./rateLimit";

export const NONCE_TTL_SECONDS = 300;
const NONCE_PREFIX = "google-nonce:";
/** Double-submit cookie for the script-free redirect (`/api/auth/google/start`). */
export const STATE_COOKIE = "rolling.g_state";
/** Set by GIS on our origin in redirect mode; Google posts the same value as `g_csrf_token`. */
export const GIS_CSRF_COOKIE = "g_csrf_token";

export interface NonceData {
  /** App path to land on after signing in. */
  redirect?: string;
  /** Account linking (Settings): the user the Google account is linked to. */
  linkUserId?: string;
}

export interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
  aud?: string | string[];
  [k: string]: unknown;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An app path (`/…`, not `//…`, not the auth pages) or undefined. */
export function safeAppPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  if (/^\/(login|signup)(\/|\?|$)/.test(raw) || raw.startsWith("/api/")) return undefined;
  return raw;
}

export async function issueNonce(env: Env, data: NonceData = {}): Promise<string> {
  const nonce = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000);
  // Expired nonces are dropped as new ones are issued (cheap: indexed by identifier, few rows).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM verifications WHERE identifier LIKE ?1 AND expires_at < ?2").bind(`${NONCE_PREFIX}%`, now.toISOString()),
    env.DB.prepare("INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)").bind(
      newId("verification"),
      NONCE_PREFIX + (await sha256Hex(nonce)),
      JSON.stringify(data),
      expires.toISOString(),
      now.toISOString(),
    ),
  ]);
  return nonce;
}

/** Deletes the nonce's row and returns its data; null when unknown, expired or already used. */
export async function consumeNonce(env: Env, nonce: string): Promise<NonceData | null> {
  if (!nonce || nonce.length > 256) return null;
  const row = await env.DB.prepare("DELETE FROM verifications WHERE identifier = ?1 AND expires_at > ?2 RETURNING value")
    .bind(NONCE_PREFIX + (await sha256Hex(nonce)), new Date().toISOString())
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as NonceData;
  } catch {
    return {};
  }
}

/**
 * Claims of an ID token, decoded WITHOUT verifying it. Only used to refuse early
 * (unverified email, missing nonce) and to find the nonce; acceptance always goes
 * through the signature check.
 */
export function peekClaims(token: string): GoogleClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
    const c = JSON.parse(new TextDecoder().decode(bytes)) as GoogleClaims;
    return c && typeof c === "object" && typeof c.sub === "string" ? c : null;
  } catch {
    return null;
  }
}

export function emailVerified(c: GoogleClaims): boolean {
  return c.email_verified === true || c.email_verified === "true";
}

/** Where Google posts the credential (GIS `login_uri`, OIDC `redirect_uri`) for an app origin. */
export function credentialUri(origin: string): string {
  return `${origin}/api/auth/google/credential`;
}

/** OIDC implicit request with `response_mode=form_post`: Google posts `id_token` + `state` to the credential endpoint. */
export function authorizeUrl(env: Env, origin: string, nonce: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", credentialUri(origin));
  u.searchParams.set("response_type", "id_token");
  u.searchParams.set("response_mode", "form_post");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

/** Constant-time string comparison. */
export function sameValue(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
