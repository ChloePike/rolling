import { HYPEROUTER_DEFAULTS } from './config';

/**
 * Standard Webhooks verification (https://www.standardwebhooks.com), WebCrypto
 * only. Signature: `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`;
 * the header may carry several space-separated signatures (secret rotation).
 */

export type HyperouterWebhookEventType =
  | 'video.completed'
  | 'video.failed'
  | 'image.completed'
  | 'image.failed'
  | 'raw.completed'
  | 'raw.failed'
  | 'webhook.test';

export interface HyperouterWebhookEvent {
  id: string;
  object: 'event';
  type: HyperouterWebhookEventType | (string & {});
  created_at?: number;
  data: { id: string };
}

export type WebhookFailureReason =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_secret'
  | 'no_valid_signature'
  | 'malformed_payload';

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  constructor(
    readonly reason: WebhookFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifyWebhookInput {
  /** Raw body exactly as received. Never re-serialize parsed JSON. */
  body: string;
  headers: Headers | Record<string, string | null | undefined>;
  /** `whsec_<base64>` (the prefix is optional). */
  secret: string;
  toleranceSec?: number;
  /** Current time in ms (tests). */
  now?: number;
}

export interface VerifiedWebhook {
  /** `webhook-id`: identical on every retry; dedupe on it. */
  webhookId: string;
  timestamp: number;
  event: HyperouterWebhookEvent;
}

function header(headers: VerifyWebhookInput['headers'], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct != null) return direct;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? (headers[key] ?? null) : null;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time comparison: time depends only on the lengths, never on content. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function importSecret(secret: string): Promise<CryptoKey> {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(raw);
  } catch {
    throw new WebhookVerificationError('invalid_secret', 'Webhook secret is not valid base64.');
  }
  if (keyBytes.length === 0) throw new WebhookVerificationError('invalid_secret', 'Webhook secret is empty.');
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Computes `v1,<base64 signature>` for a payload. Used by tests and local tooling. */
export async function signWebhook(secret: string, webhookId: string, timestamp: number, body: string): Promise<string> {
  const key = await importSecret(secret);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`));
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

/**
 * Verifies headers and signature, then parses the event. Throws
 * WebhookVerificationError on any failure; answer such requests with 400/401.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook> {
  const webhookId = header(input.headers, 'webhook-id');
  const timestampRaw = header(input.headers, 'webhook-timestamp');
  const signatureHeader = header(input.headers, 'webhook-signature');
  if (!webhookId || !timestampRaw || !signatureHeader) {
    throw new WebhookVerificationError('missing_headers', 'Missing webhook-id, webhook-timestamp or webhook-signature.');
  }
  if (!/^\d+$/.test(timestampRaw.trim())) {
    throw new WebhookVerificationError('invalid_timestamp', 'webhook-timestamp is not a Unix time in seconds.');
  }
  const timestamp = Number(timestampRaw.trim());
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const tolerance = input.toleranceSec ?? HYPEROUTER_DEFAULTS.webhookToleranceSec;
  if (Math.abs(nowSec - timestamp) > tolerance) {
    throw new WebhookVerificationError('stale_timestamp', 'webhook-timestamp is outside the allowed tolerance.');
  }

  const key = await importSecret(input.secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${webhookId}.${timestampRaw.trim()}.${input.body}`)),
  );

  let valid = false;
  for (const part of signatureHeader.trim().split(/\s+/)) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    if (part.slice(0, comma) !== 'v1') continue;
    let candidate: Uint8Array;
    try {
      candidate = base64ToBytes(part.slice(comma + 1));
    } catch {
      continue;
    }
    // Check every candidate (no early exit) so timing does not reveal which one matched.
    if (timingSafeEqual(candidate, expected)) valid = true;
  }
  if (!valid) throw new WebhookVerificationError('no_valid_signature', 'No webhook signature matched.');

  let event: HyperouterWebhookEvent;
  try {
    event = JSON.parse(input.body) as HyperouterWebhookEvent;
  } catch {
    throw new WebhookVerificationError('malformed_payload', 'Webhook body is not JSON.');
  }
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.type !== 'string' ||
    !event.data ||
    typeof event.data.id !== 'string'
  ) {
    throw new WebhookVerificationError('malformed_payload', 'Webhook body has no type or data.id.');
  }
  return { webhookId, timestamp, event };
}

/** Reads a Request's raw body and verifies it. */
export async function verifyWebhookRequest(
  req: Request,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<VerifiedWebhook> {
  const body = await req.text();
  return verifyWebhook({ body, headers: req.headers, secret, ...opts });
}
