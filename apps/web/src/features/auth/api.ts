/**
 * Auth client boundary. Better Auth (Google, Apple, email one-time code) is
 * wired in a later milestone; until then these resolve locally with the same
 * states the server produces (pending, success, wrong code). Replace the
 * bodies, keep the signatures.
 *
 * Test seams on `window.__rollingMocks`: `delayMs` (latency, default 400ms).
 * The mock treats `000000` as a wrong code.
 */

export type OAuthProvider = 'google' | 'apple';

export interface SendCodeResult {
  email: string;
  /** Seconds until “Resend” is allowed. */
  resendAfter: number;
  /** Minutes until the code expires. */
  expiresInMinutes: number;
}

export const CODE_LENGTH = 6;
export const MOCK_WRONG_CODE = '000000';

function wait(): Promise<void> {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { delayMs?: number } }).__rollingMocks : undefined;
  const ms = typeof w?.delayMs === 'number' ? w.delayMs : 400;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Starts the provider redirect (`GET /api/auth/sign-in/:provider` → the
 * provider → `/api/auth/callback/:provider` → app). The mock skips the round
 * trip and returns where the callback would land.
 */
export async function startOAuth(provider: OAuthProvider): Promise<{ redirectTo: string; provider: OAuthProvider }> {
  await wait();
  return { redirectTo: '/', provider };
}

export async function sendEmailCode(email: string): Promise<SendCodeResult> {
  await wait();
  return { email, resendAfter: 60, expiresInMinutes: 10 };
}

export async function verifyEmailCode(email: string, code: string): Promise<{ ok: boolean }> {
  void email;
  await wait();
  return { ok: code.length === CODE_LENGTH && code !== MOCK_WRONG_CODE };
}
