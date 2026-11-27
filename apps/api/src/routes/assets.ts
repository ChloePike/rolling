/**
 * Assets (M3): the catalog behind the `@` picker, characters and voices.
 * Uploads live in `./uploads.ts` (direct to R2, D-011).
 * Bytes are never served from here: responses carry signed media URLs (D-008).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { newId } from "@rolling/core/ids";
import { checkUpload, safeFilename, UPLOAD_LIMITS, UPLOAD_PART_SIZE } from "@rolling/core/media";
import { PLANS } from "@rolling/core/pricing/config";
import { roleAtLeast } from "@rolling/core/auth/roles";
import type { AppEnv } from "../env";
import { membershipFor, matureAllowedIn, requireAuth, requireEditor, type AuthContext } from "../lib/access";
import { ApiError } from "../lib/errors";
import { assetMeta, assetView, mediaUrlFor, type AssetRow } from "../lib/mediaUrls";
import { validate } from "../lib/validate";

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

export const ASSET_SCOPES = ["mine", "team", "builtin", "public", "all"] as const;
export type AssetScope = (typeof ASSET_SCOPES)[number];

export interface AssetQuery {
  scope: AssetScope;
  kind?: "image" | "video" | "audio" | "text" | null;
  q?: string | null;
  first: number;
  after?: string | null;
}

/** FTS5 query from user text: each word as a quoted prefix term. */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

function encodeCursor(r: Pick<AssetRow, "created_at" | "id">): string {
  return btoa(JSON.stringify([r.created_at, r.id]));
}

function decodeCursor(cursor: string | null | undefined): [number, string] | null {
  if (!cursor) return null;
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new ApiError(400, "BAD_REQUEST", "Invalid cursor");
}

/**
 * Catalog listing shared by REST and GraphQL. Scopes: `mine` (my uploads and
 * generations in the workspace), `team` (the whole workspace), `builtin`,
 * `public` (public library), `all` (workspace + builtin + public).
 * Mature assets, public-library ones included, are only listed for viewers
 * allowed to see them (D-005); their URLs are signed private media.
 */
export async function listAssets(env: Env, auth: AuthContext, query: AssetQuery) {
  const where: string[] = ["a.status IN ('ready','processing')"];
  const binds: unknown[] = [];
  const bind = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  switch (query.scope) {
    case "mine":
      where.push(`a.workspace_id = ${bind(auth.workspaceId)} AND a.created_by = ${bind(auth.userId)} AND a.source IN ('mine','team','generated')`);
      break;
    case "team":
      where.push(`a.workspace_id = ${bind(auth.workspaceId)} AND a.source IN ('mine','team','generated')`);
      break;
    case "builtin":
      where.push("a.source = 'builtin'");
      break;
    case "public":
      where.push("a.source = 'public'");
      break;
    case "all":
      where.push(`(a.workspace_id = ${bind(auth.workspaceId)} OR a.source IN ('builtin','public'))`);
      break;
  }
  // D-005: mature assets (and every angle of a mature public-library item) only for mature-allowed callers, whose
  // URLs are then signed from the private bucket (lib/mediaUrls). Everyone else gets exactly the non-mature set.
  if (!auth.matureAllowed) {
    where.push("a.mature = 0");
    where.push("NOT (a.source = 'public' AND EXISTS (SELECT 1 FROM public_items p WHERE p.asset_id = a.id AND p.mature = 1))");
  }
  if (query.kind) where.push(`a.kind = ${bind(query.kind)}`);
  const fts = query.q ? ftsQuery(query.q) : null;
  if (query.q && !fts) return { items: [], hasNextPage: false, endCursor: null };
  if (fts) where.push(`a.id IN (SELECT id FROM asset_search WHERE asset_search MATCH ${bind(fts)})`);
  const cur = decodeCursor(query.after);
  if (cur) where.push(`(a.created_at < ${bind(cur[0])} OR (a.created_at = ${bind(cur[0])} AND a.id < ${bind(cur[1])}))`);
  const rows = await env.DB.prepare(`SELECT a.* FROM assets a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ${bind(query.first + 1)}`)
    .bind(...binds)
    .all<AssetRow>();
  const page = rows.results.slice(0, query.first);
  const viewer = { mayViewMature: auth.matureAllowed };
  return {
    items: await Promise.all(page.map((r) => assetView(env, r, viewer))),
    hasNextPage: rows.results.length > query.first,
    endCursor: page.length ? encodeCursor(page.at(-1)!) : null,
  };
}

/** An asset the caller's current workspace owns (uploads, generations), else NOT_FOUND. */
async function ownAsset(c: Context<AppEnv>, auth: AuthContext, id: string): Promise<AssetRow> {
  const row = await c.env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(id).first<AssetRow>();
  const m = row ? membershipFor(auth, row.workspace_id) : null;
  if (!row || !m) throw new ApiError(404, "NOT_FOUND", "Asset not found", { assetId: id });
  return row;
}

/** An asset the caller may reference (own workspace, builtin or public); mature only when allowed. */
export async function visibleAsset(env: Env, auth: AuthContext, id: string): Promise<AssetRow | null> {
  const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(id).first<AssetRow>();
  if (!row) return null;
  const m = membershipFor(auth, row.workspace_id);
  if (row.workspace_id !== null && !m) return null;
  const allowed = m ? matureAllowedIn(auth, m) : auth.matureAllowed;
  if (row.mature === 1 && !allowed) return null;
  return row;
}


export const assets = new Hono<AppEnv>()
  .get(
    "/",
    validate(
      "query",
      z.object({
        scope: z.enum(ASSET_SCOPES).default("all"),
        kind: z.enum(["image", "video", "audio", "text"]).optional(),
        q: z.string().max(200).optional(),
        first: z.coerce.number().int().min(1).max(100).default(48),
        after: z.string().max(200).optional(),
      }),
    ),
    async (c) => {
      const auth = await requireAuth(c);
      const page = await listAssets(c.env, auth, c.req.valid("query"));
      return c.json({ items: page.items, nextCursor: page.hasNextPage ? page.endCursor : null });
    },
  )
  .get("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = await requireAuth(c);
    const row = await visibleAsset(c.env, auth, c.req.valid("param").id);
    if (!row || row.status === "uploading") throw new ApiError(404, "NOT_FOUND", "Asset not found");
    const m = membershipFor(auth, row.workspace_id);
    return c.json({ asset: await assetView(c.env, row, { mayViewMature: m ? matureAllowedIn(auth, m) : auth.matureAllowed }) });
  })
  .delete("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = await requireAuth(c);
    const row = await ownAsset(c, auth, c.req.valid("param").id);
    const m = membershipFor(auth, row.workspace_id)!;
    if (!roleAtLeast(m.role, "editor")) throw new ApiError(403, "FORBIDDEN", "Your role does not allow this");
    const meta = assetMeta(row);
    if (row.status === "uploading") {
      const up = await c.env.DB.prepare("SELECT upload_id FROM uploads WHERE asset_id = ? AND status = 'uploading'").bind(row.id).first<{ upload_id: string }>();
      if (up) await c.env.MEDIA.resumeMultipartUpload(row.r2_key, up.upload_id).abort().catch(() => undefined);
      await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE asset_id = ? AND status = 'uploading'").bind(row.id).run();
    }
    const keys = [row.r2_key, meta.thumbKey, meta.waveformKey].filter((k): k is string => typeof k === "string" && k.startsWith(`ws/${row.workspace_id}/`));
    await c.env.MEDIA.delete(keys);
    // Remix shot frames extracted from a video (runs/frames.ts).
    if (row.kind === "video" && row.workspace_id) {
      const frames = await c.env.MEDIA.list({ prefix: `ws/${row.workspace_id}/frames/${row.id}/`, limit: 1000 });
      if (frames.objects.length) await c.env.MEDIA.delete(frames.objects.map((o) => o.key));
    }
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM asset_search WHERE id = ?").bind(row.id), c.env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(row.id)]);
    return c.json({ ok: true });
  });

// ---------------------------------------------------------------- characters

interface CharacterRow {
  id: string;
  workspace_id: string;
  name: string;
  meta: string | null;
  cover_asset_id: string | null;
  versions: string;
  created_at: number;
  created_by: string | null;
}

async function characterView(env: Env, auth: AuthContext, r: CharacterRow) {
  let cover: string | null = null;
  if (r.cover_asset_id) {
    const a = await visibleAsset(env, auth, r.cover_asset_id);
    if (a) cover = (await assetView(env, a, { mayViewMature: auth.matureAllowed })).thumbUrl;
  }
  const parse = (s: string | null, fallback: unknown) => {
    try {
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return { id: r.id, name: r.name, meta: parse(r.meta, {}), coverAssetId: r.cover_asset_id, coverUrl: cover, versions: parse(r.versions, []), createdAt: r.created_at, createdBy: r.created_by };
}

export const characters = new Hono<AppEnv>()
  .get("/", async (c) => {
    const auth = await requireAuth(c);
    const rows = await c.env.DB.prepare("SELECT * FROM characters WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200").bind(auth.workspaceId).all<CharacterRow>();
    return c.json({ items: await Promise.all(rows.results.map((r) => characterView(c.env, auth, r))) });
  })
  .post(
    "/",
    validate("json", z.object({ name: z.string().trim().min(1).max(80), coverAssetId: Id.optional(), meta: z.record(z.unknown()).optional(), referenceAssetIds: z.array(Id).max(16).optional() })),
    async (c) => {
      const auth = await requireAuth(c);
      requireEditor(auth);
      const body = c.req.valid("json");
      for (const id of [body.coverAssetId, ...(body.referenceAssetIds ?? [])].filter((x): x is string => !!x)) {
        if (!(await visibleAsset(c.env, auth, id))) throw new ApiError(404, "NOT_FOUND", "Asset not found", { assetId: id });
      }
      if (JSON.stringify(body.meta ?? {}).length > 16_384) throw new ApiError(400, "VALIDATION_FAILED", "Character details are too large");
      const id = newId("character");
      const now = Date.now();
      const versions = [{ n: 1, assetIds: body.referenceAssetIds ?? (body.coverAssetId ? [body.coverAssetId] : []), createdAt: now }];
      await c.env.DB.prepare("INSERT INTO characters (id, workspace_id, name, meta, cover_asset_id, versions, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, auth.workspaceId, body.name, JSON.stringify(body.meta ?? {}), body.coverAssetId ?? null, JSON.stringify(versions), now, auth.userId)
        .run();
      const row = await c.env.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(id).first<CharacterRow>();
      return c.json({ character: await characterView(c.env, auth, row!) }, 201);
    },
  )
  .delete("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    const res = await c.env.DB.prepare("DELETE FROM characters WHERE id = ? AND workspace_id = ?").bind(c.req.valid("param").id, auth.workspaceId).run();
    if (!res.meta.changes) throw new ApiError(404, "NOT_FOUND", "Character not found");
    return c.json({ ok: true });
  });

// ---------------------------------------------------------------- voices

interface VoiceRow {
  id: string;
  workspace_id: string | null;
  name: string;
  language: string | null;
  kind: "builtin" | "cloned";
  status: string;
  provider_ref: string | null;
  sample_asset_id: string | null;
}

async function voiceView(env: Env, auth: AuthContext, r: VoiceRow) {
  let sampleUrl: string | null = null;
  if (r.sample_asset_id) {
    const a = await visibleAsset(env, auth, r.sample_asset_id);
    if (a) sampleUrl = await mediaUrlFor(env, { key: a.r2_key, workspaceId: a.workspace_id, mature: a.mature === 1 }, { mayViewMature: auth.matureAllowed });
  }
  return { id: r.id, name: r.name, language: r.language, kind: r.kind, status: r.status, sampleAssetId: r.sample_asset_id, sampleUrl };
}

const CloneVoice = z.object({ name: z.string().trim().min(1).max(80), language: z.string().min(2).max(16).optional(), sampleAssetId: Id });

/**
 * Voice clone request. The voice provider is an open decision (CLAUDE.md), so
 * the voice is stored as `pending` until a provider is wired. Needs a plan
 * with voice cloning (D-006: Plus and Pro).
 */
async function cloneVoice(c: Context<AppEnv>) {
  const auth = await requireAuth(c);
  requireEditor(auth);
  if (!auth.plan) throw new ApiError(402, "NO_PLAN", "An active plan is required", { workspaceId: auth.workspaceId });
  if (!PLANS[auth.plan].voiceCloning) throw new ApiError(403, "FORBIDDEN", "Voice cloning needs the Plus or Pro plan", { reason: "PLAN_FEATURE", requiredPlan: "plus" });
  const parsed = CloneVoice.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", "Request validation failed", { issues: parsed.error.issues });
  const body = parsed.data;
  const sample = await visibleAsset(c.env, auth, body.sampleAssetId);
  if (!sample || sample.kind !== "audio" || sample.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Audio sample not found");
  const id = newId("voice");
  await c.env.DB.prepare("INSERT INTO voices (id, workspace_id, name, language, kind, status, provider_ref, sample_asset_id) VALUES (?, ?, ?, ?, 'cloned', 'pending', NULL, ?)")
    .bind(id, auth.workspaceId, body.name, body.language ?? null, body.sampleAssetId)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM voices WHERE id = ?").bind(id).first<VoiceRow>();
  return c.json({ voice: await voiceView(c.env, auth, row!) }, 202);
}

export const voices = new Hono<AppEnv>()
  .get("/", async (c) => {
    const auth = await requireAuth(c);
    const rows = await c.env.DB.prepare("SELECT * FROM voices WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY kind, name LIMIT 500").bind(auth.workspaceId).all<VoiceRow>();
    return c.json({ items: await Promise.all(rows.results.map((r) => voiceView(c.env, auth, r))) });
  })
  .post("/", cloneVoice)
  .post("/clone", cloneVoice)
  .delete("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    const res = await c.env.DB.prepare("DELETE FROM voices WHERE id = ? AND workspace_id = ? AND kind = 'cloned'").bind(c.req.valid("param").id, auth.workspaceId).run();
    if (!res.meta.changes) throw new ApiError(404, "NOT_FOUND", "Voice not found");
    return c.json({ ok: true });
  });
