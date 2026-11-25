/**
 * Signed private media (D-008). `GET /media/<key>?exp=&ws=&sig=` verifies the
 * HMAC token and streams the object from the private bucket with Range
 * support. Lives in this Worker until the media hostname exists; then it moves
 * to the media Worker unchanged (same verify code in `@rolling/core/media`).
 *
 * `GET /api/media/private/:assetId` is a convenience for signed-in clients: it
 * checks access and redirects (302) to a signed URL. It never carries bytes.
 */
import { Hono } from "hono";
import { verifyMediaSignature } from "@rolling/core/media";
import type { AppEnv } from "../env";
import { membershipFor, matureAllowedIn, requireAuth } from "../lib/access";
import { errorResponse } from "../lib/errors";
import { mediaSigningKey, mediaUrlFor } from "../lib/mediaUrls";
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
  const maxAge = Math.max(0, result.exp - Math.floor(Date.now() / 1000));
  const res = await serveR2(c.env.MEDIA, key, c.req.raw, {
    cacheControl: `private, max-age=${Math.min(maxAge, 3600)}`,
    headers: { "x-content-type-options": "nosniff" },
  });
  return res ?? errorResponse(c, 404, "NOT_FOUND", "Not found");
});

export const privateMedia = new Hono<AppEnv>().get("/:assetId", async (c) => {
  const auth = await requireAuth(c);
  const row = await visibleAsset(c.env, auth, c.req.param("assetId"));
  if (!row || row.status === "uploading") return errorResponse(c, 404, "NOT_FOUND", "Not found");
  const m = membershipFor(auth, row.workspace_id);
  const signed = await mediaUrlFor(c.env, { key: row.r2_key, workspaceId: row.workspace_id, mature: row.mature === 1 }, { mayViewMature: m ? matureAllowedIn(auth, m) : auth.matureAllowed });
  if (!signed) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  return c.redirect(signed, 302);
});

/** `GET /api/share/:id` — public, signed out. */
export const share = new Hono<AppEnv>().get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^shr_[A-Za-z0-9]+$/.test(id)) return errorResponse(c, 404, "NOT_FOUND", "Share link not found");
  const doc = await readShare(c.env, id);
  if (!doc) return errorResponse(c, 404, "NOT_FOUND", "Share link not found");
  c.header("cache-control", "no-store");
  return c.json(doc);
});
