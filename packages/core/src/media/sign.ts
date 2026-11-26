/**
 * Signed private media URLs (D-008). The API signs `<key>` for a workspace and
 * an expiry; the media route (later the media Worker on the media hostname)
 * verifies the HMAC-SHA256 token before reading R2. WebCrypto only.
 *
 * Token: `sig = base64url(HMAC(secret, "v1\n" + key + "\n" + exp + "\n" + ws))`,
 * `exp` in epoch seconds. A key is only valid for its workspace: workspace media
 * lives under `ws/<workspaceId>/`; `ws=_` signs shared media under `builtin/`
 * or `public/`.
 */

export const SHARED_MEDIA_WS = '_';
/** Longest lifetime a signed URL may have. */
export const MAX_SIGNED_TTL_SECONDS = 7 * 24 * 3600;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function payload(key: string, exp: number, ws: string): string {
  return `v1\n${key}\n${exp}\n${ws}`;
}

/** True when `key` may be signed for `ws`. */
export function keyBelongsTo(key: string, ws: string): boolean {
  if (key.includes('..') || key.startsWith('/')) return false;
  if (ws === SHARED_MEDIA_WS) return key.startsWith('builtin/') || key.startsWith('public/');
  return /^[A-Za-z0-9_-]+$/.test(ws) && key.startsWith(`ws/${ws}/`);
}

export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export interface SignOptions {
  workspaceId: string;
  /** Seconds, capped at MAX_SIGNED_TTL_SECONDS. */
  expiresIn: number;
  secret: string;
  /** Origin of the media host, e.g. `https://media.example.com`; empty for the API Worker's `/media` route. */
  baseUrl?: string;
  /**
   * Round the expiry up to a multiple of this many seconds, so every URL issued for a key
   * inside one window is identical and browser/edge caches can reuse it. The lifetime is
   * then between `expiresIn` and `expiresIn + alignSeconds` (still capped).
   */
  alignSeconds?: number;
  now?: number;
}

/** `<base>/media/<key>?exp=&ws=&sig=` */
export async function signMediaKey(key: string, opts: SignOptions): Promise<string> {
  if (!keyBelongsTo(key, opts.workspaceId)) throw new Error('Media key does not belong to the workspace');
  const ttl = Math.max(1, Math.min(Math.floor(opts.expiresIn), MAX_SIGNED_TTL_SECONDS));
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  let exp = nowSec + ttl;
  const align = Math.floor(opts.alignSeconds ?? 0);
  if (align > 1) exp = Math.min(Math.ceil(exp / align) * align, nowSec + MAX_SIGNED_TTL_SECONDS);
  const sig = await hmac(opts.secret, payload(key, exp, opts.workspaceId));
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const qs = new URLSearchParams({ exp: String(exp), ws: opts.workspaceId, sig });
  return `${base}/media/${encodeKeyPath(key)}?${qs.toString()}`;
}

export type VerifyResult = { ok: true; exp: number; workspaceId: string } | { ok: false; reason: 'expired' | 'invalid' };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyMediaSignature(
  key: string,
  query: { exp?: string | null; ws?: string | null; sig?: string | null },
  secret: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const { exp: expRaw, ws, sig } = query;
  if (!expRaw || !ws || !sig || !/^\d{1,12}$/.test(expRaw)) return { ok: false, reason: 'invalid' };
  if (!keyBelongsTo(key, ws)) return { ok: false, reason: 'invalid' };
  const exp = Number(expRaw);
  const expected = await hmac(secret, payload(key, exp, ws));
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: 'invalid' };
  if (exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, exp, workspaceId: ws };
}
