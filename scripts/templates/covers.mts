/**
 * Template covers and previews (D-008 public media): turns the outputs of each
 * built-in template's own run into the Home inspiration / Templates card media.
 *
 *   tsx scripts/templates/covers.mts --raw <dir> --provenance <file> [--upload] [--buckets a,b] [--migration <name>]
 *
 * Input: `<raw>/<templateId>/<node>.(jpg|png|webp|mp4)`, the outputs downloaded from the
 * content workspace, and a provenance file (`{ [templateId]: { projectId, runId, runRef,
 * outputs: [{ node, kind, assetId, model, prompt, file }] } }`). Per template (see LAYOUT):
 * - video templates: the clip trimmed to PREVIEW_SEC, silent, H.264 (yuv420p, faststart),
 *   short side ≤ 720, under 1.5 MB (CRF raised until it fits); the poster is its first frame;
 * - image-only templates: a grid of their pictures (dark gutters);
 * - poster as AVIF, WebP and JPEG (fallback), 720 px wide; average color for the loading fill.
 * Keys are content-hashed (`public/templates/<id>/poster-<hash>.<ext>`, `preview-<hash>.mp4`),
 * so the immutable CDN cache never serves a stale file. `--upload` PUTs them through the R2 REST
 * API to every bucket in `--buckets` (default: the public and the media bucket of staging and
 * production); only `public/templates/*` keys in `rolling-*` buckets are ever written.
 * Writes `scripts/templates/covers.manifest.json` (source, license and provenance per item) and
 * the D1 migration that points the templates at the keys: every manifest item into 0020, or with
 * `--migration <name>` only the templates made in this run (later, incremental cover updates).
 *
 * Token: `CLOUDFLARE_API_TOKEN` (R2 write); behind a proxy that injects it pass a placeholder
 * with `NODE_USE_ENV_PROXY=1`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'e2ed20c61e6c1ce394300a753734eff9';
const DEFAULT_BUCKETS = ['rolling-public-staging', 'rolling-public-production', 'rolling-media-staging', 'rolling-media-production'];
const PREVIEW_SEC = 5;
const MAX_PREVIEW_BYTES = 1_450_000;
const POSTER_WIDTH = 720;
const GUTTER = '0x111113';
const DEFAULT_MIGRATION = '0020_template_media';

/** Which outputs make the card: a clip (video templates, `sec` to cut it shorter) or a grid of pictures. */
type Layout = { clip: string; sec?: number } | { grid: string[]; cols: number };
const LAYOUT: Record<string, Layout> = {
  tpl_tv_ad_15s: { clip: 'v1' },
  tpl_product_showcase: { clip: 'loop1' },
  tpl_talking_head: { clip: 'speak' },
  tpl_comic_page: { grid: ['p1', 'p2', 'p3', 'p4'], cols: 2 },
  tpl_character_sheet: { grid: ['front', 'side'], cols: 2 },
  tpl_storyboard: { grid: ['s1', 's2', 's3', 's4', 's5', 's6'], cols: 2 },
  tpl_holiday_greeting: { clip: 'clip' },
  tpl_outfit_try_on: { clip: 'walk' },
  // Cut before the model paints a made-up label on the product (from 2.4 s on).
  tpl_unboxing_reel: { clip: 'clip', sec: 2.2 },
  tpl_lifestyle_scene: { clip: 'clip' },
  tpl_flat_lay_promo: { clip: 'clip' },
  tpl_feature_closeups: { clip: 'v1' },
  tpl_presenter_intro: { clip: 'speak' },
  tpl_product_review: { clip: 'speak' },
  tpl_how_to_host: { clip: 'speak' },
  tpl_announcement: { clip: 'speak' },
  tpl_testimonial: { clip: 'speak' },
  tpl_drama_rooftop: { clip: 'v1' },
  tpl_drama_rain_reunion: { clip: 'v1' },
  tpl_drama_office_twist: { clip: 'v1' },
  tpl_drama_letter: { clip: 'v1' },
  tpl_drama_cafe: { clip: 'v1' },
  tpl_drama_cliffhanger: { clip: 'v1' },
  tpl_new_year_countdown: { clip: 'clip' },
  tpl_valentines_card: { clip: 'clip' },
  tpl_halloween_teaser: { clip: 'clip' },
  tpl_lunar_new_year: { clip: 'clip' },
  tpl_holiday_sale: { clip: 'clip' },
  // People in complex scenes (migration 0023).
  tpl_drama_dinner_party: { clip: 'v1' },
  tpl_drama_last_rehearsal: { clip: 'v1' },
  tpl_concert_vlog: { clip: 'clip' },
  tpl_cooking_show: { clip: 'v1' },
  tpl_wedding_toast: { clip: 'speak' },
  tpl_market_handoff: { clip: 'clip' },
};

interface Output { node: string; kind: string; assetId: string; model: string | null; prompt: string | null; file: string }
interface Provenance { projectId: string; runId: string; runRef?: string; outputs: Output[] }

export interface ManifestItem {
  templateId: string;
  source: 'generated' | 'cc0';
  /** Where the media came from: the template's own run in the content workspace (generated) or the upstream page (CC0). */
  sourceUrl: string | null;
  license: string;
  generated?: { environment: 'staging'; projectId: string; runId: string; runRef?: string; outputs: Array<{ node: string; assetId: string; model: string | null; prompt: string | null }> };
  coverKey: string;
  coverWebpKey: string;
  coverAvifKey: string;
  previewKey: string | null;
  coverWidth: number;
  coverHeight: number;
  coverColor: string;
  previewSec: number | null;
  previewBytes: number | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const probe = (file: string, entries: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);

function averageColor(file: string): string {
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return '#' + [...rgb.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trimmed, silent, faststart H.264 preview under the byte cap. */
function encodePreview(src: string, out: string, sec = PREVIEW_SEC): number {
  const [w, h] = probe(src, 'stream=width,height').split(',').map(Number) as [number, number];
  const scale = Math.min(w, h) > 720 ? (w < h ? 'scale=720:-2' : 'scale=-2:720') : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  for (const crf of [24, 26, 28, 30, 32, 34]) {
    ff(['-i', src, '-t', String(sec), '-an', '-vf', `${scale},fps=24`, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', String(crf), '-movflags', '+faststart', out]);
    if (statSync(out).size <= MAX_PREVIEW_BYTES) return crf;
  }
  throw new Error(`${src}: preview stays above ${MAX_PREVIEW_BYTES} bytes`);
}

/** A grid of pictures, each scaled to the first one's cell, with dark gutters, POSTER_WIDTH wide. */
function grid(files: string[], cols: number, out: string): void {
  const [w0, h0] = probe(files[0]!, 'stream=width,height').split(',').map(Number) as [number, number];
  const g = 8;
  const cw = Math.round((POSTER_WIDTH - g * (cols + 1)) / cols / 2) * 2;
  const ch = Math.round((cw * h0) / w0 / 2) * 2;
  const rows = Math.ceil(files.length / cols);
  const W = cw * cols + g * (cols + 1);
  const H = ch * rows + g * (rows + 1);
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}[c${i}]`);
  let chain = `color=c=${GUTTER}:s=${W}x${H}:d=1[bg0]`;
  const overlays = files.map((_, i) => {
    const x = g + (i % cols) * (cw + g);
    const y = g + Math.floor(i / cols) * (ch + g);
    return `[bg${i}][c${i}]overlay=${x}:${y}[bg${i + 1}]`;
  });
  chain = [chain, ...scaled, ...overlays].join(';');
  ff([...inputs, '-filter_complex', chain, '-map', `[bg${files.length}]`, '-frames:v', '1', out]);
}

/** AVIF, WebP and JPEG from one PNG master, POSTER_WIDTH wide. */
function posters(master: string, dir: string): { jpg: string; webp: string; avif: string; width: number; height: number } {
  const vf = `scale=${POSTER_WIDTH}:-2:flags=lanczos`;
  const jpg = join(dir, 'poster.jpg');
  const webp = join(dir, 'poster.webp');
  const avif = join(dir, 'poster.avif');
  ff(['-i', master, '-vf', vf, '-q:v', '4', '-frames:v', '1', jpg]);
  ff(['-i', master, '-vf', vf, '-c:v', 'libwebp', '-quality', '78', '-frames:v', '1', webp]);
  ff(['-i', master, '-vf', `${vf},format=yuv420p`, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '34', '-cpu-used', '6', '-frames:v', '1', avif]);
  const [width, height] = probe(jpg, 'stream=width,height').split(',').map(Number) as [number, number];
  return { jpg, webp, avif, width, height };
}

async function put(bucket: string, key: string, file: string, contentType: string): Promise<void> {
  if (!/^rolling-[a-z-]+$/.test(bucket)) throw new Error(`Refusing bucket ${bucket}: only rolling-* buckets`);
  if (!/^public\/templates\/tpl_[a-z0-9_]+\/[a-z0-9.-]+$/.test(key)) throw new Error(`Refusing ${key}: only public/templates/* keys`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ''}`, 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
      body: readFileSync(file),
    });
    if (res.ok) return;
    if (attempt >= 3) throw new Error(`PUT ${bucket}/${key} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** The D1 migration that points each built-in at its cover and preview (json_set keeps the rest of `meta`). */
export function coversMigrationSql(items: ManifestItem[], migration = DEFAULT_MIGRATION): string {
  const head = [
    `-- Migration ${migration}: cover posters (AVIF/WebP/JPEG), preview clips, poster sizes and average colors of the`,
    '-- built-in templates, made from each template\'s own run (scripts/templates/covers.mts; provenance and licenses in',
    '-- scripts/templates/covers.manifest.json). Keys are on the public media bucket (D-008); the API builds the URLs.',
    '',
  ];
  const rows = items.map((m) => {
    const set = [
      `'$.coverKey', ${sqlStr(m.coverKey)}`,
      `'$.coverWebpKey', ${sqlStr(m.coverWebpKey)}`,
      `'$.coverAvifKey', ${sqlStr(m.coverAvifKey)}`,
      `'$.previewKey', ${m.previewKey ? sqlStr(m.previewKey) : 'NULL'}`,
      `'$.coverWidth', ${m.coverWidth}`,
      `'$.coverHeight', ${m.coverHeight}`,
      `'$.coverColor', ${sqlStr(m.coverColor)}`,
    ].join(', ');
    return `UPDATE templates SET meta = json_set(COALESCE(meta, '{}'), ${set}) WHERE id = ${sqlStr(m.templateId)} AND workspace_id IS NULL;`;
  });
  return head.join('\n') + rows.join('\n') + '\n';
}

async function main(): Promise<void> {
  const raw = arg('raw');
  const provFile = arg('provenance');
  if (!raw || !provFile) throw new Error('Usage: covers.mts --raw <dir> --provenance <file> [--upload] [--buckets a,b] [--out dir]');
  const prov = JSON.parse(readFileSync(provFile, 'utf8')) as Record<string, Provenance>;
  const out = arg('out') ?? join(raw, '..', 'covers-out');
  const buckets = (arg('buckets') ?? DEFAULT_BUCKETS.join(',')).split(',');
  const upload = process.argv.includes('--upload');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const manifestFile = join(root, 'scripts/templates/covers.manifest.json');
  const previous = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as { items: ManifestItem[] }).items : [];
  const items = new Map(previous.map((m) => [m.templateId, m]));
  const made: string[] = [];

  for (const [id, layout] of Object.entries(LAYOUT)) {
    const p = prov[id];
    if (!p) {
      if (!items.has(id)) console.warn(`skip ${id}: no outputs`);
      continue;
    }
    const dir = join(out, id);
    mkdirSync(dir, { recursive: true });
    const src = (node: string) => {
      const o = p.outputs.find((x) => x.node === node);
      if (!o) throw new Error(`${id}: no output for ${node}`);
      return join(raw, id, o.file);
    };
    const master = join(dir, 'master.png');
    let previewFile: string | null = null;
    if ('clip' in layout) {
      previewFile = join(dir, 'preview.mp4');
      encodePreview(src(layout.clip), previewFile, layout.sec);
      ff(['-i', previewFile, '-frames:v', '1', master]);
    } else grid(layout.grid.map(src), layout.cols, master);
    const pst = posters(master, dir);
    const h = hash(pst.jpg);
    const base = `public/templates/${id}`;
    const item: ManifestItem = {
      templateId: id,
      source: 'generated',
      sourceUrl: null,
      license: 'first-party: generated on Rolling from the template itself (owned output, no third-party rights)',
      generated: { environment: 'staging', projectId: p.projectId, runId: p.runId, runRef: p.runRef, outputs: p.outputs.map(({ node, assetId, model, prompt }) => ({ node, assetId, model, prompt })) },
      coverKey: `${base}/poster-${h}.jpg`,
      coverWebpKey: `${base}/poster-${h}.webp`,
      coverAvifKey: `${base}/poster-${h}.avif`,
      previewKey: previewFile ? `${base}/preview-${hash(previewFile)}.mp4` : null,
      coverWidth: pst.width,
      coverHeight: pst.height,
      coverColor: averageColor(master),
      previewSec: previewFile ? Number(Number(probe(previewFile, 'stream=duration')).toFixed(2)) : null,
      previewBytes: previewFile ? statSync(previewFile).size : null,
    };
    if (upload) {
      for (const b of buckets) {
        await put(b, item.coverKey, pst.jpg, 'image/jpeg');
        await put(b, item.coverWebpKey, pst.webp, 'image/webp');
        await put(b, item.coverAvifKey, pst.avif, 'image/avif');
        if (previewFile && item.previewKey) await put(b, item.previewKey, previewFile, 'video/mp4');
      }
    }
    items.set(id, item);
    made.push(id);
    console.log(`${id}: ${pst.width}x${pst.height} ${item.coverColor}${previewFile ? ` preview ${item.previewSec}s ${item.previewBytes} B` : ''}${upload ? ` → ${buckets.length} buckets` : ''}`);
  }
  const ordered = Object.keys(LAYOUT).filter((id) => items.has(id)).map((id) => items.get(id)!);
  writeFileSync(manifestFile, JSON.stringify({ about: 'Cover and preview media of the built-in templates (scripts/templates/covers.mts). One item per template: source, license, provenance, keys.', items: ordered }, null, 2) + '\n');
  const migration = arg('migration');
  const covered = migration ? ordered.filter((m) => made.includes(m.templateId)) : ordered;
  const name = migration ?? DEFAULT_MIGRATION;
  writeFileSync(join(root, `packages/db/migrations/d1/${name}.sql`), coversMigrationSql(covered, name));
  console.log(`wrote ${manifestFile} and migration ${name} (${covered.length} templates)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
