/**
 * Uploads apps/web/dist to R2 under `_web/` through the Cloudflare REST API,
 * for Workers deploys that serve the SPA from R2 (see apps/api/src/lib/r2Static.ts).
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET (must start with "rolling-").
 * Usage: tsx scripts/deploy/upload-web.mts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

async function put(key: string, body: Buffer): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body });
    if (res.ok) return;
    if (attempt >= 4) throw new Error(`PUT ${key} failed: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

const files = walk(distDir);
// Upload index.html last so a half-finished upload never points at missing assets.
files.sort((a, b) => Number(a.endsWith('index.html')) - Number(b.endsWith('index.html')));
for (const file of files) {
  const key = `_web/${relative(distDir, file)}`;
  await put(key, readFileSync(file));
  console.log(`uploaded ${key}`);
}
console.log(`done: ${files.length} files`);
