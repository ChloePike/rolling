/**
 * Signed private media (D-008). `GET /media/<key>?exp=&ws=&sig=` verifies the
 * HMAC token and streams the object from the private bucket with Range
 * support. Served on the private media hostname (`PRIVATE_MEDIA_BASE_URL`,
 * e.g. cdn-private.rolling.actor, a custom domain of this Worker; see
 * lib/privateMediaHost.ts) and, as a fallback for local dev, on the app host.
 *
 * `GET /api/media/private/:assetId` is a convenience for signed-in clients: it
 * checks access and redirects (302) to a signed URL. It never carries bytes.
 * `?variant=poster`: the asset's poster/thumbnail (`meta.thumbKey`: a video's
 * provider poster or a still taken from the clip; an image itself), 404 when none.
 */
import { Hono } from "hono";
import { keyBelongsTo, verifyMediaSignature } from "@rolling/core/media";
import type { AppEnv } from "../env";
import { membershipFor, matureAllowedIn, requireAuth } from "../lib/access";
import { errorResponse } from "../lib/errors";
import { assetMeta, mediaSigningKey, mediaUrlFor } from "../lib/mediaUrls";
import { visibleAsset } from "./assets";
import { readShare } from "../lib/share";
import { serveR2 } from "../lib/serveR2";

export const signedMedia = new Hono<AppEnv>().on(["GET", "HEAD"], "/media/*", async (c) => {
  const url = new URL(c.req.url);
  let key: string;
  try {
    key = url.pathname.replace(/^\/media\//, "").split("/").map(decodeURIComponent).join("/");
  } catch {
    return errorResponse(c, 400, "BAD_REQUEST", "Invalid media path");
  }
  const result = await verifyMediaSignature(
    key,
    { exp: url.searchParams.get("exp"), ws: url.searchParams.get("ws"), sig: url.searchParams.get("sig") },
    mediaSigningKey(c.env),
  );
  if (!result.ok) {
    return result.reason === "expired" ? errorResponse(c, 410, "FORBIDDEN", "This link has expired", { reason: "expired" }) : errorResponse(c, 403, "FORBIDDEN", "Invalid signature", { reason: "invalid" });
  }
  // Each signed URL is immutable until it expires (keys never change content, URLs are
  // aligned to hour windows so they repeat): browsers keep it for its whole lifetime and the
  // edge cache answers repeats (after an existence check). Range and conditional requests go to R2 (206/304/416).
  const maxAge = Math.max(0, result.exp - Math.floor(Date.now() / 1000));
  const clientCacheControl = `private, max-age=${maxAge}, immutable`;
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const cacheable = !!cache && c.req.method === "GET" && !c.req.header("range") && !c.req.header("if-none-match") && !c.req.header("if-range");
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cacheable) {
    const hit = await cache!.match(cacheKey);
    // A deleted object must stop being served at once (account deletion, asset delete): the edge
    // copy saves the bytes, a metadata check confirms the object still exists.
    if (hit && !(await c.env.MEDIA.head(key))) {
      await hit.body?.cancel();
      c.executionCtx.waitUntil(cache!.delete(cacheKey).catch(() => false));
      return errorResponse(c, 404, "NOT_FOUND", "Not found");
    }
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("cache-control", clientCacheControl);
      res.headers.set("x-media-cache", "hit");
      return res;
    }
  }
  const res = await serveR2(c.env.MEDIA, key, c.req.raw, {
    cacheControl: clientCacheControl,
    headers: { "x-content-type-options": "nosniff", "x-robots-tag": "noindex" },
  });
  if (!res) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  if (cacheable && res.status === 200 && maxAge > 60) {
    // The edge copy is keyed by the full signed URL (signature included) and expires with it.
    const stored = res.clone();
    const edge = new Response(stored.body, stored);
    edge.headers.set("cache-control", `public, max-age=${maxAge}`);
    c.executionCtx.waitUntil(cache!.put(cacheKey, edge).catch(() => undefined));
  }
  return res;
});

export const privateMedia = new Hono<AppEnv>().get("/:assetId", async (c) => {
  const auth = await requireAuth(c);
  const row = await visibleAsset(c.env, auth, c.req.param("assetId"));
  if (!row || row.status === "uploading") return errorResponse(c, 404, "NOT_FOUND", "Not found");
  const m = membershipFor(auth, row.workspace_id);
  let key = row.r2_key;
  if (c.req.query("variant") === "poster") {
    const thumb = assetMeta(row).thumbKey;
    if (typeof thumb === "string" && (row.workspace_id === null || keyBelongsTo(thumb, row.workspace_id))) key = thumb;
    else if (row.kind !== "image") return errorResponse(c, 404, "NOT_FOUND", "Not found");
  }
  const signed = await mediaUrlFor(c.env, { key, workspaceId: row.workspace_id, mature: row.mature === 1 }, { mayViewMature: m ? matureAllowedIn(auth, m) : auth.matureAllowed });
  if (!signed) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  return c.redirect(signed, 302);
});

/** `GET /api/share/:id` — public for `link` shares; `workspace` shares need a signed-in member (else 404). */
export const share = new Hono<AppEnv>().get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^shr_[A-Za-z0-9]+$/.test(id)) return errorResponse(c, 404, "NOT_FOUND", "Share link not found");
  // Workspace-only links need a signed-in member (the auth middleware resolves the session when present).
  const auth = c.get("auth");
  const doc = await readShare(c.env, id, auth ? { memberOf: (ws) => auth.memberships.some((m) => m.workspaceId === ws) } : null);
  if (!doc) return errorResponse(c, 404, "NOT_FOUND", "Share link not found");
  c.header("cache-control", "no-store");
  return c.json(doc);
});
