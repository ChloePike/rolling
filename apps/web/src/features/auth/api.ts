import { api } from '@/lib/api/client';
import { ApiError, isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { AuthProviders } from '@/lib/api/types';
import { refetchMe } from '@/lib/session';

/**
 * Auth client (docs/api.md → Auth). Better Auth on the Worker:
 * - email code: `POST /api/auth/email-otp/send-verification-otp`, then
 *   `POST /api/auth/sign-in/email-otp` (sets the session cookie; creates the
 *   user on first sign-in);
 * - Google / Apple: `POST /api/auth/sign-in/social` → navigate to `url`; the
 *   provider returns through `/api/auth/callback/:provider` to `callbackURL`
 *   (or `errorCallbackURL?error=<code>`).
 *
 * Errors are `ApiError`s: `INVALID_CODE`, `CODE_EXPIRED`, `TOO_MANY_ATTEMPTS`,
 * `RATE_LIMITED` (`data.retryAfter` seconds), `VALIDATION_FAILED`.
 *
 * Mock mode (`VITE_API_MODE=mock`): resolves locally with the same states;
 * `000000` is a wrong code, `111111` an expired one. Latency seam:
 * `window.__rollingMocks.delayMs` (default 400 ms).
 */

export type OAuthProvider = 'google' | 'apple';

export interface SendCodeResult {
  email: string;
  /** Seconds until “Resend” is allowed (the server's cooldown). */
  resendAfter: number;
  /** Minutes until the code expires. */
  expiresInMinutes: number;
}

export const CODE_LENGTH = 6;
/** Server: 30 s between two codes to one address; codes live 10 minutes. */
export const RESEND_COOLDOWN_SECONDS = 30;
export const CODE_TTL_MINUTES = 10;
export const MOCK_WRONG_CODE = '000000';
export const MOCK_EXPIRED_CODE = '111111';

function wait(): Promise<void> {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { delayMs?: number } }).__rollingMocks : undefined;
  const ms = typeof w?.delayMs === 'number' ? w.delayMs : 400;
  return new Promise((r) => setTimeout(r, ms));
}

/** Which sign-in methods the server offers (unconfigured social providers are hidden). */
export async function fetchProviders(): Promise<AuthProviders> {
  if (isMockApi()) return { emailCode: true, google: true, apple: true };
  try {
    return await api.get<AuthProviders>('/auth/providers', { noWorkspace: true });
  } catch {
    return { emailCode: true, google: false, apple: false };
  }
}

/** Leaves for the provider (test seam `window.__rollingRedirect`). */
function go(url: string) {
  const seam = (window as unknown as { __rollingRedirect?: (u: string) => void }).__rollingRedirect;
  if (seam) seam(url);
  else window.location.assign(url);
}

/**
 * Starts the provider redirect. Real: the window navigates away (the promise
 * stays pending). Mock: returns where the callback would land.
 */
export async function startOAuth(provider: OAuthProvider, opts: { redirect?: string; errorPath?: string } = {}): Promise<{ redirectTo: string; provider: OAuthProvider }> {
  const target = opts.redirect ?? '/';
  if (isMockApi()) {
    await wait();
    return { redirectTo: target, provider };
  }
  const r = await api.post<{ url: string; redirect: boolean }>(
    '/auth/sign-in/social',
    { provider, callbackURL: target, errorCallbackURL: opts.errorPath ?? '/login', newUserCallbackURL: target },
    { noWorkspace: true },
  );
  go(r.url);
  return new Promise(() => {});
}

export async function sendEmailCode(email: string): Promise<SendCodeResult> {
  if (isMockApi()) {
    await wait();
    return { email, resendAfter: RESEND_COOLDOWN_SECONDS, expiresInMinutes: CODE_TTL_MINUTES };
  }
  try {
    await api.post('/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, { noWorkspace: true });
    return { email, resendAfter: RESEND_COOLDOWN_SECONDS, expiresInMinutes: CODE_TTL_MINUTES };
  } catch (e) {
    // A code went out moments ago: the last one is still good, wait out the cooldown.
    if (isApiError(e, 'RATE_LIMITED')) {
      const after = Number((e.data as { retryAfter?: number }).retryAfter);
      if (Number.isFinite(after) && after > 0 && after <= RESEND_COOLDOWN_SECONDS) return { email, resendAfter: after, expiresInMinutes: CODE_TTL_MINUTES };
    }
    throw e;
  }
}

/** Signs in with the code; resolves once `/api/me` reflects the new session. Rejects with the typed error. */
export async function verifyEmailCode(email: string, code: string): Promise<{ ok: true }> {
  if (isMockApi()) {
    await wait();
    if (code === MOCK_EXPIRED_CODE) throw new ApiError('CODE_EXPIRED', 'Code expired', 400);
    if (code.length !== CODE_LENGTH || code === MOCK_WRONG_CODE) throw new ApiError('INVALID_CODE', 'Invalid code', 400);
    return { ok: true };
  }
  await api.post('/auth/sign-in/email-otp', { email, otp: code }, { noWorkspace: true });
  await refetchMe();
  return { ok: true };
}

/** Message id for an auth error (inline on the form). */
export function authErrorMessage(e: unknown): { id: string; values?: Record<string, number> } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INVALID_CODE':
      case 'VALIDATION_FAILED':
        return { id: 'auth.code.wrong' };
      case 'CODE_EXPIRED':
        return { id: 'auth.error.expired' };
      case 'TOO_MANY_ATTEMPTS':
        return { id: 'auth.error.tooManyAttempts' };
      case 'RATE_LIMITED': {
        const s = Number((e.data as { retryAfter?: number }).retryAfter);
        return { id: 'auth.error.rateLimited', values: { seconds: Number.isFinite(s) && s > 0 ? Math.ceil(s) : 60 } };
      }
      case 'NETWORK':
        return { id: 'auth.error.network' };
      default:
        return { id: 'auth.error.generic' };
    }
  }
  return { id: 'auth.error.generic' };
}

/** OAuth callback error codes (`?error=`) → message. */
export function oauthErrorMessage(code: string): string {
  return code === 'access_denied' ? 'auth.error.oauthDenied' : 'auth.error.oauth';
}
