/**
 * Apple "Sign in with Apple" client secret: an ES256 JWT signed with the
 * team's private key (.p8), valid at most 6 months. Built with WebCrypto so it
 * runs on Workers.
 */
export interface AppleSecretInput {
  /** Services ID (the OAuth client id). */
  clientId: string;
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), literal `\n` sequences allowed. */
  privateKey: string;
  /** Seconds since epoch; defaults to now. */
  now?: number;
  /** Lifetime in seconds; default 1 day, capped at 180 days. */
  ttlSeconds?: number;
}

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function appleClientSecret(input: AppleSecretInput): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(input.ttlSeconds ?? 86_400, 180 * 86_400);
  const header = { alg: 'ES256', kid: input.keyId, typ: 'JWT' };
  const payload = { iss: input.teamId, iat: now, exp: now + ttl, aud: 'https://appleid.apple.com', sub: input.clientId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(input.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto returns the raw r||s signature, which is what JWS ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}
