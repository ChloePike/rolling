/**
 * Public profiles: name, handle, bio and avatar (`PATCH /api/me/profile`),
 * the public read (`GET /api/profiles/:handle`) and the avatar redirect
 * (`GET /api/media/avatar/:userId`).
 *
 * D-005: profiles are public surfaces. Avatars must be rated `safe` (rated at
 * set time with `rateAsset`; suggestive and explicit images are refused).
 * Published works are the covers of the user's share links marked
 * `show_on_profile`, re-checked at read time: only `safe`, non-mature covers
 * are listed. D-008: the avatar route never carries bytes; it redirects to a
 * short-lived signed URL of the derived avatar image.
 */
import { isPublicRating, isReservedHandle, type ProfilePatch } from "@rolling/core/auth/profile";
import { ApiError } from "../lib/errors";
import { assetMeta, mediaUrlFor, signMediaUrl, type AssetRow } from "../lib/mediaUrls";
import { rateAsset } from "../safety/service";
import type { AuthContext } from "./context";
import { personalWorkspaceId } from "./workspace";

/** Avatar edge size (square, WebP). */
export const AVATAR_SIZE = 256;
export const AVATAR_URL_TTL_SECONDS = 3600;
const PROFILE_MEDIA_TTL_SECONDS = 3600;
const MAX_WORKS = 60;

export interface ProfileRow {
  handle: string | null;
  bio: string | null;
  avatar_key: string | null;
  avatar_asset_id: string | null;
}

export async function readProfileRow(env: Env, userId: string): Promise<ProfileRow | null> {
  return env.DB.prepare("SELECT handle, bio, avatar_key, avatar_asset_id FROM user_prefs WHERE user_id = ?").bind(userId).first<ProfileRow>();
}

/** Stable, public-safe avatar URL stored in `users.image` (the version busts caches after a change). */
export function avatarPath(userId: string, version: string): string {
  return `/api/media/avatar/${encodeURIComponent(userId)}?v=${encodeURIComponent(version)}`;
}

function isHandleConflict(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(err));
}

async function handleTaken(env: Env, handle: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT user_id FROM user_prefs WHERE lower(handle) = ?1 AND user_id <> ?2 LIMIT 1").bind(handle, userId).first();
  return !!row;
}

/**
 * Derives the avatar from the caller's image asset: checks ownership, rates it
 * (D-005; anything but `safe` is refused), stores a 256 px WebP (original
 * bytes when the Images binding is unavailable) under the user's personal
 * workspace and returns its key.
 */
async function deriveAvatar(env: Env, auth: AuthContext, assetId: string): Promise<{ key: string }> {
  const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId).first<AssetRow & { rating: string | null }>();
  const own = row && row.created_by === auth.userId && row.workspace_id !== null && auth.memberships.some((m) => m.workspaceId === row.workspace_id);
  if (!row || !own) throw new ApiError(404, "NOT_FOUND", "Image not found", { assetId });
  if (row.kind !== "image") throw new ApiError(400, "VALIDATION_FAILED", "The avatar must be an image", { field: "avatarAssetId", reason: "NOT_IMAGE" });
  if (row.status === "uploading") throw new ApiError(409, "CONFLICT", "The upload is not finished yet", { status: row.status });
  if (row.status === "failed") throw new ApiError(422, "AVATAR_REJECTED", "This image can't be used as a profile photo", { reason: "blocked" });
  let rating = row.rating;
  if (!rating) {
    let out: { rating: string | null; blocked: boolean };
    try {
      out = await rateAsset(env, assetId);
    } catch (err) {
      console.error(JSON.stringify({ msg: "avatar: rating failed", assetId, error: String(err).slice(0, 200) }));
      out = { rating: null, blocked: false };
    }
    if (out.blocked) throw new ApiError(422, "AVATAR_REJECTED", "This image can't be used as a profile photo", { reason: "blocked" });
    rating = out.rating;
  }
  if (!rating) throw new ApiError(503, "SAFETY_UNAVAILABLE", "We couldn't check this image right now. Try again in a minute.");
  const fresh = await env.DB.prepare("SELECT mature, status FROM assets WHERE id = ?").bind(assetId).first<{ mature: number; status: string }>();
  if (!isPublicRating(rating, fresh?.mature ?? row.mature) || fresh?.status === "failed") {
    throw new ApiError(422, "AVATAR_REJECTED", "Profile photos are public, so they can't show mature content", { reason: "rating", rating });
  }

  const obj = await env.MEDIA.get(row.r2_key);
  if (!obj) throw new ApiError(404, "NOT_FOUND", "Image not found", { assetId });
  const bytes = await obj.arrayBuffer();
  const base = `ws/${personalWorkspaceId(auth.userId)}/avatars/${assetId}`;
  try {
    const out = await env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover" })
      .output({ format: "image/webp", quality: 85 });
    const webp = await out.response().arrayBuffer();
    if (webp.byteLength === 0) throw new Error("empty output");
    const key = `${base}.webp`;
    await env.MEDIA.put(key, webp, { httpMetadata: { contentType: "image/webp" } });
    return { key };
  } catch {
    // Images binding unavailable (tests, local): keep the original bytes.
    const ext = (row.content_type ?? obj.httpMetadata?.contentType ?? "image/png").split("/")[1]?.replace(/[^a-z0-9]/g, "") || "img";
    const key = `${base}.${ext}`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: row.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream" } });
    return { key };
  }
}

export interface ProfileView {
  name: string;
  handle: string | null;
  bio: string | null;
  image: string | null;
}

/** Applies a profile patch; returns the new profile. HANDLE_TAKEN (409) for taken or reserved handles. */
export async function updateProfile(env: Env, auth: AuthContext, patch: ProfilePatch): Promise<ProfileView> {
  if (!auth.user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  const now = Date.now();
  const current = await readProfileRow(env, auth.userId);
  if (patch.handle !== undefined && patch.handle !== current?.handle) {
    if (isReservedHandle(patch.handle) || (await handleTaken(env, patch.handle, auth.userId))) {
      throw new ApiError(409, "HANDLE_TAKEN", "That username is taken", { handle: patch.handle });
    }
  }
  let image = auth.user.image;
  let avatar: { key: string | null; assetId: string | null } | null = null;
  if (patch.avatarAssetId !== undefined) {
    if (patch.avatarAssetId === null) {
      avatar = { key: null, assetId: null };
      image = null;
    } else {
      const { key } = await deriveAvatar(env, auth, patch.avatarAssetId);
      avatar = { key, assetId: patch.avatarAssetId };
      image = avatarPath(auth.userId, `${patch.avatarAssetId.slice(-8)}${now.toString(36)}`);
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.handle !== undefined) (sets.push("handle = ?"), binds.push(patch.handle));
  if (patch.bio !== undefined) (sets.push("bio = ?"), binds.push(patch.bio));
  if (avatar) (sets.push("avatar_key = ?", "avatar_asset_id = ?"), binds.push(avatar.key, avatar.assetId));
  const statements: D1PreparedStatement[] = [];
  if (sets.length) {
    statements.push(env.DB.prepare(`UPDATE user_prefs SET ${sets.join(", ")}, updated_at = ? WHERE user_id = ?`).bind(...binds, now, auth.userId));
  }
  const userSets: string[] = [];
  const userBinds: unknown[] = [];
  if (patch.name !== undefined) (userSets.push("name = ?"), userBinds.push(patch.name));
  if (avatar) (userSets.push("image = ?"), userBinds.push(image));
  if (userSets.length) {
    statements.push(env.DB.prepare(`UPDATE users SET ${userSets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...userBinds, new Date(now).toISOString(), auth.userId));
  }
  try {
    if (statements.length) await env.DB.batch(statements);
  } catch (err) {
    if (isHandleConflict(err)) throw new ApiError(409, "HANDLE_TAKEN", "That username is taken", { handle: patch.handle });
    throw err;
  }
  // The previous avatar object is no longer referenced.
  if (avatar && current?.avatar_key && current.avatar_key !== avatar.key) await env.MEDIA.delete(current.avatar_key).catch(() => undefined);
  return {
    name: patch.name ?? auth.user.name,
    handle: patch.handle !== undefined ? patch.handle : (current?.handle ?? null),
    bio: patch.bio !== undefined ? patch.bio : (current?.bio ?? null),
    image,
  };
}

/** Signed URL of the user's avatar, or null when none is set (or its source has been marked mature since). */
export async function avatarUrl(env: Env, userId: string): Promise<string | null> {
  const row = await readProfileRow(env, userId);
  if (!row?.avatar_key) return null;
  if (row.avatar_asset_id) {
    const src = await env.DB.prepare("SELECT mature, rating FROM assets WHERE id = ?").bind(row.avatar_asset_id).first<{ mature: number; rating: string | null }>();
    if (src && !isPublicRating(src.rating, src.mature)) return null;
  }
  return signMediaUrl(env, row.avatar_key, { workspaceId: personalWorkspaceId(userId), expiresIn: AVATAR_URL_TTL_SECONDS });
}

export interface PublicWork {
  shareId: string;
  title: string;
  url: string;
  coverUrl: string | null;
  kind: "image" | "video";
  durationSec: number | null;
  createdAt: number;
}

export interface PublicTemplate {
  id: string;
  title: string;
  category: string | null;
  coverUrl: string | null;
  uses: number;
}

export interface PublicProfile {
  userId: string;
  name: string;
  handle: string;
  bio: string | null;
  avatarUrl: string | null;
  works: PublicWork[];
  templates: PublicTemplate[];
}

type CoverRow = Pick<AssetRow, "id" | "kind" | "r2_key" | "meta" | "workspace_id" | "mature" | "status"> & { rating: string | null };

async function coverUrlOf(env: Env, a: CoverRow | undefined): Promise<{ url: string | null; kind: "image" | "video"; durationSec: number | null } | null> {
  // D-005: only safe, non-mature, ready covers on a public surface.
  if (!a || a.status !== "ready" || !isPublicRating(a.rating, a.mature) || (a.kind !== "image" && a.kind !== "video")) return null;
  const meta = assetMeta(a);
  const key = typeof meta.thumbKey === "string" ? meta.thumbKey : a.kind === "image" ? a.r2_key : null;
  const url = key ? await mediaUrlFor(env, { key, workspaceId: a.workspace_id, mature: false }, { mayViewMature: false }, PROFILE_MEDIA_TTL_SECONDS) : null;
  return { url, kind: a.kind, durationSec: typeof meta.durationSec === "number" ? Math.round(meta.durationSec) : null };
}

/** The public profile for `handle` (case-insensitive), or null. */
export async function publicProfile(env: Env, handle: string): Promise<PublicProfile | null> {
  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.image, p.handle, p.bio FROM user_prefs p JOIN users u ON u.id = p.user_id WHERE lower(p.handle) = ?1 LIMIT 1`,
  )
    .bind(handle.toLowerCase())
    .first<{ id: string; name: string; image: string | null; handle: string; bio: string | null }>();
  if (!user) return null;
  const [links, tpls] = await env.DB.batch<unknown>([
    env.DB.prepare(
      `SELECT s.id, s.cover_asset_id, s.created_at, p.title FROM share_links s JOIN projects p ON p.id = s.project_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.created_by = ?1 AND s.show_on_profile = 1 AND s.revoked_at IS NULL AND w.deleted_at IS NULL
       ORDER BY s.created_at DESC LIMIT ?2`,
    ).bind(user.id, MAX_WORKS),
    // Global templates (workspace_id NULL) are the public ones; workspace templates stay private.
    env.DB.prepare("SELECT id, title, category, preview_asset_id, uses FROM templates WHERE created_by = ?1 AND workspace_id IS NULL ORDER BY uses DESC LIMIT ?2").bind(
      user.id,
      MAX_WORKS,
    ),
  ]);
  const linkRows = (links?.results ?? []) as { id: string; cover_asset_id: string | null; created_at: number; title: string }[];
  const tplRows = (tpls?.results ?? []) as { id: string; title: string; category: string | null; preview_asset_id: string | null; uses: number }[];
  const ids = [...new Set([...linkRows.map((l) => l.cover_asset_id), ...tplRows.map((t) => t.preview_asset_id)].filter((x): x is string => !!x))];
  const covers = new Map<string, CoverRow>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await env.DB.prepare(`SELECT id, kind, r2_key, meta, workspace_id, mature, status, rating FROM assets WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<CoverRow>();
    for (const r of res.results) covers.set(r.id, r);
  }
  const appBase = (env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const works: PublicWork[] = [];
  for (const l of linkRows) {
    // A published work without a public-safe cover is not listed (D-005).
    const cover = await coverUrlOf(env, l.cover_asset_id ? covers.get(l.cover_asset_id) : undefined);
    if (!cover) continue;
    works.push({ shareId: l.id, title: l.title, url: `${appBase}/share/${l.id}`, coverUrl: cover.url, kind: cover.kind, durationSec: cover.durationSec, createdAt: l.created_at });
  }
  const templates: PublicTemplate[] = [];
  for (const t of tplRows) {
    const cover = t.preview_asset_id ? await coverUrlOf(env, covers.get(t.preview_asset_id)) : null;
    // A template whose preview is not public-safe is not listed (no blank stand-in for a mature cover).
    if (t.preview_asset_id && !cover) continue;
    templates.push({ id: t.id, title: t.title, category: t.category, coverUrl: cover?.url ?? null, uses: t.uses });
  }
  return {
    userId: user.id,
    name: user.name,
    handle: user.handle,
    bio: user.bio,
    // Our avatars are the safe-rated redirect route; a provider photo (Google/Apple) is passed through.
    avatarUrl: user.image,
    works,
    templates,
  };
}
