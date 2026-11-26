// Copies library images into R2 through the Cloudflare REST API (no local disk
// staging: each image is held in memory only while it is uploaded).
//
//   PUT  /client/v4/accounts/{account}/r2/buckets/{bucket}/objects/{key}   upload
//   GET  /client/v4/accounts/{account}/r2/buckets/{bucket}/objects?prefix= list (resume)
//   GET  /client/v4/accounts/{account}/r2/buckets/{bucket}                 bucket check
// HEAD on an object returns 405 on this API, so resume uses prefix listing,
// falling back to a per-key GET.
//
// Env:
//   CLOUDFLARE_API_TOKEN   sent as Bearer (in the sandbox a proxy injects the real token)
//   CLOUDFLARE_ACCOUNT_ID
//   R2_BUCKET              target bucket when --env is not given (default rolling-media-staging); must start with "rolling-"
//
// Usage:
//   tsx scripts/posewear/copy-to-r2.ts [--env staging|production --target public|private]
//                                       [--from-bucket rolling-media-staging] [--extra-prefix public/templates/]
//                                       [--category pose,outfit] [--limit N] [--include-mature | --mature-only]
//                                       [--exclude-attribution charadb] [--concurrency 4] [--dry-run [--fetch-source]]
//
// Buckets (D-008): --target public = rolling-public-<env> (custom domain media[-staging].rolling.actor,
// non-mature objects only: mature items are always skipped and --include-mature is refused);
// --target private = rolling-media-<env> (never public; mature library items are signed from here).
// --from-bucket reads the bytes from another rolling-* bucket (e.g. the staging copy) instead of the
// source CDN, so production is filled without fetching PoseWear again. --extra-prefix also copies every
// object under that prefix of --from-bucket (built-in template covers, `public/templates/`).
// Uploaded objects get `Cache-Control: public, max-age=31536000, immutable` (keys never change content).
//
// --dry-run makes no Cloudflare calls. With --fetch-source it downloads each
// planned source image into memory and discards it, to prove the URLs resolve.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicLibraryItem } from '../../packages/core/src/library/index.ts';
import { OUT_DIR, SNAPSHOT_PATH, fetchWithRetry, formatBytes, parseArgs, pool, readJson, sleep } from './lib.ts';

const args = parseArgs(process.argv.slice(2));
const dryRun = args.has('dry-run');
const fetchSource = args.has('fetch-source');
const matureOnly = args.has('mature-only');
const includeMature = args.has('include-mature') || matureOnly;
// D-004 (2026-11-26): CharaDB-hosted images are imported too; `--exclude-attribution <name,...>` can still leave a source out.
const excludeAttribution = typeof args.get('exclude-attribution') === 'string' ? new Set(String(args.get('exclude-attribution')).split(',').map((s) => s.toLowerCase())) : undefined;
const limit = args.has('limit') ? Number(args.get('limit')) : Infinity;
const concurrency = Math.max(1, Math.min(8, Number(args.get('concurrency') ?? 4)));
const categories = typeof args.get('category') === 'string' ? new Set(String(args.get('category')).split(',')) : undefined;

const API = 'https://api.cloudflare.com/client/v4';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const envName = typeof args.get('env') === 'string' ? String(args.get('env')) : undefined;
const target = String(args.get('target') ?? 'private');
if (envName && !['staging', 'production'].includes(envName)) throw new Error(`--env must be staging or production, not ${envName}`);
if (!['public', 'private'].includes(target)) throw new Error(`--target must be public or private, not ${target}`);
const bucket = envName ? (target === 'public' ? `rolling-public-${envName}` : `rolling-media-${envName}`) : (process.env.R2_BUCKET ?? 'rolling-media-staging');
/** Public buckets are served on a public custom domain: they must never hold mature objects (D-005, D-008). */
const publicBucket = bucket.startsWith('rolling-public-');
if (publicBucket && (includeMature || matureOnly)) throw new Error(`Refusing --include-mature/--mature-only for public bucket ${bucket}`);
const fromBucket = typeof args.get('from-bucket') === 'string' ? String(args.get('from-bucket')) : undefined;
if (fromBucket && !/^rolling-[a-z0-9-]+$/.test(fromBucket)) throw new Error(`Refusing source bucket "${fromBucket}": only rolling-* buckets are allowed`);
const extraPrefix = typeof args.get('extra-prefix') === 'string' ? String(args.get('extra-prefix')) : undefined;
if (extraPrefix && !fromBucket) throw new Error('--extra-prefix needs --from-bucket');
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Bulk bucket-to-bucket copies through the temporary copy Worker (copy-worker/), avoiding REST API rate limits. */
const viaWorker = typeof args.get('via-worker') === 'string' ? String(args.get('via-worker')).replace(/\/+$/, '') : undefined;
if (viaWorker && fromBucket !== 'rolling-media-staging') throw new Error('--via-worker copies from --from-bucket rolling-media-staging only');

interface PlanEntry {
  /** Source CDN URL, or the key in --from-bucket. */
  sourceUrl: string;
  r2Key: string;
  contentType: string;
  itemId: string;
  category: string;
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg')) return 'image/jpeg';
  return 'image/webp';
}

function buildPlan(): PlanEntry[] {
  const { items } = readJson<{ items: PublicLibraryItem[] }>(SNAPSHOT_PATH);
  const plan: PlanEntry[] = [];
  for (const item of items) {
    if (categories && !categories.has(item.category)) continue;
    if (item.mature && (!includeMature || publicBucket)) continue;
    if (!item.mature && matureOnly) continue;
    if (excludeAttribution && item.attribution && excludeAttribution.has(item.attribution.name.toLowerCase())) continue;
    for (const angle of item.angles) {
      plan.push({
        sourceUrl: fromBucket ? angle.r2Key : angle.fullUrl,
        r2Key: angle.r2Key,
        contentType: contentTypeFor(angle.r2Key),
        itemId: item.id,
        category: item.category,
      });
    }
  }
  return plan.slice(0, limit);
}

function objectUrl(key: string, inBucket: string = bucket): string {
  // Keep `/` separators; encode each segment.
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(inBucket)}/objects/${path}`;
}

function cfHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function assertBucket(): Promise<void> {
  if (!/^rolling-[a-z0-9-]+$/.test(bucket)) throw new Error(`Refusing bucket "${bucket}": only rolling-* buckets are allowed`);
  if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  const res = await fetchWithRetry(`${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`, { headers: cfHeaders() });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> };
  if (!res.ok || !body.success) {
    throw new Error(`Bucket ${bucket} is not available: ${body.errors?.map((e) => e.message).join('; ') ?? res.status}`);
  }
}

/** Lists existing keys under a prefix. Returns undefined if listing is not supported. */
async function listKeys(prefix: string, inBucket: string = bucket): Promise<Set<string> | undefined> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) });
    const res = await fetchWithRetry(`${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(inBucket)}/objects?${qs}`, {
      headers: cfHeaders(),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const body = (await res.json()) as {
      result?: Array<{ key: string }>;
      result_info?: { cursor?: string; is_truncated?: boolean | string };
    };
    for (const o of body.result ?? []) keys.add(o.key);
    const info = body.result_info;
    if (!info?.cursor || String(info.is_truncated) !== 'true') return keys;
    cursor = info.cursor;
  }
}

async function objectExists(key: string): Promise<boolean> {
  const res = await fetchWithRetry(objectUrl(key), { headers: cfHeaders() });
  await res.body?.cancel();
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`Existence check for ${key} failed: HTTP ${res.status}`);
}

async function download(url: string): Promise<Uint8Array> {
  const res = fromBucket ? await fetchWithRetry(objectUrl(url, fromBucket), { headers: cfHeaders() }) : await fetchWithRetry(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Source HTTP ${res.status} for ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function upload(entry: PlanEntry, bytes: Uint8Array): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(objectUrl(entry.r2Key), {
      method: 'PUT',
      headers: cfHeaders({ 'content-type': entry.contentType, 'cache-control': CACHE_CONTROL }),
      body: bytes,
    });
    if (res.ok) {
      await res.body?.cancel();
      return;
    }
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`Upload ${entry.r2Key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 500));
  }
}

async function copyViaWorker(plan: PlanEntry[]): Promise<void> {
  const copyToken = process.env.COPY_TOKEN;
  if (!copyToken) throw new Error('COPY_TOKEN is required with --via-worker');
  const batches: PlanEntry[][] = [];
  for (let i = 0; i < plan.length; i += 50) batches.push(plan.slice(i, i + 50));
  const stats = { copied: 0, skipped: 0, failed: 0, refused: 0, missing: 0, bytes: 0 };
  const failures: Array<{ key: string; error: string }> = [];
  let done = 0;
  await pool(batches, concurrency, async (batch) => {
    const keys = batch.map((b) => b.r2Key);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${viaWorker}/copy`, {
        method: 'POST',
        headers: { authorization: `Bearer ${copyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ target: bucket, keys }),
      }).catch((e: unknown) => new Response(String(e), { status: 599 }));
      if (res.ok) {
        const r = (await res.json()) as { copied: number; skipped: number; bytes: number; missing: string[]; refused: string[] };
        stats.copied += r.copied;
        stats.skipped += r.skipped;
        stats.bytes += r.bytes;
        stats.missing += r.missing.length;
        stats.refused += r.refused.length;
        for (const k of r.missing) failures.push({ key: k, error: 'missing in source' });
        for (const k of r.refused) failures.push({ key: k, error: 'refused (mature or unknown) for a public bucket' });
        break;
      }
      const text = await res.text().catch(() => '');
      if (attempt >= 4) {
        stats.failed += keys.length;
        for (const k of keys) failures.push({ key: k, error: `HTTP ${res.status} ${text.slice(0, 120)}` });
        break;
      }
      await sleep(1000 * 2 ** attempt);
    }
    done += batch.length;
    if (done % 1000 < 50 || done === plan.length) console.log(`  ${done}/${plan.length}  copied ${stats.copied}  skipped ${stats.skipped}  failed ${stats.failed + stats.missing + stats.refused}  ${formatBytes(stats.bytes)}`);
  });
  const report = { bucket, fromBucket, viaWorker, finishedAt: new Date().toISOString(), planned: plan.length, ...stats, failures };
  writeFileSync(join(OUT_DIR, `r2-copy-report-${bucket}.json`), JSON.stringify(report, null, 2));
  console.log(`Copied ${stats.copied}, skipped ${stats.skipped}, failed ${stats.failed}, missing ${stats.missing}, refused ${stats.refused}, ${formatBytes(stats.bytes)}.`);
  for (const f of failures.slice(0, 20)) console.log(`  failed ${f.key}: ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const plan = buildPlan();
  if (extraPrefix) {
    const keys = await listKeys(extraPrefix, fromBucket);
    if (!keys) throw new Error(`Listing ${extraPrefix} in ${fromBucket} failed`);
    for (const key of keys) plan.push({ sourceUrl: key, r2Key: key, contentType: contentTypeFor(key), itemId: key, category: extraPrefix.split('/')[1] ?? 'extra' });
  }
  const perCategory: Record<string, number> = {};
  for (const p of plan) perCategory[p.category] = (perCategory[p.category] ?? 0) + 1;
  console.log(`Plan: ${plan.length} objects into r2://${bucket} from ${fromBucket ? `r2://${fromBucket}` : 'the source CDN'} (${dryRun ? 'dry run' : 'live'})`);
  console.table(perCategory);

  if (viaWorker && !dryRun) return copyViaWorker(plan);

  if (dryRun && !fetchSource) {
    for (const p of plan.slice(0, 10)) console.log(`  ${p.sourceUrl} -> ${p.r2Key}`);
    if (plan.length > 10) console.log(`  ... ${plan.length - 10} more`);
    return;
  }

  let existing: Set<string> | undefined;
  if (!dryRun) {
    await assertBucket();
    existing = new Set();
    for (const prefix of new Set(plan.map((p) => `public/${p.category}/`))) {
      const keys = await listKeys(prefix);
      if (!keys) {
        existing = undefined;
        break;
      }
      for (const k of keys) existing.add(k);
    }
    if (!existing) console.warn('Listing not available; checking each key with GET.');
  }

  const stats = { copied: 0, skipped: 0, failed: 0, bytes: 0 };
  const failures: Array<{ key: string; error: string }> = [];
  const started = Date.now();
  let done = 0;
  const progress = () => {
    done++;
    if (done % 25 === 0 || done === plan.length) {
      const secs = (Date.now() - started) / 1000;
      console.log(`  ${done}/${plan.length}  copied ${stats.copied}  skipped ${stats.skipped}  failed ${stats.failed}  ${formatBytes(stats.bytes)}  ${secs.toFixed(0)}s`);
    }
  };

  await pool(plan, concurrency, async (entry) => {
    try {
      if (!dryRun) {
        const exists = existing ? existing.has(entry.r2Key) : await objectExists(entry.r2Key);
        if (exists) {
          stats.skipped++;
          return;
        }
      }
      const bytes = await download(entry.sourceUrl);
      stats.bytes += bytes.byteLength;
      if (dryRun) {
        console.log(`  ok ${formatBytes(bytes.byteLength).padStart(9)}  ${entry.sourceUrl} -> ${entry.r2Key} (discarded)`);
      } else {
        await upload(entry, bytes);
      }
      stats.copied++;
    } catch (error) {
      stats.failed++;
      failures.push({ key: entry.r2Key, error: String(error instanceof Error ? error.message : error) });
    } finally {
      progress();
    }
  });

  const report = { bucket, fromBucket, dryRun, finishedAt: new Date().toISOString(), planned: plan.length, ...stats, failures };
  writeFileSync(join(OUT_DIR, dryRun ? 'r2-copy-dryrun.json' : `r2-copy-report-${bucket}.json`), JSON.stringify(report, null, 2));
  console.log(
    `${dryRun ? 'Fetched (dry run)' : 'Copied'} ${stats.copied}, skipped ${stats.skipped}, failed ${stats.failed}, ${formatBytes(stats.bytes)}.`,
  );
  for (const f of failures.slice(0, 20)) console.log(`  failed ${f.key}: ${f.error}`);
  if (stats.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
