/**
 * Post-production jobs (D-033, D-034) in D1 `post_jobs`, one PostWorkflow
 * instance each (instance id = job id):
 * - `captions`: the timeline's audio (whole mix, voice lane or one clip) →
 *   mono 16 kHz MP3 chunks from the FFmpeg container → Workers AI Whisper per
 *   chunk → timed cues on the caption track (language detected, style kept);
 * - `transcript`: the same without touching the timeline (an imported
 *   voiceover's transcript for the agent, D-037);
 * - `resize`: Lanczos scaling plus a mild sharpen of a video or image version
 *   (honestly not AI upscaling: the catalog has no upscale model), saved as a
 *   new asset and, for a canvas node, as its new version.
 * Captions are free with a daily cap (pricing config `POST_PRODUCTION`).
 */
import { captionSourceEdl, type CaptionSource } from "@rolling/core/post";
import { cropEdl, type CaptionStyleId, type Edl } from "@rolling/core/timeline";
import { POST_PRODUCTION, RESIZE_TARGETS, planAllowsResize, lowestPlanFor, type PlanId, type ResizeTarget } from "@rolling/core/pricing/config";
import { newId } from "@rolling/core/ids";
import type { RoomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { signMediaUrl } from "../lib/mediaUrls";
import { readTimeline } from "./timeline";

export type PostJobKind = "captions" | "transcript" | "resize";
export type PostJobStatus = "queued" | "running" | "done" | "failed";

export interface PostJobRow {
  id: string;
  kind: PostJobKind;
  workspace_id: string;
  project_id: string | null;
  canvas_id: string | null;
  asset_id: string | null;
  status: PostJobStatus;
  progress: number;
  params: string;
  result: string | null;
  audio_seconds: number;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  finished_at: number | null;
}

export interface CaptionParams {
  source: CaptionSource;
  range: { start: number; end: number };
  style?: CaptionStyleId;
  /** Requested language, or null to detect. */
  language: string | null;
  replace: boolean;
  /** One audio asset (a voice clip): its transcript is also kept on the asset. */
  transcriptAssetId?: string;
}

export interface ResizeParams {
  target: ResizeTarget;
  media: "video" | "image";
  short: 1080 | 2160;
  projectId?: string;
  nodeId?: string;
  durationSec?: number;
}

export const postJobDir = (row: Pick<PostJobRow, "workspace_id" | "id">) => `ws/${row.workspace_id}/post/${row.id}`;

/** Chunk length of the transcription audio (each chunk is one Whisper call). */
export const CAPTION_CHUNK_SECONDS = 240;

export async function loadPostJob(env: Env, id: string): Promise<PostJobRow | null> {
  return env.DB.prepare("SELECT * FROM post_jobs WHERE id = ?").bind(id).first<PostJobRow>();
}

export async function setPostJob(env: Env, id: string, fields: Partial<Pick<PostJobRow, "status" | "progress" | "result" | "error_code" | "error_message" | "finished_at">>): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE post_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => fields[k] ?? null), id).run();
}

export function postJobView(row: PostJobRow) {
  let result: unknown = null;
  try {
    result = row.result ? JSON.parse(row.result) : null;
  } catch {
    result = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    assetId: row.asset_id,
    result,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

async function insert(env: Env, row: PostJobRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO post_jobs (id, kind, workspace_id, project_id, canvas_id, asset_id, status, progress, params, audio_seconds, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.kind, row.workspace_id, row.project_id, row.canvas_id, row.asset_id, row.params, row.audio_seconds, row.created_by, row.created_at)
    .run();
  await env.POST.create({ id: row.id, params: { jobId: row.id } });
}

/** Audio seconds of caption/transcript jobs this workspace started in the last 24 hours. */
async function captionSecondsToday(env: Env, workspaceId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(audio_seconds), 0) AS s FROM post_jobs WHERE workspace_id = ? AND kind IN ('captions','transcript') AND created_at > ? AND status != 'failed'")
    .bind(workspaceId, Date.now() - 86_400_000)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

/**
 * Starts a caption (or transcript-only) job: freezes the audio to transcribe
 * (the source cut, cropped to its span) in R2 and starts PostWorkflow.
 */
export async function createCaptionJob(
  env: Env,
  input: { caller: RoomCaller; projectId: string; canvasId: string; source: CaptionSource; style?: CaptionStyleId; language: string | null; replace: boolean; transcriptOnly: boolean },
): Promise<PostJobRow> {
  const { edl } = await readTimeline(env, input.projectId, input.canvasId, input.caller);
  const src = captionSourceEdl(edl, input.source);
  if (!src) throw new ApiError(422, "VALIDATION_FAILED", "There is no sound to caption here", { reason: "NO_AUDIO" });
  const seconds = src.range.end - src.range.start;
  const cap = POST_PRODUCTION.captions;
  if (seconds > cap.maxMinutesPerJob * 60) throw new ApiError(422, "VALIDATION_FAILED", `Captions take up to ${cap.maxMinutesPerJob} minutes at a time`, { reason: "TOO_LONG" });
  if ((await captionSecondsToday(env, input.caller.workspaceId)) + seconds > cap.maxMinutesPerDay * 60) {
    throw new ApiError(429, "RATE_LIMITED", "Today’s captioning limit is reached. Try again tomorrow.", { reason: "DAILY_LIMIT", maxMinutesPerDay: cap.maxMinutesPerDay });
  }
  let transcriptAssetId: string | undefined;
  if (input.source.kind === "clip") {
    const clipId = input.source.clipId;
    const clip = src.edl.tracks.flatMap((t) => t.clips as { id: string; assetId?: string | null }[]).find((c) => c.id === clipId);
    if (clip?.assetId) transcriptAssetId = clip.assetId;
  }
  const params: CaptionParams = {
    source: input.source,
    range: src.range,
    ...(input.style && { style: input.style }),
    language: input.language,
    replace: input.replace,
    ...(transcriptAssetId && { transcriptAssetId }),
  };
  const row: PostJobRow = {
    id: newId("postJob"),
    kind: input.transcriptOnly ? "transcript" : "captions",
    workspace_id: input.caller.workspaceId,
    project_id: input.projectId,
    canvas_id: input.canvasId,
    asset_id: transcriptAssetId ?? null,
    status: "queued",
    progress: 0,
    params: JSON.stringify(params),
    result: null,
    audio_seconds: seconds,
    error_code: null,
    error_message: null,
    created_by: input.caller.userId,
    created_at: Date.now(),
    finished_at: null,
  };
  const cut: Edl = cropEdl(src.edl, src.range.start, src.range.end);
  await env.MEDIA.put(`${postJobDir(row)}/edl.json`, JSON.stringify(cut), { httpMetadata: { contentType: "application/json" } });
  await insert(env, row);
  return row;
}

/** Short side of an asset from its metadata, when known. */
function shortSideOf(meta: Record<string, unknown>): number | null {
  const w = Number(meta.width);
  const h = Number(meta.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? Math.min(w, h) : null;
}

/**
 * Starts a Resize: plan caps (D-006: 1080p video needs Plus, 4K needs Pro;
 * images 4K need Pro), a ready video or image of the workspace, smaller than
 * the target, videos at most `POST_PRODUCTION.resize.maxSeconds`.
 */
export async function createResizeJob(
  env: Env,
  input: { userId: string; workspaceId: string; plan: PlanId; assetId: string; target: ResizeTarget; projectId?: string; nodeId?: string },
): Promise<PostJobRow> {
  const a = await env.DB.prepare("SELECT id, kind, status, workspace_id, meta, r2_key FROM assets WHERE id = ?").bind(input.assetId).first<{ id: string; kind: string; status: string; workspace_id: string | null; meta: string | null; r2_key: string }>();
  if (!a || a.workspace_id !== input.workspaceId) throw new ApiError(404, "NOT_FOUND", "Asset not found");
  if ((a.kind !== "video" && a.kind !== "image") || a.status !== "ready") throw new ApiError(422, "VALIDATION_FAILED", "Only ready videos and images can be resized", { reason: "NOT_RESIZABLE" });
  const media = a.kind as "video" | "image";
  if (!planAllowsResize(input.plan, media, input.target)) {
    throw new ApiError(402, "NO_PLAN", `${input.target} needs a higher plan`, { reason: "resolution_locked", lowestPlan: lowestPlanFor(media, input.target) });
  }
  let meta: Record<string, unknown> = {};
  try {
    meta = a.meta ? (JSON.parse(a.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  const short = RESIZE_TARGETS[input.target] as 1080 | 2160;
  const current = shortSideOf(meta);
  if (current !== null && current >= short) throw new ApiError(422, "VALIDATION_FAILED", `This is already ${input.target} or larger`, { reason: "ALREADY_LARGE" });
  const duration = Number(meta.durationSec);
  if (media === "video" && Number.isFinite(duration) && duration > POST_PRODUCTION.resize.maxSeconds) {
    throw new ApiError(422, "VALIDATION_FAILED", `Resize takes clips up to ${POST_PRODUCTION.resize.maxSeconds} seconds`, { reason: "TOO_LONG" });
  }
  const params: ResizeParams = {
    target: input.target,
    media,
    short,
    ...(input.projectId && { projectId: input.projectId }),
    ...(input.nodeId && { nodeId: input.nodeId }),
    ...(Number.isFinite(duration) && duration > 0 && { durationSec: duration }),
  };
  const row: PostJobRow = {
    id: newId("postJob"),
    kind: "resize",
    workspace_id: input.workspaceId,
    project_id: input.projectId ?? null,
    canvas_id: null,
    asset_id: a.id,
    status: "queued",
    progress: 0,
    params: JSON.stringify(params),
    result: null,
    audio_seconds: 0,
    error_code: null,
    error_message: null,
    created_by: input.userId,
    created_at: Date.now(),
    finished_at: null,
  };
  await insert(env, row);
  return row;
}

/** Signed input URLs for a cut's assets (ready, this workspace or shared), others dropped (silence / black). */
export async function signInputs(env: Env, workspaceId: string, edl: Edl, ttl = 4 * 3600): Promise<{ edl: Edl; inputs: Record<string, { url: string }> }> {
  const ids = new Set<string>();
  for (const t of edl.tracks) if (t.kind !== "caption") for (const c of t.clips) if (c.assetId) ids.add(c.assetId);
  const inputs: Record<string, { url: string }> = {};
  for (const id of ids) {
    const a = await env.DB.prepare("SELECT r2_key, workspace_id, status FROM assets WHERE id = ?").bind(id).first<{ r2_key: string; workspace_id: string | null; status: string }>();
    if (!a || a.status !== "ready" || (a.workspace_id && a.workspace_id !== workspaceId)) continue;
    try {
      inputs[id] = { url: await signMediaUrl(env, a.r2_key, { workspaceId: a.workspace_id ?? "_", expiresIn: ttl, absolute: true }) };
    } catch {
      // Key outside the workspace: dropped.
    }
  }
  const out = structuredClone(edl);
  for (const t of out.tracks) if (t.kind !== "caption") for (const c of t.clips) if (c.assetId && !inputs[c.assetId]) c.assetId = null;
  return { edl: out, inputs };
}
