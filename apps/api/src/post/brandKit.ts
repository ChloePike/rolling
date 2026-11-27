/**
 * Brand kit (D-035), one per workspace in D1 `brand_kits` (JSON). Fonts live in
 * R2 under `ws/<workspace>/brand/fonts/<id>.<ext>`; the logo is an image asset
 * of the workspace. Exports turn the kit into `RenderBrand` + `RenderFont`s
 * with signed URLs (D-008); the agent gets `brandKitSummary`.
 */
import { BrandKitInputSchema, emptyBrandKit, fontById, normalizeBrandKit, resolveCaptionLook, type BrandKit, type BrandKitInput, type BrandFont } from "@rolling/core/post";
import type { RenderBrand, RenderCaptions, RenderFont } from "@rolling/core/export";
import type { CaptionStyleId } from "@rolling/core/timeline";
import { ApiError } from "../lib/errors";
import { signMediaUrl } from "../lib/mediaUrls";

export const fontKey = (workspaceId: string, font: Pick<BrandFont, "id" | "format">) => `ws/${workspaceId}/brand/fonts/${font.id}.${font.format}`;

export async function loadBrandKit(env: Env, workspaceId: string): Promise<BrandKit> {
  const row = await env.DB.prepare("SELECT data, updated_at FROM brand_kits WHERE workspace_id = ?").bind(workspaceId).first<{ data: string; updated_at: number }>();
  if (!row) return emptyBrandKit();
  try {
    const raw = JSON.parse(row.data) as Partial<BrandKit>;
    const input = BrandKitInputSchema.parse(raw);
    return normalizeBrandKit({ ...input, fonts: Array.isArray(raw.fonts) ? raw.fonts : [], updatedAt: row.updated_at });
  } catch {
    return emptyBrandKit();
  }
}

async function save(env: Env, workspaceId: string, userId: string, kit: BrandKit): Promise<BrandKit> {
  const now = Date.now();
  const { updatedAt: _u, ...data } = normalizeBrandKit(kit);
  await env.DB.prepare(
    "INSERT INTO brand_kits (workspace_id, data, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
  )
    .bind(workspaceId, JSON.stringify(data), userId, now)
    .run();
  return { ...normalizeBrandKit(kit), updatedAt: now };
}

/** Replaces the settable fields; the logo must be a ready image of the workspace. */
export async function putBrandKit(env: Env, workspaceId: string, userId: string, input: BrandKitInput): Promise<BrandKit> {
  if (input.logoAssetId) {
    const a = await env.DB.prepare("SELECT kind, status, workspace_id FROM assets WHERE id = ?").bind(input.logoAssetId).first<{ kind: string; status: string; workspace_id: string | null }>();
    if (!a || a.workspace_id !== workspaceId || a.kind !== "image") throw new ApiError(422, "VALIDATION_FAILED", "The logo must be an image in this workspace's Assets", { field: "logoAssetId" });
  }
  const current = await loadBrandKit(env, workspaceId);
  return save(env, workspaceId, userId, { ...current, ...input });
}

export async function addBrandFont(env: Env, workspaceId: string, userId: string, font: BrandFont, bytes: ArrayBuffer): Promise<BrandKit> {
  const kit = await loadBrandKit(env, workspaceId);
  if (kit.fonts.length >= 4) throw new ApiError(422, "VALIDATION_FAILED", "A brand kit holds up to 4 fonts", { reason: "TOO_MANY_FONTS" });
  const type = font.format === "woff2" ? "font/woff2" : font.format === "otf" ? "font/otf" : "font/ttf";
  await env.MEDIA.put(fontKey(workspaceId, font), bytes, { httpMetadata: { contentType: type, cacheControl: "private, max-age=31536000, immutable" } });
  return save(env, workspaceId, userId, { ...kit, fonts: [...kit.fonts, font] });
}

export async function removeBrandFont(env: Env, workspaceId: string, userId: string, fontId: string): Promise<BrandKit> {
  const kit = await loadBrandKit(env, workspaceId);
  const font = kit.fonts.find((f) => f.id === fontId);
  if (!font) throw new ApiError(404, "NOT_FOUND", "Font not found");
  await env.MEDIA.delete(fontKey(workspaceId, font));
  return save(env, workspaceId, userId, { ...kit, fonts: kit.fonts.filter((f) => f.id !== fontId) });
}

/** The kit as the client sees it: fonts and logo with short-lived URLs for preview (FontFace, img). */
export async function brandKitView(env: Env, workspaceId: string, kit: BrandKit) {
  const fonts = await Promise.all(kit.fonts.map(async (f) => ({ ...f, url: await signMediaUrl(env, fontKey(workspaceId, f), { workspaceId, expiresIn: 3600 }) })));
  let logoUrl: string | null = null;
  if (kit.logoAssetId) {
    const a = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ? AND workspace_id = ?").bind(kit.logoAssetId, workspaceId).first<{ r2_key: string }>();
    if (a) logoUrl = await signMediaUrl(env, a.r2_key, { workspaceId, expiresIn: 3600 });
  }
  return { ...kit, fonts, logoUrl };
}

const TTL = 4 * 3600;

/**
 * Render pieces of an export: the caption look (brand caption font and primary
 * color when `brand`), brand fonts, watermark and cards. Without `brand` only
 * the caption look is resolved.
 */
export async function renderBrand(env: Env, workspaceId: string, opts: { brand: boolean; style: CaptionStyleId | undefined; lang: string | null; burnCaptions: boolean }): Promise<{ captions: RenderCaptions | null; fonts: RenderFont[]; brand?: RenderBrand }> {
  const kit = opts.brand ? await loadBrandKit(env, workspaceId) : null;
  const fonts: RenderFont[] = [];
  const addFont = async (f: BrandFont | null): Promise<string | undefined> => {
    if (!f) return undefined;
    if (!fonts.some((x) => x.family === f.family)) fonts.push({ family: f.family, format: f.format, url: await signMediaUrl(env, fontKey(workspaceId, f), { workspaceId, expiresIn: TTL, absolute: true }) });
    return f.family;
  };
  const captionFamily = kit ? await addFont(fontById(kit, kit.captionFontId)) : undefined;
  const captions: RenderCaptions | null = opts.burnCaptions
    ? { look: resolveCaptionLook(opts.style, { lang: opts.lang, brandColor: kit?.colors[0] ?? null, brandFont: captionFamily ?? null }), lang: opts.lang }
    : null;
  if (!kit) return { captions, fonts };
  const brand: RenderBrand = {};
  let logoUrl: string | undefined;
  if (kit.logoAssetId) {
    const a = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ? AND workspace_id = ? AND status = 'ready'").bind(kit.logoAssetId, workspaceId).first<{ r2_key: string }>();
    if (a) logoUrl = await signMediaUrl(env, a.r2_key, { workspaceId, expiresIn: TTL, absolute: true });
  }
  if (kit.watermark.enabled && logoUrl) brand.watermark = { url: logoUrl, position: kit.watermark.position, opacity: kit.watermark.opacity, size: kit.watermark.size };
  const headingFamily = await addFont(fontById(kit, kit.headingFontId));
  const bg = (c: string | null) => c ?? kit.colors[0] ?? "#000000";
  const card = (c: BrandKit["intro"]) => {
    const background = bg(c.background);
    return {
      seconds: c.seconds,
      background,
      color: readable(background),
      text: c.text,
      ...(headingFamily && { fontFamily: headingFamily }),
      ...(c.showLogo && logoUrl && { logoUrl }),
    };
  };
  if (kit.intro.enabled) brand.intro = card(kit.intro);
  if (kit.outro.enabled) brand.outro = card(kit.outro);
  return { captions, fonts, ...(Object.keys(brand).length && { brand }) };
}

function readable(hex: string): string {
  const v = Number.parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  return lum > 0.55 ? "#111111" : "#FFFFFF";
}
