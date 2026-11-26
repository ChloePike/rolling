import { z } from 'zod';
import { CHARADB_ATTRIBUTION, getLibraryCategory, type LibraryCategory } from './categories';
import {
  PublicLibraryItemSchema,
  type LibraryAngle,
  type LibraryCategoryKey,
  type LocalizedText,
  type PublicLibraryItem,
} from './types';

/**
 * Mapping from PoseWear's static JSON data files to normalized library items.
 * Pure functions: no I/O, Workers-safe. All input is untrusted data and is
 * validated leniently (unknown fields pass through and are ignored).
 */

export const POSEWEAR_SITE_ORIGIN = 'https://posewear.pages.dev';
export const POSEWEAR_ASSET_HOST = 'https://pwimg.0vo.pro';

// ---------------------------------------------------------------------------
// Raw source shapes
// ---------------------------------------------------------------------------

const optStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .optional()
  .catch(undefined);

export const PoseWearRawAngleSchema = z
  .object({ zh: optStr, en: optStr, ja: optStr, t: optStr, i: optStr, m: optStr, o: optStr })
  .passthrough();
export type PoseWearRawAngle = z.infer<typeof PoseWearRawAngleSchema>;

export const PoseWearRawItemSchema = z
  .object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    no: optStr,
    cat: optStr,
    catEn: optStr,
    line: optStr,
    lineEn: optStr,
    kw: optStr,
    ti: optStr,
    zh: optStr,
    en: optStr,
    ja: optStr,
    t: optStr,
    m: optStr,
    i: optStr,
    o: optStr,
    /** Source adult flag: the site hides these unless its 18+ switch is on. */
    a: z.union([z.number(), z.boolean()]).optional().catch(undefined),
    ext: z.union([z.number(), z.boolean()]).optional().catch(undefined),
    angles: z.array(PoseWearRawAngleSchema).optional().catch(undefined),
    sec: optStr,
    len: optStr,
    st: optStr,
    emoEn: optStr,
    intEn: optStr,
    eraEn: optStr,
    gender: optStr,
    light: optStr,
    setting: optStr,
  })
  .passthrough();
export type PoseWearRawItem = z.infer<typeof PoseWearRawItemSchema>;

/** Data files are either a bare array or `{ pack, items }` (depth poses). */
export function extractPoseWearItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface PoseWearMapContext {
  siteOrigin?: string;
  assetHost?: string;
  /** Translates a source label (sub-category values without an English field) to English. */
  translate?: (label: string) => string | undefined;
  /** Source ids whose counterpart (pose <-> pose_depth) is flagged adult. */
  counterpartAdultIds?: ReadonlySet<string>;
  /** Counterpart raw items by source id (pose <-> pose_depth), used for depth URLs and ids. */
  counterparts?: ReadonlyMap<string, PoseWearRawItem>;
}

const ANGLE_NAMES: Record<string, string> = {
  'front view': 'front',
  'three-quarter view': 'three_quarter',
  'side view': 'side',
  'back view': 'back',
  'high angle, from above': 'high',
  'low angle, from below': 'low',
  'eye-level view': 'eye_level',
};

export function angleNameFromEnglish(en: string | undefined, fallback: string): string {
  if (!en) return fallback;
  const known = ANGLE_NAMES[en.toLowerCase()];
  if (known) return known;
  const slug = en
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sanitizeSourceId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function libraryItemId(category: LibraryCategoryKey, sourceId: string): string {
  return `pw_${category}_${sanitizeSourceId(sourceId)}`;
}

/** File extension of an image URL (`webp`, `png`, `jpg`); defaults to `webp`. */
export function imageExtension(url: string): 'webp' | 'png' | 'jpg' {
  const m = /\.(webp|png|jpe?g)(?:[?#]|$)/i.exec(url);
  const ext = m?.[1]?.toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  return 'webp';
}

/**
 * R2 key for one angle image: `public/<category>/<itemId>/<angle>.<ext>`.
 * The extension follows the source bytes (most are webp; depth maps are png,
 * CharaDB images are jpg) so stored objects are never mislabeled.
 */
export function libraryR2Key(category: LibraryCategoryKey, itemId: string, angle: string, ext = 'webp'): string {
  return `public/${category}/${itemId}/${angle}.${ext}`;
}

/** Thumbnails live on the asset host; relative paths resolve against it. */
function thumbUrl(path: string, ctx: PoseWearMapContext): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${(ctx.assetHost ?? POSEWEAR_ASSET_HOST).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** Display images (`i`, `m`) are served from the site origin when relative. */
function displayUrl(path: string, ctx: PoseWearMapContext): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${(ctx.siteOrigin ?? POSEWEAR_SITE_ORIGIN).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const isAscii = (s: string): boolean => /^[\x20-\x7E]+$/.test(s);

/** A short English title from a long descriptive prompt: first clause, no leading article. */
export function shortTitleFromPrompt(en: string, maxLength = 80): string {
  let s = en.trim();
  s = s.replace(/^(spring|summer|autumn|winter|party|swimsuit|lingerie|sexy) outfit,\s*/i, '');
  const clause = s.split(/[:;,]/)[0] ?? s;
  s = clause.replace(/^(a|an|the)\s+/i, '').trim();
  if (s.length > maxLength) {
    const cut = s.slice(0, maxLength);
    const space = cut.lastIndexOf(' ');
    s = (space > 20 ? cut.slice(0, space) : cut).trim();
  }
  return capitalize(s);
}


/** True for items whose images are hosted by CharaDB rather than PoseWear. */
export function isCharaDbHosted(raw: PoseWearRawItem): boolean {
  const urls = [raw.t, raw.i, raw.m, ...(raw.angles ?? []).flatMap((a) => [a.t, a.i])];
  return urls.some((u) => typeof u === 'string' && u.startsWith('https://charadb-2fi.pages.dev/'));
}

const GENDER_TAGS: Record<string, string> = { M: 'male', F: 'female', U: 'unisex' };

/**
 * Mature detection (D-005). The source's own adult flag is authoritative; the
 * rules below catch items the source left unflagged in one of a pair
 * (pose vs depth pose) or that describe underwear explicitly.
 */
const MATURE_CATEGORY_TERMS = new Set(['lingerie', 'sexy']);
const MATURE_TEXT =
  /\b(lingerie|underwear|panties|thong|nude|naked|topless|negligee|garter|bunny girl)\b|(?<!sports |seashell )\bbra\b/i;
/** Items that are mature and minor-coded are excluded from import entirely (D-005 hard limit). */
const MINOR_CODED_TEXT = /\b(school|schoolgirl|student|loli|lolita|child|children|kid|kids|teen|teenage)\b/i;

export function isPoseWearMature(raw: PoseWearRawItem, ctx: PoseWearMapContext = {}): boolean {
  if (raw.a) return true;
  if (ctx.counterpartAdultIds?.has(raw.id)) return true;
  if (raw.catEn && MATURE_CATEGORY_TERMS.has(raw.catEn.toLowerCase())) return true;
  if (raw.lineEn && /\b(sexy|couple)\b/i.test(raw.lineEn)) return true;
  return MATURE_TEXT.test(`${raw.en ?? ''} ${raw.kw ?? ''}`);
}

export function isPoseWearMinorCoded(raw: PoseWearRawItem): boolean {
  return MINOR_CODED_TEXT.test(`${raw.en ?? ''} ${raw.kw ?? ''} ${raw.catEn ?? ''}`);
}

interface SubInfo {
  sub?: string;
  subLabel?: LocalizedText;
  extraTags: string[];
}

function translated(label: string | undefined, ctx: PoseWearMapContext): LocalizedText | undefined {
  if (!label) return undefined;
  if (isAscii(label)) return { en: label };
  const en = ctx.translate?.(label);
  return en ? { en, zh: label } : undefined;
}

function subInfo(category: LibraryCategoryKey, raw: PoseWearRawItem, ctx: PoseWearMapContext): SubInfo {
  const extraTags: string[] = [];
  let label: LocalizedText | undefined;
  switch (category) {
    case 'pose':
    case 'pose_depth':
      label = translated(raw.cat, ctx);
      if (raw.lineEn) extraTags.push(...raw.lineEn.split(',').map((s) => s.trim()));
      break;
    case 'portrait': {
      label = translated(raw.sec, ctx);
      const len = translated(raw.len, ctx);
      if (len) extraTags.push(len.en);
      break;
    }
    case 'expression':
      if (raw.emoEn) label = { en: capitalize(raw.emoEn), ...(raw.cat ? { zh: raw.cat } : {}) };
      if (raw.intEn) extraTags.push(raw.intEn);
      break;
    case 'hairstyle':
      label = translated(raw.cat, ctx);
      break;
    case 'outfit':
    case 'outfit_anime':
      if (raw.catEn) label = { en: capitalize(raw.catEn), ...(raw.cat ? { zh: raw.cat } : {}) };
      break;
    case 'outfit_historical':
      if (raw.eraEn) label = { en: raw.eraEn, ...(raw.line ? { zh: raw.line } : {}) };
      if (raw.gender && GENDER_TAGS[raw.gender]) extraTags.push(GENDER_TAGS[raw.gender]!);
      break;
    case 'scene':
    case 'lighting':
    case 'prop':
    case 'furniture':
      label = translated(raw.cat, ctx);
      if (raw.lineEn) extraTags.push(raw.lineEn);
      break;
  }
  const sub = label ? slugify(label.en) || undefined : undefined;
  return { ...(sub ? { sub } : {}), ...(label ? { subLabel: label } : {}), extraTags };
}

function titleFor(category: LibraryCategoryKey, raw: PoseWearRawItem, ctx: PoseWearMapContext): LocalizedText {
  const zh = raw.ti || raw.zh || undefined;
  const withZh = (en: string): LocalizedText => ({ en, ...(zh ? { zh } : {}) });
  switch (category) {
    case 'pose':
    case 'pose_depth':
      return { en: capitalize(raw.en || raw.id), ...(raw.zh ? { zh: raw.zh } : {}) };
    case 'portrait': {
      const parts = [translated(raw.len, ctx)?.en, translated(raw.sec, ctx)?.en].filter(Boolean);
      return withZh(parts.length ? parts.join(' · ') : shortTitleFromPrompt(raw.en || raw.id));
    }
    case 'expression':
      return withZh(raw.ja && isAscii(raw.ja) ? raw.ja : shortTitleFromPrompt(raw.en || raw.id));
    case 'hairstyle':
      return withZh(capitalize(raw.en || raw.id));
    default:
      return withZh(raw.en ? shortTitleFromPrompt(raw.en) : raw.id);
  }
}

const FULLWIDTH_COMMA = '\uFF0C';

function promptFor(category: LibraryCategoryKey, raw: PoseWearRawItem): { en?: string; zh?: string } {
  let en = raw.en;
  let zh = raw.zh;
  if ((category === 'pose' || category === 'pose_depth') && raw.angles?.length) {
    // Matches the source site's own prompt composition: text + framing line.
    if (en && raw.lineEn) en = `${en}, ${raw.lineEn}`;
    if (zh && raw.line) zh = `${zh}${FULLWIDTH_COMMA}${raw.line}`;
  }
  if (category === 'scene' && en && raw.light) en = `${en}. ${raw.light}`;
  return { ...(en ? { en } : {}), ...(zh ? { zh } : {}) };
}

function tagsFor(raw: PoseWearRawItem, sub: SubInfo): string[] {
  const tags: string[] = [];
  if (sub.subLabel) tags.push(sub.subLabel.en);
  tags.push(...sub.extraTags);
  if (raw.kw && raw.kw.includes(',')) {
    tags.push(...raw.kw.split(',').map((s) => s.trim()).slice(0, 12));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const v = t.toLowerCase().trim();
    if (v && isAscii(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function counterpartCategory(category: LibraryCategoryKey): LibraryCategoryKey | undefined {
  if (category === 'pose') return 'pose_depth';
  if (category === 'pose_depth') return 'pose';
  return undefined;
}

function anglesFor(
  category: LibraryCategoryKey,
  itemId: string,
  raw: PoseWearRawItem,
  ctx: PoseWearMapContext,
): LibraryAngle[] {
  const counterpart = ctx.counterparts?.get(raw.id);
  const used = new Set<string>();
  const uniqueName = (name: string): string => {
    let n = name;
    for (let k = 2; used.has(n); k++) n = `${name}_${k}`;
    used.add(n);
    return n;
  };

  if (raw.angles && raw.angles.length) {
    const out: LibraryAngle[] = [];
    raw.angles.forEach((a, index) => {
      const display = a.i || a.m || a.o;
      const thumb = a.t || display;
      if (!display || !thumb) return;
      const name = uniqueName(angleNameFromEnglish(a.en, `view_${index + 1}`));
      const fullUrl = displayUrl(display, ctx);
      let depthUrl: string | undefined;
      if (category === 'pose_depth') depthUrl = fullUrl;
      else if (category === 'pose' && counterpart?.angles) {
        const match = counterpart.angles.find((d) => d.en && d.en === a.en);
        const d = match?.i || match?.m;
        if (d) depthUrl = displayUrl(d, ctx);
      }
      out.push({
        name,
        label: { en: capitalize(a.en || name.replace(/_/g, ' ')), ...(a.zh ? { zh: a.zh } : {}) },
        thumbUrl: thumbUrl(thumb, ctx),
        fullUrl,
        ...(depthUrl ? { depthUrl } : {}),
        r2Key: libraryR2Key(category, itemId, name, imageExtension(fullUrl)),
      });
    });
    return out;
  }

  const display = raw.i || raw.m || raw.o;
  const thumb = raw.t || display;
  if (!display || !thumb) return [];
  const fullUrl = displayUrl(display, ctx);
  return [
    {
      name: 'main',
      label: { en: 'Main' },
      thumbUrl: thumbUrl(thumb, ctx),
      fullUrl,
      r2Key: libraryR2Key(category, itemId, 'main', imageExtension(fullUrl)),
    },
  ];
}

// ---------------------------------------------------------------------------
// Public mapping API
// ---------------------------------------------------------------------------

export type PoseWearMapResult =
  | { ok: true; item: PublicLibraryItem }
  | { ok: false; reason: 'invalid' | 'no_images' | 'excluded_minor_coded'; sourceId?: string; detail?: string };

export function mapPoseWearItem(
  category: LibraryCategoryKey,
  input: unknown,
  ctx: PoseWearMapContext = {},
): PoseWearMapResult {
  const parsed = PoseWearRawItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', detail: parsed.error.message };
  const raw = parsed.data;
  const cat: LibraryCategory = getLibraryCategory(category);

  const mature = isPoseWearMature(raw, ctx);
  if (mature && isPoseWearMinorCoded(raw)) {
    return { ok: false, reason: 'excluded_minor_coded', sourceId: raw.id };
  }

  const id = libraryItemId(category, raw.id);
  const angles = anglesFor(category, id, raw, ctx);
  const cover = angles[0];
  if (!cover) return { ok: false, reason: 'no_images', sourceId: raw.id };

  const sub = subInfo(category, raw, ctx);
  const fromCharaDb = isCharaDbHosted(raw);
  const other = counterpartCategory(category);
  const siteOrigin = (ctx.siteOrigin ?? POSEWEAR_SITE_ORIGIN).replace(/\/$/, '');

  const item = {
    id,
    sourceId: raw.id,
    category,
    ...(sub.sub ? { sub: sub.sub } : {}),
    ...(sub.subLabel ? { subLabel: sub.subLabel } : {}),
    title: titleFor(category, raw, ctx),
    prompt: promptFor(category, raw),
    tags: tagsFor(raw, sub),
    angles,
    ...(cover.depthUrl ? { depthUrl: cover.depthUrl } : {}),
    ...(other && ctx.counterparts?.has(raw.id) ? { counterpartId: libraryItemId(other, raw.id) } : {}),
    // Anime outfits hotlinked from CharaDB are not PoseWear originals: they carry
    // CharaDB's CC0 marking, like the hairstyle category.
    license: fromCharaDb ? 'cc0' : cat.license,
    attribution: fromCharaDb ? CHARADB_ATTRIBUTION : cat.attribution,
    sourceUrl: `${siteOrigin}/#${cat.sourceTab}/${encodeURIComponent(raw.id)}`,
    sourceThumbUrl: cover.thumbUrl,
    sourceFullUrl: cover.fullUrl,
    mature,
  };
  const checked = PublicLibraryItemSchema.safeParse(item);
  if (!checked.success) return { ok: false, reason: 'invalid', sourceId: raw.id, detail: checked.error.message };
  return { ok: true, item: checked.data };
}

export interface PoseWearBuildResult {
  items: PublicLibraryItem[];
  rejected: Array<{ category: LibraryCategoryKey; reason: string; sourceId?: string; detail?: string }>;
  /** Raw record counts per category, before mapping. */
  sourceCounts: Partial<Record<LibraryCategoryKey, number>>;
}

/**
 * Maps whole data files. Pose and depth-pose files are cross-linked: shared
 * source ids get `counterpartId`, per-angle depth URLs, and the union of both
 * files' adult flags (the two files flag different subsets).
 */
export function buildPoseWearLibrary(
  datasets: Partial<Record<LibraryCategoryKey, unknown>>,
  ctx: Omit<PoseWearMapContext, 'counterpartAdultIds' | 'counterparts'> = {},
): PoseWearBuildResult {
  const rawByCategory = new Map<LibraryCategoryKey, PoseWearRawItem[]>();
  const rejected: PoseWearBuildResult['rejected'] = [];
  const sourceCounts: PoseWearBuildResult['sourceCounts'] = {};

  for (const [key, data] of Object.entries(datasets) as Array<[LibraryCategoryKey, unknown]>) {
    const list = extractPoseWearItems(data);
    sourceCounts[key] = list.length;
    const ok: PoseWearRawItem[] = [];
    for (const entry of list) {
      const p = PoseWearRawItemSchema.safeParse(entry);
      if (p.success) ok.push(p.data);
      else rejected.push({ category: key, reason: 'invalid', detail: p.error.message });
    }
    rawByCategory.set(key, ok);
  }

  const index = (key: LibraryCategoryKey) => new Map((rawByCategory.get(key) ?? []).map((r) => [r.id, r]));
  const adultIds = (key: LibraryCategoryKey) =>
    new Set((rawByCategory.get(key) ?? []).filter((r) => r.a).map((r) => r.id));

  const items: PublicLibraryItem[] = [];
  for (const [key, list] of rawByCategory) {
    const other = counterpartCategory(key);
    const itemCtx: PoseWearMapContext = {
      ...ctx,
      ...(other ? { counterparts: index(other), counterpartAdultIds: adultIds(other) } : {}),
    };
    for (const raw of list) {
      const r = mapPoseWearItem(key, raw, itemCtx);
      if (r.ok) items.push(r.item);
      else rejected.push({ category: key, reason: r.reason, ...(r.sourceId ? { sourceId: r.sourceId } : {}), ...(r.detail ? { detail: r.detail } : {}) });
    }
  }
  return { items, rejected, sourceCounts };
}
