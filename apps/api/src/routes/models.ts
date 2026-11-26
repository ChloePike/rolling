import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { getSessionUser } from "../lib/session";
import { etagFor, notModified } from "../lib/httpCache";
import { validate } from "../lib/validate";
import { listPublicModels } from "../models/catalog";

const ModelsQuery = z.object({ kind: z.enum(["image", "video", "chat"]).optional() });

/** Edge cache lifetime for anonymous responses; the catalog only changes on sync (every 6 hours). */
const EDGE_TTL_SECONDS = 300;

/**
 * `GET /api/models?kind=` — the synced catalog (D-002). Public read; mature-only
 * models appear only for callers allowed to see them (D-005), so responses for
 * signed-in callers are private.
 *
 * Anonymous responses are cached at the edge (Cache API) so most requests never
 * reach D1. Every response carries an ETag; clients revalidate with
 * `If-None-Match` and get a 304 when nothing changed.
 */
export const models = new Hono<AppEnv>().get("/", validate("query", ModelsQuery), async (c) => {
  const { kind } = c.req.valid("query");
  const user = await getSessionUser(c);
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const cacheKey = new Request(new URL(`/api/models?kind=${kind ?? "all"}&v=1`, c.req.url).toString());

  if (!user && cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const etag = hit.headers.get("etag") ?? "";
      return notModified(c.req.raw, etag, new Headers(hit.headers)) ?? hit;
    }
  }

  const body = JSON.stringify({ models: await listPublicModels(c.env, user, kind) });
  const etag = await etagFor(body);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    etag,
    "cache-control": user
      ? "private, max-age=60, stale-while-revalidate=600"
      : `public, max-age=${EDGE_TTL_SECONDS}, stale-while-revalidate=3600`,
    vary: "cookie, authorization",
  });
  const response = new Response(body, { headers });
  if (!user && cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return notModified(c.req.raw, etag, headers) ?? response;
});
