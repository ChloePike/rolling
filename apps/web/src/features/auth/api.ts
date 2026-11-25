/**
 * Auth client boundary. Better Auth (Google, Apple, email one-time code) is
 * wired in a later milestone; until then these resolve locally so the screens
 * can run on their own. Replace the bodies, keep the signatures.
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

export async function startOAuth(provider: OAuthProvider): Promise<void> {
  void provider;
}

export async function sendEmailCode(email: string): Promise<SendCodeResult> {
  return { email, resendAfter: 60, expiresInMinutes: 10 };
}

export async function verifyEmailCode(email: string, code: string): Promise<{ ok: boolean }> {
  void email;
  return { ok: code.length === CODE_LENGTH };
}
