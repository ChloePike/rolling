/**
 * Uploads apps/web/dist to R2 under `_web/` through the Cloudflare REST API,
 * for Workers deploys that serve the SPA from R2 (see apps/api/src/lib/r2Static.ts).
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET (must start with "rolling-").
 * Usage: tsx scripts/deploy/upload-web.mts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cacheControl, contentType, SERVICE_WORKER } from '../../apps/api/src/lib/r2Static.ts';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const bucket = process.env.R2_BUCKET ?? '';
if (!accountId || !token || !bucket.startsWith('rolling-')) {
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and R2_BUCKET (rolling-*).');
}

const distDir = new URL('../../apps/web/dist/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

async function put(key: string, path: string, body: Buffer): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  for (let attempt = 1; ; attempt++) {
    // The Worker sets these from the path when serving (r2Static.ts); stored too for direct reads.
    const headers = { authorization: `Bearer ${token}`, 'content-type': contentType(path), 'cache-control': cacheControl(path) };
    const res = await fetch(url, { method: 'PUT', headers, body });
    if (res.ok) return;
    if (attempt >= 4) throw new Error(`PUT ${key} failed: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

// `_headers` is for the Workers assets binding only; the R2 path sets headers in code.
const files = walk(distDir).filter((f) => relative(distDir, f) !== '_headers');
/**
 * Order: assets first, then `index.html`, then the service worker last, so a
 * half-finished upload never points at missing files and a client that sees
 * the new `sw.js` can precache everything it lists.
 */
const rank = (f: string) => (relative(distDir, f) === SERVICE_WORKER ? 2 : relative(distDir, f) === 'index.html' ? 1 : 0);
files.sort((a, b) => rank(a) - rank(b));
for (const file of files) {
  const path = relative(distDir, file);
  const key = `_web/${path}`;
  await put(key, path, readFileSync(file));
  console.log(`uploaded ${key}`);
}
console.log(`done: ${files.length} files`);
