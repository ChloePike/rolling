/**
 * Stripe webhook signature verification with WebCrypto, equivalent to
 * stripe-node's `constructEventAsync`:
 *
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=...]
 *
 * The event is accepted when any `v1` matches (constant-time compare) and the
 * timestamp is no older than the tolerance (default 300 s).
 */
import type { StripeEvent } from './stripe';

export const DEFAULT_TOLERANCE_SEC = 300;

export type WebhookFailure = 'missing_header' | 'malformed_header' | 'no_signature_match' | 'timestamp_outside_tolerance' | 'invalid_payload';

export class StripeSignatureError extends Error {
  override readonly name = 'StripeSignatureError';
  constructor(readonly reason: WebhookFailure) {
    super(`Stripe signature verification failed: ${reason}`);
  }
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Builds a valid header (tests and the fake Stripe server). */
export async function signStripePayload(payload: string, secret: string, timestampSec: number): Promise<string> {
  return `t=${timestampSec},v1=${await hmacHex(secret, `${timestampSec}.${payload}`)}`;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): Promise<StripeEvent> {
  if (!header) throw new StripeSignatureError('missing_header');
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = /^\d+$/.test(v) ? Number(v) : null;
    else if (k === 'v1') signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) throw new StripeSignatureError('malformed_header');
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  if (!signatures.some((s) => timingSafeEqual(s, expected))) throw new StripeSignatureError('no_signature_match');
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && timestamp < now - tolerance) throw new StripeSignatureError('timestamp_outside_tolerance');
  try {
    const event = JSON.parse(payload) as StripeEvent;
    if (typeof event?.id !== 'string' || typeof event?.type !== 'string') throw new Error('not an event');
    return event;
  } catch {
    throw new StripeSignatureError('invalid_payload');
  }
}
