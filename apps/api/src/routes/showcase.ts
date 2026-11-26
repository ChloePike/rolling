/**
 * `GET /api/showcase` — the preview clips on the sign-in and sign-up panel. Public,
 * the same for everyone, so it is cached at the edge and revalidated by ETag.
 */
import { Hono } from "hono";
import type { TemplateMeta } from "@rolling/core/templates";
import type { AppEnv } from "../env";
import { edgeCache, etagFor, notModified } from "../lib/httpCache";
import { builtinCover, parse, type CoverMeta, type TemplateRow } from "./templates";

export interface ShowcaseItem {
  id: string;
  name: string;
  /** The poster for `<video poster>`: WebP when there is one, else JPEG. */
  posterUrl: string;
  /** Every poster format, for a `<picture>` when the clip does not play. */
  poster: { avif: string | null; webp: string | null; jpg: string };
  /** Muted looping H.264 preview on the public media host (D-008). */
  previewUrl: string;
  /** CSS aspect-ratio of the poster, e.g. `9/16`. */
  aspect: string;
  width: number;
  height: number;
  /** Average poster color (`#rrggbb`), the tile's fill while it loads. */
  color: string | null;
}

export const SHOWCASE_LIMIT = 12;
/** Edge and browser lifetime; built-ins only change with a migration. */
const TTL_SECONDS = 300;
/** Bump when the item shape changes so the edge never serves the old one. */
const CACHE_VERSION = 1;

/** A built-in marked mature in its meta or tags. Mature content never appears on public surfaces (D-005). */
function isMature(meta: Partial<TemplateMeta> & { mature?: unknown }): boolean {
  if (meta.mature === true || meta.mature === 1) return true;
  return Array.isArray(meta.tags) && meta.tags.some((t) => typeof t === "string" && /^(mature|18\+|nsfw|adult)$/i.test(t));
}

/**
 * Built-in templates with a preview clip and a sized poster, in feed order (migration 0021), at most
 * `SHOWCASE_LIMIT`. Only keys already on the public bucket under the template's own folder are used
 * (`builtinCover`, the same rules as `GET /api/templates`); mature ones are left out.
 */
export async function listShowcase(env: Env, limit = SHOWCASE_LIMIT): Promise<ShowcaseItem[]> {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM templates WHERE workspace_id IS NULL AND json_extract(meta, '$.previewKey') IS NOT NULL ORDER BY created_at DESC, id",
    ).all<TemplateRow>()
  ).results;
  const items: ShowcaseItem[] = [];
  for (const row of rows) {
    const meta = parse<Partial<TemplateMeta> & CoverMeta & { mature?: unknown }>(row.meta, {});
    if (isMature(meta)) continue;
    const { cover, previewUrl } = builtinCover(env, row, meta);
    if (!cover || !previewUrl) continue;
    items.push({
      id: row.id,
      name: row.title,
      posterUrl: cover.webp ?? cover.jpg,
      poster: { avif: cover.avif, webp: cover.webp, jpg: cover.jpg },
      previewUrl,
      aspect: `${cover.width}/${cover.height}`,
      width: cover.width,
      height: cover.height,
      color: cover.color,
    });
    if (items.length >= limit) break;
  }
  return items;
}

export const showcase = new Hono<AppEnv>().get("/", async (c) => {
  const cache = edgeCache();
  const cacheKey = new Request(new URL(`/api/showcase?v=${CACHE_VERSION}`, c.req.url).toString());
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return notModified(c.req.raw, hit.headers.get("etag") ?? "", new Headers(hit.headers)) ?? hit;

  const body = JSON.stringify({ items: await listShowcase(c.env) });
  const etag = await etagFor(body);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    etag,
    "cache-control": `public, max-age=${TTL_SECONDS}, stale-while-revalidate=3600`,
  });
  const response = new Response(body, { headers });
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return notModified(c.req.raw, etag, headers) ?? response;
});
