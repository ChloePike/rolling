// Fetches PoseWear's data index files, normalizes every item and writes
// out/snapshot.json + out/summary.json. Metadata only: no images are saved.
//
// Usage: tsx scripts/posewear/fetch.ts [--no-sizes] [--sample 20]
//
// Downloaded files are treated as untrusted data: JavaScript is read as text
// (regex) to discover data file URLs and is never executed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIBRARY_CATEGORIES,
  POSEWEAR_SITE_ORIGIN,
  buildPoseWearLibrary,
  categoryForPoseWearTab,
  type LibraryCategoryKey,
  type PublicLibraryItem,
} from '../../packages/core/src/library/index.ts';
import { HERE, OUT_DIR, SNAPSHOT_PATH, ensureOutDir, fetchWithRetry, formatBytes, parseArgs, pool, readJson } from './lib.ts';

const args = parseArgs(process.argv.slice(2));
const SAMPLE = Number(args.get('sample') ?? 20);

async function text(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Finds `/assets/app.<hash>.js` on the homepage and reads its tab -> data file map. */
async function discoverDataFiles(): Promise<{ appUrl: string; i18nUrl?: string; files: Map<string, string> }> {
  const home = await text(`${POSEWEAR_SITE_ORIGIN}/`);
  const app = home.match(/\/assets\/app\.[0-9a-f]+\.js/)?.[0];
  if (!app) throw new Error('Could not find app.<hash>.js on the PoseWear homepage');
  const i18n = home.match(/\/assets\/i18n\.[0-9a-f]+\.js/)?.[0];
  const appJs = await text(`${POSEWEAR_SITE_ORIGIN}${app}`);
  const files = new Map<string, string>();
  for (const m of appJs.matchAll(/([a-z]+):'(\/assets\/[a-z]+\.[0-9a-f]+\.json)'/g)) {
    if (categoryForPoseWearTab(m[1]!)) files.set(m[1]!, m[2]!);
  }
  if (!files.size) throw new Error('No data files found in app.js');
  return { appUrl: `${POSEWEAR_SITE_ORIGIN}${app}`, ...(i18n ? { i18nUrl: `${POSEWEAR_SITE_ORIGIN}${i18n}` } : {}), files };
}

/** Label table: our committed labels.json first, then the site's i18n table (parsed as text). */
async function buildTranslator(i18nUrl?: string): Promise<(label: string) => string | undefined> {
  const committed = readJson<{ labels: Record<string, string> }>(join(HERE, 'labels.json')).labels;
  const fromSite = new Map<string, string>();
  if (i18nUrl) {
    try {
      const js = await text(i18nUrl);
      for (const m of js.matchAll(/'((?:[^'\\]|\\.)+)'\s*:\s*\[\s*'((?:[^'\\]|\\.)+)'/g)) fromSite.set(m[1]!, m[2]!);
    } catch (error) {
      console.warn(`i18n table not available: ${String(error)}`);
    }
  }
  return (label) => committed[label] ?? fromSite.get(label);
}

interface SizeEstimate {
  sampled: number;
  avgBytes: number;
  images: number;
  estimatedBytes: number;
}

async function estimateSizes(items: PublicLibraryItem[]): Promise<Partial<Record<LibraryCategoryKey, SizeEstimate>>> {
  const out: Partial<Record<LibraryCategoryKey, SizeEstimate>> = {};
  for (const cat of LIBRARY_CATEGORIES) {
    const angles = items.filter((i) => i.category === cat.key).flatMap((i) => i.angles);
    if (!angles.length) continue;
    const step = Math.max(1, Math.floor(angles.length / SAMPLE));
    const sample = angles.filter((_, i) => i % step === 0).slice(0, SAMPLE);
    const sizes: number[] = [];
    await pool(sample, 4, async (angle) => {
      try {
        const res = await fetchWithRetry(angle.fullUrl, { method: 'HEAD' });
        const len = Number(res.headers.get('content-length'));
        if (res.ok && len > 0) {
          sizes.push(len);
          return;
        }
        // Pages hosts omit Content-Length on HEAD; count the bytes in memory instead (nothing is stored).
        const get = await fetchWithRetry(angle.fullUrl);
        if (get.ok) sizes.push((await get.arrayBuffer()).byteLength);
        else await get.body?.cancel();
      } catch {
        // Missing samples only reduce precision.
      }
    });
    const avg = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    out[cat.key] = { sampled: sizes.length, avgBytes: Math.round(avg), images: angles.length, estimatedBytes: Math.round(avg * angles.length) };
  }
  return out;
}

async function main(): Promise<void> {
  ensureOutDir();
  const { appUrl, i18nUrl, files } = await discoverDataFiles();
  const translate = await buildTranslator(i18nUrl);

  const datasets: Partial<Record<LibraryCategoryKey, unknown>> = {};
  const fileUrls: Record<string, string> = {};
  let depthPack: unknown;
  for (const [tab, path] of files) {
    const category = categoryForPoseWearTab(tab)!;
    const url = `${POSEWEAR_SITE_ORIGIN}${path}`;
    fileUrls[category.key] = url;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data: unknown = await res.json();
    datasets[category.key] = data;
    if (category.key === 'pose_depth' && data && typeof data === 'object' && 'pack' in data) {
      depthPack = (data as { pack: unknown }).pack;
    }
  }

  const { items, rejected, sourceCounts } = buildPoseWearLibrary(datasets, { translate });

  const missingLabels = new Set<string>();
  for (const item of items) if (!item.sub && item.category !== 'expression') missingLabels.add(`${item.category}`);

  const perCategory = LIBRARY_CATEGORIES.map((c) => {
    const list = items.filter((i) => i.category === c.key);
    const subs: Record<string, number> = {};
    for (const i of list) subs[i.sub ?? '(none)'] = (subs[i.sub ?? '(none)'] ?? 0) + 1;
    return {
      category: c.key,
      menuCount: c.expectedCount,
      sourceCount: sourceCounts[c.key] ?? 0,
      mapped: list.length,
      mature: list.filter((i) => i.mature).length,
      publicSafe: list.filter((i) => !i.mature).length,
      rejected: rejected.filter((r) => r.category === c.key).length,
      angleImages: list.reduce((n, i) => n + i.angles.length, 0),
      withDepth: list.filter((i) => i.depthUrl).length,
      licenses: [...new Set(list.map((i) => i.license))],
      subs,
    };
  });

  const sizes = args.has('no-sizes') ? undefined : await estimateSizes(items);

  const summary = {
    fetchedAt: new Date().toISOString(),
    source: { site: POSEWEAR_SITE_ORIGIN, appUrl, i18nUrl, files: fileUrls },
    depthPack,
    totals: {
      items: items.length,
      mature: items.filter((i) => i.mature).length,
      publicSafe: items.filter((i) => !i.mature).length,
      angleImages: items.reduce((n, i) => n + i.angles.length, 0),
      rejected: rejected.length,
      ...(sizes
        ? { estimatedBytes: Object.values(sizes).reduce((n, s) => n + (s?.estimatedBytes ?? 0), 0) }
        : {}),
    },
    perCategory,
    sizes,
    rejected,
    categoriesWithoutSub: [...missingLabels],
  };

  writeFileSync(SNAPSHOT_PATH, JSON.stringify({ ...summary, items }, null, 1));
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.table(
    perCategory.map((c) => ({
      category: c.category,
      menu: c.menuCount,
      source: c.sourceCount,
      mapped: c.mapped,
      mature: c.mature,
      public: c.publicSafe,
      rejected: c.rejected,
      images: c.angleImages,
      depth: c.withDepth,
      license: c.licenses.join('/'),
      estSize: sizes?.[c.category] ? formatBytes(sizes[c.category]!.estimatedBytes) : '-',
    })),
  );
  console.log(
    `Total: ${summary.totals.items} items, ${summary.totals.angleImages} images, ${summary.totals.mature} mature, ${summary.totals.rejected} rejected` +
      (summary.totals.estimatedBytes !== undefined ? `, about ${formatBytes(summary.totals.estimatedBytes)}` : ''),
  );
  for (const r of rejected) console.log(`  rejected ${r.category}/${r.sourceId ?? '?'}: ${r.reason}`);
  console.log(`Wrote ${SNAPSHOT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
