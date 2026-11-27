/**
 * Resumable, chunked uploads straight from the browser to R2 (D-011).
 *
 * The Worker never carries upload bytes: it opens the multipart upload (R2
 * binding), hands out presigned S3 `UploadPart` URLs, reads progress with S3
 * `ListParts`, and completes or aborts through the binding. An unexpired
 * upload with the same `fingerprint` (same user and workspace) is resumed
 * instead of starting over. Uploads expire after 7 days (R2's limit); the
 * cron aborts them (`cleanupExpiredUploads`).
 *
 * Development fallback (only `ENVIRONMENT=development` without S3 credentials):
 * part URLs point at `PUT /api/assets/uploads/:assetId/parts/:n`, a Worker
 * proxy that records parts in D1 `upload_parts`. Never used in staging/production.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { newId } from "@rolling/core/ids";
import { checkUpload, partSizeOf, safeFilename, UPLOAD_LIMITS, UPLOAD_PART_SIZE, UPLOAD_TTL_MS } from "@rolling/core/media";
import type { AppEnv } from "../env";
import { limitOrThrow } from "../auth/rateLimit";
import { requireAuth, requireEditor, type AuthContext } from "../lib/access";
import { ApiError } from "../lib/errors";
import { assetMeta, assetView, type AssetRow } from "../lib/mediaUrls";
import { listParts, presignUploadPart, s3Config, S3Error, PART_URL_TTL_SECONDS, type ListedPart, type S3Config } from "../lib/r2s3";
import { validate } from "../lib/validate";

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

export interface UploadRow {
  asset_id: string;
  workspace_id: string;
  user_id: string;
  fingerprint: string | null;
  upload_id: string;
  r2_key: string;
  size: number;
  part_size: number;
  part_count: number;
  content_type: string;
  status: "uploading" | "complete" | "aborted" | "expired";
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

type Mode = { kind: "s3"; cfg: S3Config } | { kind: "proxy" };

/** S3 when credentials are set; the Worker proxy only in development; otherwise uploads are unavailable. */
function uploadMode(env: Env): Mode {
  const cfg = s3Config(env);
  if (cfg) return { kind: "s3", cfg };
  if (env.ENVIRONMENT === "development") return { kind: "proxy" };
  throw new ApiError(503, "INTERNAL", "Uploads are not configured", { missing: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET_NAME"] });
}

/** Test hook: the fetch used for S3 `ListParts` (default: global fetch). */
export const s3Fetch: { fn: typeof fetch } = { fn: (input, init) => fetch(input, init) };

async function receivedParts(env: Env, row: UploadRow): Promise<ListedPart[]> {
  const mode = uploadMode(env);
  if (mode.kind === "s3") {
    try {
      return await listParts(mode.cfg, row.r2_key, row.upload_id, s3Fetch.fn);
    } catch (err) {
      if (err instanceof S3Error && err.code === "NoSuchUpload") return [];
      throw new ApiError(502, "INTERNAL", "Could not read upload progress", { reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const rows = await env.DB.prepare("SELECT n, size, etag FROM upload_parts WHERE asset_id = ? ORDER BY n").bind(row.asset_id).all<ListedPart>();
  return rows.results;
}

/** Marks an upload expired (and aborts it) once its 7 days are over. */
async function expireIfDue(env: Env, row: UploadRow): Promise<UploadRow> {
  if (row.status !== "uploading" || row.expires_at > Date.now()) return row;
  await abortUpload(env, row, "expired");
  return { ...row, status: "expired" };
}

async function abortUpload(env: Env, row: UploadRow, status: "aborted" | "expired"): Promise<void> {
  await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id)
    .abort()
    .catch(() => undefined);
  await env.DB.batch([
    env.DB.prepare("UPDATE uploads SET status = ? WHERE asset_id = ? AND status = 'uploading'").bind(status, row.asset_id),
    env.DB.prepare("DELETE FROM upload_parts WHERE asset_id = ?").bind(row.asset_id),
    env.DB.prepare("DELETE FROM assets WHERE id = ? AND status = 'uploading'").bind(row.asset_id),
  ]);
}

/** Cron: aborts uploads past their expiry. Returns how many were cleaned. */
export async function cleanupExpiredUploads(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare("SELECT * FROM uploads WHERE status = 'uploading' AND expires_at <= ? LIMIT 200").bind(now).all<UploadRow>();
  for (const row of rows.results) await abortUpload(env, row, "expired");
  return rows.results.length;
}

/** The caller's own upload in a workspace they belong to, else NOT_FOUND. */
async function ownUpload(c: Context<AppEnv>, auth: AuthContext, assetId: string): Promise<UploadRow> {
  const row = await c.env.DB.prepare("SELECT * FROM uploads WHERE asset_id = ?").bind(assetId).first<UploadRow>();
  if (!row || row.user_id !== auth.userId || !auth.memberships.some((m) => m.workspaceId === row.workspace_id)) {
    throw new ApiError(404, "NOT_FOUND", "Upload not found", { assetId });
  }
  return expireIfDue(c.env, row);
}

function requireOpen(row: UploadRow): void {
  if (row.status !== "uploading") throw new ApiError(409, "CONFLICT", `This upload is ${row.status}`, { status: row.status });
}

function partsView(parts: ListedPart[]) {
  return parts.map((p) => ({ n: p.n, size: p.size, etag: p.etag }));
}

async function uploadView(env: Env, row: UploadRow, parts?: ListedPart[]) {
  const received = parts ?? (row.status === "uploading" ? await receivedParts(env, row) : []);
  return {
    assetId: row.asset_id,
    key: row.r2_key,
    uploadId: row.upload_id,
    status: row.status,
    size: row.size,
    partSize: row.part_size,
    partCount: row.part_count,
    parts: partsView(received),
    expiresAt: row.expires_at,
  };
}

const CreateUpload = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
  fingerprint: z.string().min(8).max(128).regex(/^[A-Za-z0-9_+/=:.-]+$/).optional(),
  projectId: Id.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  /** Audio/video: the length the browser reported (e.g. `HTMLMediaElement.duration`). Used by quotes until probing replaces it. */
  durationMs: z.number().int().positive().max(6 * 3600 * 1000).optional(),
  /** Audio: the uploader confirmed “I have the rights to use this voice” (D-037; required for lip-sync). */
  voiceRights: z.literal(true).optional(),
});

/** Checks every part against the declared size; returns the problem or null. */
export function partProblem(row: Pick<UploadRow, "size" | "part_size" | "part_count">, parts: ListedPart[]): { reason: string; missing?: number[]; n?: number; expected?: number; got?: number } | null {
  const byN = new Map(parts.map((p) => [p.n, p]));
  const missing: number[] = [];
  for (let n = 1; n <= row.part_count; n++) if (!byN.has(n)) missing.push(n);
  if (missing.length) return { reason: "MISSING_PARTS", missing: missing.slice(0, 100) };
  const extra = parts.find((p) => p.n > row.part_count);
  if (extra) return { reason: "EXTRA_PART", n: extra.n };
  for (const p of parts) {
    const expected = partSizeOf(row.size, p.n, row.part_size);
    if (p.size !== expected) return { reason: "PART_SIZE", n: p.n, expected, got: p.size };
  }
  return null;
}

export const uploads = new Hono<AppEnv>()
  /** Starts (or resumes, by fingerprint) an upload. */
  .post("/", validate("json", CreateUpload), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    await limitOrThrow(c.env.RATE_LIMIT, `upload:${auth.userId}`);
    const body = c.req.valid("json");
    const check = checkUpload(body.contentType, body.size);
    if (!check.ok) {
      const limits = Object.fromEntries(Object.entries(UPLOAD_LIMITS).map(([k, v]) => [k, { maxBytes: v.maxBytes, types: v.types }]));
      throw new ApiError(check.reason === "TOO_LARGE" ? 413 : 415, "VALIDATION_FAILED", check.reason === "TOO_LARGE" ? "File is too large" : "File type is not supported", {
        reason: check.reason,
        ...(check.maxBytes ? { maxBytes: check.maxBytes } : {}),
        limits,
      });
    }
    uploadMode(c.env);
    if (body.fingerprint) {
      const existing = await c.env.DB.prepare(
        "SELECT * FROM uploads WHERE workspace_id = ? AND user_id = ? AND fingerprint = ? AND status = 'uploading' AND size = ? AND content_type = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(auth.workspaceId, auth.userId, body.fingerprint, body.size, body.contentType)
        .first<UploadRow>();
      if (existing) {
        const row = await expireIfDue(c.env, existing);
        if (row.status === "uploading") return c.json({ ...(await uploadView(c.env, row)), resumed: true });
      }
    }
    if (body.projectId) {
      const p = await c.env.DB.prepare("SELECT workspace_id FROM projects WHERE id = ?").bind(body.projectId).first<{ workspace_id: string }>();
      if (!p || p.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Project not found");
    }
    const assetId = newId("asset");
    const filename = safeFilename(body.filename);
    const key = `ws/${auth.workspaceId}/uploads/${assetId}/${filename}`;
    const upload = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType }, customMetadata: { assetId, workspaceId: auth.workspaceId } });
    const now = Date.now();
    const source = auth.workspace.kind === "team" ? "team" : "mine";
    const declared =
      body.durationMs !== undefined && (check.kind === "video" || check.kind === "audio")
        ? { durationSec: body.durationMs / 1000, durationSource: "declared", declaredDurationSec: body.durationMs / 1000 }
        : {};
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, license, project_id, created_by, created_at, status, mature, size, content_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'uploading', 0, ?, ?)`,
      ).bind(assetId, auth.workspaceId, check.kind, source, body.name ?? body.filename.slice(0, 200), key, JSON.stringify({ filename, ...declared, ...(body.voiceRights && check.kind === "audio" && { voiceRights: { by: auth.userId, at: now } }) }), body.projectId ?? null, auth.userId, now, body.size, body.contentType),
      c.env.DB.prepare(
        `INSERT INTO uploads (asset_id, workspace_id, user_id, fingerprint, upload_id, r2_key, size, part_size, part_count, content_type, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      ).bind(assetId, auth.workspaceId, auth.userId, body.fingerprint ?? null, upload.uploadId, key, body.size, UPLOAD_PART_SIZE, check.parts, body.contentType, now, now + UPLOAD_TTL_MS),
    ]);
    const row = (await c.env.DB.prepare("SELECT * FROM uploads WHERE asset_id = ?").bind(assetId).first<UploadRow>())!;
    return c.json({ ...(await uploadView(c.env, row, [])), kind: check.kind, resumed: false }, 201);
  })
  /** Progress for resuming: the parts R2 already has. */
  .get("/:assetId", validate("param", z.object({ assetId: Id })), async (c) => {
    const auth = await requireAuth(c);
    const row = await ownUpload(c, auth, c.req.valid("param").assetId);
    return c.json(await uploadView(c.env, row));
  })
  /** Presigned `PUT` URLs (1 h) for the given part numbers. */
  .post(
    "/:assetId/part-urls",
    validate("param", z.object({ assetId: Id })),
    validate("json", z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100) })),
    async (c) => {
      const auth = await requireAuth(c);
      await limitOrThrow(c.env.RATE_LIMIT, `upload-parts:${auth.userId}`);
      const row = await ownUpload(c, auth, c.req.valid("param").assetId);
      requireOpen(row);
      const numbers = [...new Set(c.req.valid("json").partNumbers)].sort((a, b) => a - b);
      const bad = numbers.find((n) => n > row.part_count);
      if (bad) throw new ApiError(400, "VALIDATION_FAILED", "Part number is out of range", { n: bad, partCount: row.part_count });
      const mode = uploadMode(c.env);
      const expiresAt = Date.now() + PART_URL_TTL_SECONDS * 1000;
      const urls = await Promise.all(
        numbers.map(async (n) => ({
          n,
          size: partSizeOf(row.size, n, row.part_size),
          method: "PUT" as const,
          url: mode.kind === "s3" ? await presignUploadPart(mode.cfg, row.r2_key, row.upload_id, n) : `/api/assets/uploads/${row.asset_id}/parts/${n}`,
          expiresAt,
        })),
      );
      return c.json({ assetId: row.asset_id, direct: mode.kind === "s3", urls });
    },
  )
  /**
   * DEVELOPMENT FALLBACK ONLY: Worker proxy for one part when R2 S3 credentials
   * are absent. Idempotent (re-sending a part replaces it). 404 everywhere else.
   */
  .put("/:assetId/parts/:n", validate("param", z.object({ assetId: Id, n: z.coerce.number().int().min(1).max(10000) })), async (c) => {
    if (uploadMode(c.env).kind !== "proxy") throw new ApiError(404, "NOT_FOUND", "Parts go directly to storage; request part URLs");
    const auth = await requireAuth(c);
    const { assetId, n } = c.req.valid("param");
    const row = await ownUpload(c, auth, assetId);
    requireOpen(row);
    if (n > row.part_count) throw new ApiError(400, "VALIDATION_FAILED", "Part number is out of range", { partCount: row.part_count });
    const expected = partSizeOf(row.size, n, row.part_size);
    const length = Number(c.req.header("content-length") ?? NaN);
    if (length !== expected) throw new ApiError(400, "VALIDATION_FAILED", "Part has the wrong size", { expected, got: Number.isFinite(length) ? length : null });
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "BAD_REQUEST", "Part body is empty");
    const part = await c.env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(n, body);
    await c.env.DB.prepare(
      "INSERT INTO upload_parts (asset_id, n, size, etag, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(asset_id, n) DO UPDATE SET size = excluded.size, etag = excluded.etag, updated_at = excluded.updated_at",
    )
      .bind(assetId, n, expected, part.etag, Date.now())
      .run();
    return c.json({ n, etag: part.etag, size: expected });
  })
  /** Completes from the server's own view of the parts (ListParts), then queues `media.process`. Idempotent. */
  .post("/:assetId/complete", validate("param", z.object({ assetId: Id })), async (c) => {
    const auth = await requireAuth(c);
    const row = await ownUpload(c, auth, c.req.valid("param").assetId);
    const assetRow = async () => (await c.env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(row.asset_id).first<AssetRow>())!;
    if (row.status === "complete") return c.json({ asset: await assetView(c.env, await assetRow(), { mayViewMature: auth.matureAllowed }) });
    requireOpen(row);
    const parts = await receivedParts(c.env, row);
    const problem = partProblem(row, parts);
    if (problem) throw new ApiError(400, "VALIDATION_FAILED", "The upload is not complete", problem);
    let size: number;
    try {
      size = (await c.env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).complete(parts.map((p) => ({ partNumber: p.n, etag: p.etag })))).size;
    } catch (err) {
      throw new ApiError(400, "VALIDATION_FAILED", "Upload could not be completed", { reason: err instanceof Error ? err.message : String(err) });
    }
    if (size !== row.size) {
      await c.env.MEDIA.delete(row.r2_key);
      await abortUpload(c.env, row, "aborted");
      throw new ApiError(400, "VALIDATION_FAILED", "Uploaded size does not match", { expected: row.size, got: size });
    }
    const asset = await assetRow();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE uploads SET status = 'complete', completed_at = ? WHERE asset_id = ?").bind(now, row.asset_id),
      c.env.DB.prepare("DELETE FROM upload_parts WHERE asset_id = ?").bind(row.asset_id),
      c.env.DB.prepare("UPDATE assets SET status = 'processing', meta = ? WHERE id = ?").bind(JSON.stringify({ ...assetMeta(asset), processing: "queued" }), row.asset_id),
      c.env.DB.prepare("DELETE FROM asset_search WHERE id = ?").bind(row.asset_id),
      c.env.DB.prepare("INSERT INTO asset_search (id, name, tags) VALUES (?, ?, ?)").bind(
        row.asset_id,
        asset.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_.]+/g, " "),
        [asset.kind, asset.source].join(" "),
      ),
    ]);
    await c.env.MEDIA_PROCESS_QUEUE.send({ assetId: row.asset_id, r2Key: row.r2_key, kind: asset.kind });
    return c.json({ asset: await assetView(c.env, await assetRow(), { mayViewMature: auth.matureAllowed }) });
  })
  /** Aborts an open upload and cleans up. */
  .delete("/:assetId", validate("param", z.object({ assetId: Id })), async (c) => {
    const auth = await requireAuth(c);
    const row = await ownUpload(c, auth, c.req.valid("param").assetId);
    if (row.status === "uploading") await abortUpload(c.env, row, "aborted");
    return c.json({ ok: true, status: row.status === "uploading" ? "aborted" : row.status });
  });
