// Copies library images from the source CDN into R2 through the Cloudflare
// REST API (no local disk staging: each image is held in memory only while
// it is uploaded).
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
//   R2_BUCKET              default rolling-media-staging; must start with "rolling-"
//
// Usage:
//   tsx scripts/posewear/copy-to-r2.ts [--category pose,outfit] [--limit N] [--include-mature]
//                                       [--concurrency 4] [--dry-run [--fetch-source]]
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
const includeMature = args.has('include-mature');
const limit = args.has('limit') ? Number(args.get('limit')) : Infinity;
const concurrency = Math.max(1, Math.min(8, Number(args.get('concurrency') ?? 4)));
const categories = typeof args.get('category') === 'string' ? new Set(String(args.get('category')).split(',')) : undefined;

const API = 'https://api.cloudflare.com/client/v4';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const bucket = process.env.R2_BUCKET ?? 'rolling-media-staging';

interface PlanEntry {
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
    if (item.mature && !includeMature) continue;
    for (const angle of item.angles) {
      plan.push({
        sourceUrl: angle.fullUrl,
        r2Key: angle.r2Key,
        contentType: contentTypeFor(angle.r2Key),
        itemId: item.id,
        category: item.category,
      });
    }
  }
  return plan.slice(0, limit);
}

function objectUrl(key: string): string {
  // Keep `/` separators; encode each segment.
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${path}`;
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
async function listKeys(prefix: string): Promise<Set<string> | undefined> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) });
    const res = await fetchWithRetry(`${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?${qs}`, {
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
  const res = await fetchWithRetry(url);
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
      headers: cfHeaders({ 'content-type': entry.contentType }),
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

async function main(): Promise<void> {
  const plan = buildPlan();
  const perCategory: Record<string, number> = {};
  for (const p of plan) perCategory[p.category] = (perCategory[p.category] ?? 0) + 1;
  console.log(`Plan: ${plan.length} objects into r2://${bucket} (${dryRun ? 'dry run' : 'live'})`);
  console.table(perCategory);

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

  const report = { bucket, dryRun, finishedAt: new Date().toISOString(), planned: plan.length, ...stats, failures };
  writeFileSync(join(OUT_DIR, dryRun ? 'r2-copy-dryrun.json' : 'r2-copy-report.json'), JSON.stringify(report, null, 2));
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
