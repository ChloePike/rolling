import { Hono } from "hono";
import { isPublicItemServable } from "@rolling/db/queries/publicItems";
import type { AppEnv } from "../env";
import { errorResponse } from "../lib/errors";
import { serveR2 } from "../lib/serveR2";

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  avif: "image/avif",
  mp4: "video/mp4",
};

/** `public/<category>/<itemId>/<file>` — the R2 layout written by scripts/posewear (D-004). */
const PUBLIC_KEY = /^public\/([a-z_]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.(webp|png|jpe?g|avif|mp4))$/;

/**
 * URL of a public-library object. In production `PUBLIC_MEDIA_BASE_URL` points at
 * the public media domain (an R2 bucket with a custom domain, served by the CDN
 * without the Worker, D-008). When it is empty (local dev, staging before a
 * domain exists) the Worker's `/api/media` route serves the object instead.
 */
export function publicMediaUrl(r2Key: string, baseUrl?: string): string {
  const base = baseUrl?.replace(/\/+$/, "");
  return base ? `${base}/${r2Key}` : `/api/media/${r2Key}`;
}

/**
 * `GET /api/media/public/...` — public-library images from R2. Fallback only:
 * production serves these from the public media domain (D-008).
 *
 * Only keys of existing, non-mature public items are served (mature items never
 * appear on public surfaces, D-005). Responses are immutable and edge-cached;
 * object keys never change content.
 */
/** Built-in template covers and previews (`public/templates/<id>/…`, migrations 0017, 0020) are served for built-in templates only; MP4 only there. */
async function isServable(db: D1Database, category: string, itemId: string): Promise<boolean> {
  if (category === "templates") return !!(await db.prepare("SELECT 1 AS ok FROM templates WHERE id = ? AND workspace_id IS NULL").bind(itemId).first());
  return isPublicItemServable(db, itemId, category);
}

export const media = new Hono<AppEnv>().get("/public/*", async (c) => {
  const key = c.req.path.replace(/^\/api\/media\//, "");
  const match = PUBLIC_KEY.exec(key);
  if (!match) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  const [, category, itemId, , ext] = match as unknown as [string, string, string, string, string];
  if (ext === "mp4" && category !== "templates") return errorResponse(c, 404, "NOT_FOUND", "Not found");

  // Resumable downloads (D-011): ranged requests are answered from R2 directly (206/416).
  if (c.req.header("range")) {
    if (!(await isServable(c.env.DB, category, itemId))) return errorResponse(c, 404, "NOT_FOUND", "Not found");
    const ranged = await serveR2(c.env.MEDIA, key, c.req.raw, {
      cacheControl: "public, max-age=86400, immutable",
      contentType: CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream",
    });
    return ranged ?? errorResponse(c, 404, "NOT_FOUND", "Not found");
  }

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const cacheKey = new Request(new URL(`/api/media/${key}`, c.req.url).toString());
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return hit;

  if (!(await isServable(c.env.DB, category, itemId))) {
    return errorResponse(c, 404, "NOT_FOUND", "Not found");
  }
  const object = await c.env.MEDIA.get(key);
  if (!object) return errorResponse(c, 404, "NOT_FOUND", "Not found");

  const headers = new Headers({
    "content-type": CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream",
    "cache-control": "public, max-age=86400, immutable",
    etag: object.httpEtag,
    "accept-ranges": "bytes",
  });
  const response = new Response(object.body, { headers });
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});
