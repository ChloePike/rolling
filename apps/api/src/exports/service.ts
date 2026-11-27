/**
 * MP4 exports (canvas-flow step 11). `POST /api/canvases/:id/export` stores the
 * cut to render (the timeline cropped to the range) in R2, inserts an
 * `exports` row and starts ExportWorkflow; the workflow resolves signed input
 * URLs (D-008), drives the FFmpeg container's `/render`, registers the MP4 as
 * an asset (rated by the safety hook on its poster frame) and reports over the
 * project channel: `export.progress`, `export.done`, `export.failed`.
 *
 * Exports are free of credits for now (docs/api.md → Editor).
 *
 * Post-production (D-033, D-034, D-035): social presets (fixed frame,
 * platform encode, -14 LUFS, shots reframed around the subject on an aspect
 * change), caption burn-in in the caption track's look, Smoother motion
 * (frame interpolation), the brand kit (watermark, cards, caption font and
 * color), batch exports (several presets at once, one `batch_id`) and short
 * low-resolution previews (not saved to Assets).
 */
import { newId } from "@rolling/core/ids";
import {
  exportSize,
  MAX_INTERPOLATED_SECONDS,
  needsReframe,
  planExport,
  PRESET_ENCODE,
  PREVIEW_SECONDS,
  previewSize,
  VOICE_LUFS,
  type ExportOptions,
  type ExportPreset,
  type RenderJob,
} from "@rolling/core/export";
import { captionTrackOf } from "@rolling/core/post";
import type { Edl } from "@rolling/core/timeline";
import { renderBrand } from "../post/brandKit";
import { projectRoom, type RoomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { mediaUrlFor, signMediaUrl } from "../lib/mediaUrls";
import { presignPut, s3Config } from "../lib/r2s3";
import { unwrap } from "../lib/room";

export type ExportStatus = "queued" | "running" | "done" | "failed";

export interface ExportRow {
  id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  preset: ExportPreset;
  range_start: number | null;
  range_end: number | null;
  timeline_revision: number;
  status: ExportStatus;
  progress: number;
  width: number;
  height: number;
  duration: number;
  asset_id: string | null;
  r2_key: string | null;
  size: number | null;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  finished_at: number | null;
  /** 0031: JSON ExportOptions. */
  options?: string | null;
  batch_id?: string | null;
  preview?: number | null;
}

export interface ExportView {
  id: string;
  projectId: string;
  canvasId: string;
  preset: ExportPreset;
  range: { start: number; end: number } | null;
  status: ExportStatus;
  progress: number;
  width: number;
  height: number;
  duration: number;
  assetId: string | null;
  size: number | null;
  fileName: string;
  /** Signed download URL (D-008), only when done and the viewer may see it. */
  url: string | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  finishedAt: number | null;
  options: ExportOptions;
  batchId: string | null;
  preview: boolean;
}

export function optionsOf(row: Pick<ExportRow, "options">): ExportOptions {
  try {
    return row.options ? (JSON.parse(row.options) as ExportOptions) : {};
  } catch {
    return {};
  }
}

/** Signed download URLs last this long (the dialog refreshes through `GET /api/exports/:id`). */
export const EXPORT_URL_TTL_SECONDS = 3600;
/** Signed input URLs must outlive the render. */
export const INPUT_URL_TTL_SECONDS = 4 * 3600;

export function exportDir(row: Pick<ExportRow, "workspace_id" | "id">): string {
  return `ws/${row.workspace_id}/exports/${row.id}`;
}

const PRESET_FILE: Record<ExportPreset, string> = { mp4_1080p: "1080p", mp4_720p: "720p", vertical_9x16: "9x16", square_1x1: "1x1", landscape_16x9: "16x9" };

export function exportFileName(row: Pick<ExportRow, "id" | "preset"> & { preview?: number | null }): string {
  return `export-${row.id.slice(4, 14).toLowerCase()}-${PRESET_FILE[row.preset] ?? "video"}${row.preview ? "-preview" : ""}.mp4`;
}

export async function loadExport(env: Env, id: string): Promise<ExportRow | null> {
  return env.DB.prepare("SELECT * FROM exports WHERE id = ?").bind(id).first<ExportRow>();
}

export async function exportView(env: Env, row: ExportRow, viewer: { mayViewMature: boolean }): Promise<ExportView> {
  let url: string | null = null;
  if (row.status === "done" && row.r2_key) {
    const asset = row.asset_id ? await env.DB.prepare("SELECT mature FROM assets WHERE id = ?").bind(row.asset_id).first<{ mature: number }>() : null;
    url = await mediaUrlFor(env, { key: row.r2_key, workspaceId: row.workspace_id, mature: asset?.mature === 1 }, viewer, EXPORT_URL_TTL_SECONDS);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    preset: row.preset,
    range: row.range_start !== null && row.range_end !== null ? { start: row.range_start, end: row.range_end } : null,
    status: row.status,
    progress: row.progress,
    width: row.width,
    height: row.height,
    duration: row.duration,
    assetId: row.asset_id,
    size: row.size,
    fileName: exportFileName(row),
    url,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    options: optionsOf(row),
    batchId: row.batch_id ?? null,
    preview: row.preview === 1,
  };
}

const REASON_MESSAGE = {
  EMPTY: "There is nothing to export in this range",
  TOO_LONG: "Exports are limited to 15 minutes",
  BAD_RANGE: "The range must end after it starts",
} as const;

/** A batch: one export per preset with the same range and options, sharing the first export's id as `batch_id`. */
export async function createExports(
  env: Env,
  input: { caller: RoomCaller; projectId: string; canvasId: string; presets: ExportPreset[]; range?: { start: number; end: number }; options?: ExportOptions },
): Promise<ExportRow[]> {
  const presets = [...new Set(input.presets)];
  if (presets.length === 1) return [await createExport(env, { ...input, preset: presets[0]! })];
  if (input.options?.preview) throw new ApiError(422, "VALIDATION_FAILED", "Preview one preset at a time", { reason: "PREVIEW_BATCH" });
  const rows: ExportRow[] = [];
  for (const preset of presets) rows.push(await createExport(env, { ...input, preset, ...(rows[0] && { batchId: rows[0].id }) }));
  if (rows[0]) await env.DB.prepare("UPDATE exports SET batch_id = ? WHERE id = ?").bind(rows[0].id, rows[0].id).run();
  rows[0]!.batch_id = rows[0]!.id;
  return rows;
}

/** Creates the export row, stores the cut to render and starts the workflow. */
export async function createExport(
  env: Env,
  input: { caller: RoomCaller; projectId: string; canvasId: string; preset: ExportPreset; range?: { start: number; end: number }; options?: ExportOptions; batchId?: string },
): Promise<ExportRow> {
  const room = projectRoom(env, input.projectId);
  const timeline = unwrap(await room.getTimeline(input.caller, input.canvasId)).timeline;
  const options = input.options ?? {};
  const plan = planExport(timeline.edl, input.range);
  if (!plan.ok) throw new ApiError(422, "VALIDATION_FAILED", REASON_MESSAGE[plan.reason], { reason: plan.reason });
  if (options.preview && plan.duration > PREVIEW_SECONDS + 1e-6) throw new ApiError(422, "VALIDATION_FAILED", `A preview is at most ${PREVIEW_SECONDS} seconds`, { reason: "PREVIEW_TOO_LONG" });
  if (options.interpolate && plan.duration > MAX_INTERPOLATED_SECONDS) {
    throw new ApiError(422, "VALIDATION_FAILED", `Smoother motion takes exports up to ${MAX_INTERPOLATED_SECONDS / 60} minutes`, { reason: "INTERPOLATE_TOO_LONG" });
  }
  const full = exportSize(timeline.edl, input.preset);
  const size = options.preview ? previewSize(full) : full;
  const now = Date.now();
  const row: ExportRow = {
    id: newId("export"),
    workspace_id: input.caller.workspaceId,
    project_id: input.projectId,
    canvas_id: input.canvasId,
    preset: input.preset,
    range_start: input.range?.start ?? null,
    range_end: input.range?.end ?? null,
    timeline_revision: timeline.revision,
    status: "queued",
    progress: 0,
    width: size.width,
    height: size.height,
    duration: plan.duration,
    asset_id: null,
    r2_key: null,
    size: null,
    error_code: null,
    error_message: null,
    created_by: input.caller.userId,
    created_at: now,
    finished_at: null,
    options: JSON.stringify(options),
    batch_id: input.batchId ?? null,
    preview: options.preview ? 1 : 0,
  };
  // The cut is frozen at request time: later edits do not change a running export.
  await env.MEDIA.put(`${exportDir(row)}/edl.json`, JSON.stringify(plan.edl), { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare(
    `INSERT INTO exports (id, workspace_id, project_id, canvas_id, preset, range_start, range_end, timeline_revision, status, progress, width, height, duration, created_by, created_at, options, batch_id, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.workspace_id, row.project_id, row.canvas_id, row.preset, row.range_start, row.range_end, row.timeline_revision, row.width, row.height, row.duration, row.created_by, row.created_at, row.options, row.batch_id, row.preview)
    .run();
  await env.EXPORT.create({ id: row.id, params: { exportId: row.id } });
  await notify(env, row, "export.progress", { status: "queued", progress: 0 });
  return row;
}

/** Fan-out on the project channel. Best effort: a broadcast failure never fails the export. */
export async function notify(env: Env, row: Pick<ExportRow, "id" | "project_id" | "canvas_id">, type: "export.progress" | "export.done" | "export.failed", payload: Record<string, unknown>): Promise<void> {
  try {
    await projectRoom(env, row.project_id).broadcast(type, { exportId: row.id, projectId: row.project_id, canvasId: row.canvas_id, ...payload });
  } catch (err) {
    console.warn(JSON.stringify({ msg: "exports: broadcast failed", exportId: row.id, type, error: String(err) }));
  }
}

export class ExportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The render job for the container: the stored cut with signed input URLs.
 * Inputs must be ready assets of the export's workspace (or shared library
 * items); anything else renders as black / silence.
 */
export async function buildRenderJob(env: Env, row: ExportRow): Promise<RenderJob> {
  const obj = await env.MEDIA.get(`${exportDir(row)}/edl.json`);
  if (!obj) throw new ExportFailure("missing_cut", "The cut to export is missing. Start the export again.");
  const edl = (await obj.json()) as Edl;
  const ids = new Set<string>();
  for (const t of edl.tracks) if (t.kind !== "caption") for (const c of t.clips) if (c.assetId) ids.add(c.assetId);
  const inputs: RenderJob["inputs"] = {};
  for (const id of ids) {
    const a = await env.DB.prepare("SELECT r2_key, workspace_id, status FROM assets WHERE id = ?").bind(id).first<{ r2_key: string; workspace_id: string | null; status: string }>();
    if (!a || a.status !== "ready") continue;
    if (a.workspace_id && a.workspace_id !== row.workspace_id) continue;
    const ws = a.workspace_id ?? "_";
    try {
      inputs[id] = { url: await signMediaUrl(env, a.r2_key, { workspaceId: ws, expiresIn: INPUT_URL_TTL_SECONDS, absolute: true }) };
    } catch {
      // Key outside the workspace: skip (renders black).
    }
  }
  for (const t of edl.tracks) if (t.kind !== "caption") for (const c of t.clips) if (c.assetId && !inputs[c.assetId]) c.assetId = null;
  const cfg = s3Config(env);
  const options = optionsOf(row);
  const track = captionTrackOf(edl);
  const hasCaptions = edl.tracks.some((t) => t.kind === "caption" && t.clips.some((c) => c.text.trim()));
  const pieces = await renderBrand(env, row.workspace_id, { brand: options.brand === true, style: track?.style, lang: track?.lang ?? null, burnCaptions: hasCaptions && options.burnCaptions !== false });
  const job: RenderJob = {
    id: row.id,
    edl,
    width: row.width,
    height: row.height,
    fps: edl.fps,
    duration: row.duration,
    inputs,
    // Previews encode fast at constant quality; the real export uses the preset's settings.
    encode: row.preview ? { ...PRESET_ENCODE.mp4_720p, crf: 26 } : PRESET_ENCODE[row.preset],
    reframe: needsReframe(edl, { width: row.width, height: row.height }),
    ...(options.interpolate && options.interpolate > edl.fps && { interpolateFps: options.interpolate }),
    captions: pieces.captions,
    ...(pieces.fonts.length && { fonts: pieces.fonts }),
    ...(pieces.brand && { brand: pieces.brand }),
    voiceLufs: VOICE_LUFS,
  };
  if (cfg) job.putUrl = await presignPut(cfg, `${exportDir(row)}/export.mp4`, INPUT_URL_TTL_SECONDS);
  return job;
}

export async function setStatus(env: Env, id: string, fields: Partial<Pick<ExportRow, "status" | "progress" | "asset_id" | "r2_key" | "size" | "duration" | "error_code" | "error_message" | "finished_at">>): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE exports SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), id)
    .run();
}
