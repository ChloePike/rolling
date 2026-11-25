import { Hono } from "hono";
import { isPublicItemServable } from "@rolling/db/queries/publicItems";
import type { AppEnv } from "../env";
import { errorResponse } from "../lib/errors";

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** `public/<category>/<itemId>/<file>` — the R2 layout written by scripts/posewear (D-004). */
const PUBLIC_KEY = /^public\/([a-z_]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.(webp|png|jpe?g))$/;

export function publicMediaUrl(r2Key: string): string {
  return `/api/media/${r2Key}`;
}

/**
 * `GET /api/media/public/...` — public-library images from R2.
 *
 * Only keys of existing, non-mature public items are served (mature items never
 * appear on public surfaces, D-005). Responses are immutable and edge-cached;
 * object keys never change content.
 */
export const media = new Hono<AppEnv>().get("/public/*", async (c) => {
  const key = c.req.path.replace(/^\/api\/media\//, "");
  const match = PUBLIC_KEY.exec(key);
  if (!match) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  const [, category, itemId, , ext] = match as unknown as [string, string, string, string, string];

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const cacheKey = new Request(new URL(`/api/media/${key}`, c.req.url).toString());
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return hit;

  if (!(await isPublicItemServable(c.env.DB, itemId, category))) {
    return errorResponse(c, 404, "NOT_FOUND", "Not found");
  }
  const object = await c.env.MEDIA.get(key);
  if (!object) return errorResponse(c, 404, "NOT_FOUND", "Not found");

  const headers = new Headers({
    "content-type": CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream",
    "cache-control": "public, max-age=86400, immutable",
    etag: object.httpEtag,
  });
  const response = new Response(object.body, { headers });
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});
