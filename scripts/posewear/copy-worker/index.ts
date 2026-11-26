// Temporary bulk-copy Worker for the public library (D-004, D-008). The Cloudflare REST API is
// rate-limited (about 4 requests/s per account), so bucket-to-bucket copies of thousands of
// objects run here through R2 bindings instead. Deploy it only for a copy, then delete it:
//
//   cd scripts/posewear/copy-worker
//   npx wrangler deploy && openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put COPY_TOKEN
//   COPY_TOKEN=... tsx ../copy-to-r2.ts --env production --target public --from-bucket rolling-media-staging \
//     --via-worker https://rolling-media-copy.<subdomain>.workers.dev
//   npx wrangler delete   (or DELETE /accounts/{id}/workers/scripts/rolling-media-copy)
//
// POST /copy { target, keys } with `authorization: Bearer <COPY_TOKEN>` copies up to 100 keys from
// SOURCE (rolling-media-staging) into the target bucket, skipping keys that already exist, and sets
// `Cache-Control: public, max-age=31536000, immutable`. Public targets refuse every key that the
// staging catalog marks mature, and every key that is neither a library asset nor a template cover.

interface CopyEnv {
  SOURCE: R2Bucket;
  PUBLIC_STAGING: R2Bucket;
  PUBLIC_PRODUCTION: R2Bucket;
  MEDIA_PRODUCTION: R2Bucket;
  CATALOG: D1Database;
  COPY_TOKEN?: string;
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const KEY = /^public\/[a-z_]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.(webp|png|jpe?g)$/;

function targetBucket(env: CopyEnv, name: string): { bucket: R2Bucket; isPublic: boolean } | null {
  if (name === 'rolling-public-staging') return { bucket: env.PUBLIC_STAGING, isPublic: true };
  if (name === 'rolling-public-production') return { bucket: env.PUBLIC_PRODUCTION, isPublic: true };
  if (name === 'rolling-media-production') return { bucket: env.MEDIA_PRODUCTION, isPublic: false };
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req: Request, env: CopyEnv): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/copy') return new Response('Not found', { status: 404 });
    const auth = req.headers.get('authorization') ?? '';
    if (!env.COPY_TOKEN || !timingSafeEqual(auth, `Bearer ${env.COPY_TOKEN}`)) return new Response('Forbidden', { status: 403 });
    const body = (await req.json().catch(() => null)) as { target?: string; keys?: unknown } | null;
    const target = body?.target ? targetBucket(env, body.target) : null;
    const keys = Array.isArray(body?.keys) ? body!.keys.filter((k): k is string => typeof k === 'string' && KEY.test(k) && !k.includes('..')) : [];
    if (!target || !keys.length || keys.length > 100) return Response.json({ error: 'target and 1-100 valid keys required' }, { status: 400 });

    const refused = new Set<string>();
    if (target.isPublic) {
      // Mature or unknown objects never go to a public bucket (D-005).
      const placeholders = keys.map(() => '?').join(',');
      const rows = await env.CATALOG.prepare(
        `SELECT r2_key, (mature = 1 OR json_extract(meta, '$.mature') = 1) AS m FROM assets WHERE source = 'public' AND r2_key IN (${placeholders})`,
      ).bind(...keys).all<{ r2_key: string; m: number }>();
      const known = new Map(rows.results.map((r) => [r.r2_key, r.m === 1]));
      for (const k of keys) {
        const isCover = /^public\/templates\/[A-Za-z0-9_]+\/cover\.png$/.test(k);
        if (known.get(k) === true || (!known.has(k) && !isCover)) refused.add(k);
      }
    }

    const result = { copied: 0, skipped: 0, missing: [] as string[], refused: [...refused], bytes: 0 };
    await Promise.all(
      keys.filter((k) => !refused.has(k)).map(async (key) => {
        if (await target.bucket.head(key)) {
          result.skipped++;
          return;
        }
        const obj = await env.SOURCE.get(key);
        if (!obj) {
          result.missing.push(key);
          return;
        }
        const contentType = obj.httpMetadata?.contentType ?? (key.endsWith('.png') ? 'image/png' : key.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');
        await target.bucket.put(key, obj.body, { httpMetadata: { contentType, cacheControl: CACHE_CONTROL } });
        result.copied++;
        result.bytes += obj.size;
      }),
    );
    return Response.json(result);
  },
};
