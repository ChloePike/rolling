/**
 * Runs whose output lands on the timeline (D-036 Extend clip, D-037 lip-sync):
 * the quote is a normal Quick spec quote (quote → hold → settle, RunConfirm
 * above the threshold); the placement row remembers where the result goes.
 * Starting the run through `POST …/placed-runs` plans the clip on the
 * timeline at once (not generated yet); a run started through the generic
 * `POST /api/runs` (the shared run flow) is found by its quote and placed when
 * it lands. When the job commits the clip gets its asset and real length; a
 * failure or a cancel takes a planned clip back out.
 */
import { dropPlacement, planAfter, planReplace, resolvePlacement, type PlacementMode } from "@rolling/core/post";
import { applyOps, findClip, isCaptionClip, type MediaClip } from "@rolling/core/timeline";
import { newId } from "@rolling/core/ids";
import type { PromptSpec } from "@rolling/core/generation";
import type { AuthContext } from "../auth/context";
import type { RoomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { keyBelongsTo } from "@rolling/core/media";
import { presignPut, s3Config } from "../lib/r2s3";
import { signMediaUrl } from "../lib/mediaUrls";
import { quoteRun, startRun, type QuoteResponse } from "../runs/service";
import { loadCatalog } from "../models/catalog";
import { ensureFrame } from "../runs/frames";
import { editTimeline, readTimeline } from "./timeline";
import { ContainerUnavailable, postContainer } from "./seams";

export interface PlacementRow {
  id: string;
  quote_id: string;
  run_id: string | null;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  mode: PlacementMode;
  anchor_clip_id: string;
  placed_clip_id: string | null;
  seconds: number;
  previous: string | null;
  status: "quoted" | "pending" | "placed" | "dropped";
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface AssetLite {
  id: string;
  kind: string;
  source: string;
  status: string;
  workspace_id: string | null;
  r2_key: string;
  meta: string | null;
  mature: number | null;
}

const meta = (a: Pick<AssetLite, "meta">): Record<string, unknown> => {
  try {
    return a.meta ? (JSON.parse(a.meta) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

async function assetOf(env: Env, id: string, workspaceId: string, kind: string): Promise<AssetLite> {
  const a = await env.DB.prepare("SELECT id, kind, source, status, workspace_id, r2_key, meta, mature FROM assets WHERE id = ?").bind(id).first<AssetLite>();
  if (!a || a.workspace_id !== workspaceId || a.kind !== kind || a.status !== "ready") throw new ApiError(422, "VALIDATION_FAILED", `This clip has no ready ${kind} to use`, { reason: "NO_MEDIA" });
  return a;
}

/** Registers a derived still or audio cut as an asset of the workspace (same source and mature flag as its origin). */
async function deriveAsset(env: Env, from: AssetLite, kind: "image" | "audio", key: string, name: string, extra: Record<string, unknown>, userId: string, contentType: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM assets WHERE r2_key = ? AND workspace_id = ?").bind(key, from.workspace_id).first<{ id: string }>();
  if (existing) return existing.id;
  const head = await env.MEDIA.head(key);
  const id = newId("asset");
  // Pictures from a generated clip stay platform assets (D-005); uploads stay uploads.
  const source = from.source === "generated" ? "generated" : from.source;
  await env.DB.prepare(
    `INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature, size, content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
  )
    .bind(id, from.workspace_id, kind, source, name.slice(0, 200), key, JSON.stringify({ derivedFrom: from.id, processing: "done", ...extra }), userId, Date.now(), from.mature ?? 0, head?.size ?? null, contentType)
    .run();
  return id;
}

/** The last frame of a video as a PNG asset (container `/last-frame`, cached by key). */
export async function lastFrameAsset(env: Env, video: AssetLite, userId: string): Promise<string> {
  const key = `ws/${video.workspace_id}/frames/${video.id}/last.png`;
  if (!keyBelongsTo(key, video.workspace_id!)) throw new ApiError(422, "VALIDATION_FAILED", "This clip can't be extended");
  if (!(await env.MEDIA.head(key))) {
    const url = await signMediaUrl(env, video.r2_key, { workspaceId: video.workspace_id!, expiresIn: 900, absolute: true });
    const cfg = s3Config(env);
    try {
      if (cfg) {
        await postContainer()(env, "/last-frame", { url, width: 1920, put: await presignPut(cfg, key, 900) }, 60_000);
      } else {
        const res = await postContainer()(env, "/last-frame", { url, width: 1920 }, 60_000);
        await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
      }
    } catch (err) {
      if (err instanceof ContainerUnavailable) throw new ApiError(503, "INTERNAL", "The media service is not available right now. Try again in a few minutes.", { reason: "renderer_unavailable" });
      throw err;
    }
    if (!(await env.MEDIA.head(key))) throw new ApiError(502, "INTERNAL", "The last frame could not be read");
  }
  const m = meta(video);
  return deriveAsset(env, video, "image", key, "Last frame", { frameOf: "last", ...(m.width ? { width: m.width, height: m.height } : {}) }, userId, "image/png");
}

/** A cut of a voice track (container `/audio-cut`) as an audio asset that keeps the upload's rights note. */
async function audioCutAsset(env: Env, voice: AssetLite, range: { in: number; out: number }, userId: string): Promise<string> {
  const key = `ws/${voice.workspace_id}/cuts/${voice.id}/${Math.round(range.in * 1000)}-${Math.round(range.out * 1000)}.m4a`;
  if (!(await env.MEDIA.head(key))) {
    const url = await signMediaUrl(env, voice.r2_key, { workspaceId: voice.workspace_id!, expiresIn: 900, absolute: true });
    const body = { url, start: range.in, duration: range.out - range.in };
    const cfg = s3Config(env);
    try {
      if (cfg) await postContainer()(env, "/audio-cut", { ...body, put: await presignPut(cfg, key, 900) }, 60_000);
      else {
        const res = await postContainer()(env, "/audio-cut", body, 60_000);
        await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: "audio/mp4" } });
      }
    } catch (err) {
      if (err instanceof ContainerUnavailable) throw new ApiError(503, "INTERNAL", "The media service is not available right now. Try again in a few minutes.", { reason: "renderer_unavailable" });
      throw err;
    }
  }
  const m = meta(voice);
  return deriveAsset(env, voice, "audio", key, "Voice part", { durationSec: range.out - range.in, hasAudio: true, ...(m.voiceRights ? { voiceRights: m.voiceRights } : {}) }, userId, "audio/mp4");
}

const RATIOS: [string, number][] = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["21:9", 21 / 9]];

function ratioOf(m: Record<string, unknown>): string | undefined {
  const w = Number(m.width);
  const h = Number(m.height);
  if (!(w > 0 && h > 0)) return undefined;
  return RATIOS.reduce((best, r) => (Math.abs(Math.log(w / h / r[1])) < Math.abs(Math.log(w / h / best[1])) ? r : best))[0];
}

async function insertPlacement(env: Env, row: Omit<PlacementRow, "run_id" | "placed_clip_id" | "status" | "updated_at">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO timeline_placements (id, quote_id, workspace_id, project_id, canvas_id, mode, anchor_clip_id, seconds, previous, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?)`,
  )
    .bind(row.id, row.quote_id, row.workspace_id, row.project_id, row.canvas_id, row.mode, row.anchor_clip_id, row.seconds, row.previous, row.created_by, row.created_at, row.created_at)
    .run();
}

export interface PlacedQuote extends QuoteResponse {
  placementId: string | null;
}

/**
 * Extend clip (D-036): the clip's last frame becomes the first frame of an
 * image-to-video run with the continuation prompt, on the clip's own model
 * when it takes a first frame (else Auto). Quoted like any run.
 */
export async function quoteExtend(
  env: Env,
  auth: AuthContext,
  input: { caller: RoomCaller; projectId: string; canvasId: string; clipId: string; prompt: string; model?: string; seconds?: number; resolution?: string },
): Promise<PlacedQuote & { frameAssetId: string; model: string }> {
  const { edl } = await readTimeline(env, input.projectId, input.canvasId, input.caller);
  const ref = findClip(edl, input.clipId);
  if (!ref || ref.track.kind !== "video" || isCaptionClip(ref.clip) || !ref.clip.assetId) throw new ApiError(422, "VALIDATION_FAILED", "Pick a generated shot to extend", { reason: "NOT_A_SHOT" });
  const video = await assetOf(env, ref.clip.assetId, input.caller.workspaceId, "video");
  const frameAssetId = await lastFrameAsset(env, video, auth.userId);
  let model = input.model ?? "auto";
  if (!input.model) {
    const job = await env.DB.prepare("SELECT model FROM jobs WHERE asset_id = ? AND model IS NOT NULL LIMIT 1").bind(video.id).first<{ model: string }>();
    const catalog = await loadCatalog(env);
    const m = job ? catalog.get(job.model) : null;
    if (m && m.operations.includes("i2v")) model = m.id;
  }
  const seconds = input.seconds ?? 5;
  const ratio = ratioOf(meta(video));
  const spec: PromptSpec = {
    kind: "video",
    model,
    prompt: input.prompt,
    title: "Extended shot",
    seconds,
    ...(ratio && { ratio }),
    ...(input.resolution && { resolution: input.resolution }),
    // The continuation keeps the shot's look; the agent's prompt rewrite would drift from it.
    promptExpand: false,
    ...(video.mature === 1 && { mature: true }),
    inputs: { firstFrameAssetId: frameAssetId },
  } as PromptSpec;
  const quote = await quoteRun(env, auth, { promptSpec: spec, projectId: input.projectId, surface: "quick" });
  let placementId: string | null = null;
  if (quote.quoteId) {
    placementId = newId("placement");
    await insertPlacement(env, { id: placementId, quote_id: quote.quoteId, workspace_id: input.caller.workspaceId, project_id: input.projectId, canvas_id: input.canvasId, mode: "after", anchor_clip_id: input.clipId, seconds, previous: null, created_by: auth.userId, created_at: Date.now() });
  }
  return { ...quote, placementId, frameAssetId, model };
}

/**
 * Lip-sync a shot to a voice part (D-037): the shot's first frame (or a chosen
 * picture) and the voice clip's audio range → the Avatar lip-sync model; the
 * result replaces the shot. Users attest the rights to uploaded voices.
 */
export async function quoteLipSync(
  env: Env,
  auth: AuthContext,
  input: { caller: RoomCaller; projectId: string; canvasId: string; shotClipId: string; voiceClipId: string; pictureAssetId?: string; prompt?: string; model?: string },
): Promise<PlacedQuote & { photoAssetId: string; audioAssetId: string }> {
  const { edl } = await readTimeline(env, input.projectId, input.canvasId, input.caller);
  const shot = findClip(edl, input.shotClipId);
  const voice = findClip(edl, input.voiceClipId);
  if (!shot || shot.track.kind !== "video" || isCaptionClip(shot.clip)) throw new ApiError(422, "VALIDATION_FAILED", "Pick a shot to lip-sync", { reason: "NOT_A_SHOT" });
  if (!voice || voice.track.kind !== "voice" || isCaptionClip(voice.clip) || !voice.clip.assetId) throw new ApiError(422, "VALIDATION_FAILED", "Pick a voice clip on the voice lane", { reason: "NOT_A_VOICE" });
  const voiceAsset = await assetOf(env, voice.clip.assetId, input.caller.workspaceId, "audio");
  if (!meta(voiceAsset).voiceRights && voiceAsset.source !== "generated") {
    throw new ApiError(422, "VALIDATION_FAILED", "Confirm you have the rights to use this voice first", { reason: "VOICE_RIGHTS_REQUIRED", assetId: voiceAsset.id });
  }
  let photoAssetId = input.pictureAssetId;
  if (photoAssetId) await assetOf(env, photoAssetId, input.caller.workspaceId, "image");
  else {
    const clip = shot.clip as MediaClip;
    if (!clip.assetId) throw new ApiError(422, "VALIDATION_FAILED", "Generate this shot first, or pick a picture", { reason: "NO_PICTURE" });
    const video = await assetOf(env, clip.assetId, input.caller.workspaceId, "video");
    const key = await ensureFrame(env, { id: video.id, r2_key: video.r2_key, workspace_id: video.workspace_id! }, clip.in);
    if (!key) throw new ApiError(503, "INTERNAL", "The media service is not available right now. Try again in a few minutes.", { reason: "renderer_unavailable" });
    photoAssetId = await deriveAsset(env, video, "image", key, "Shot frame", { frameAt: clip.in }, auth.userId, "image/png");
  }
  const vc = voice.clip as MediaClip;
  const audioAssetId = await audioCutAsset(env, voiceAsset, { in: vc.in, out: vc.out }, auth.userId);
  const spec: PromptSpec = {
    kind: "avatar",
    model: input.model ?? "auto",
    prompt: input.prompt ?? "",
    title: "Lip-synced shot",
    inputs: { photoAssetId, audioAssetId },
  } as PromptSpec;
  const quote = await quoteRun(env, auth, { promptSpec: spec, projectId: input.projectId, surface: "avatar" });
  let placementId: string | null = null;
  const plan = planReplace(edl, input.shotClipId);
  if (quote.quoteId && plan) {
    placementId = newId("placement");
    await insertPlacement(env, {
      id: placementId,
      quote_id: quote.quoteId,
      workspace_id: input.caller.workspaceId,
      project_id: input.projectId,
      canvas_id: input.canvasId,
      mode: "replace",
      anchor_clip_id: input.shotClipId,
      seconds: vc.out - vc.in,
      previous: JSON.stringify(plan.previous),
      created_by: auth.userId,
      created_at: Date.now(),
    });
  }
  return { ...quote, placementId, photoAssetId, audioAssetId };
}

/** Starts the placed run (the client confirmed the quote when it needed confirming) and plans its clip on the timeline. */
export async function startPlaced(env: Env, auth: AuthContext, caller: RoomCaller, canvasId: string, quoteId: string): Promise<{ runId: string; status: string; placedClipId: string | null }> {
  const p = await env.DB.prepare("SELECT * FROM timeline_placements WHERE quote_id = ? AND workspace_id = ? AND canvas_id = ?").bind(quoteId, caller.workspaceId, canvasId).first<PlacementRow>();
  if (!p) throw new ApiError(404, "NOT_FOUND", "Quote not found", { quoteId });
  const run = await startRun(env, auth, quoteId);
  if (p.status !== "quoted") return { ...run, placedClipId: p.placed_clip_id };
  let placed: string | null = null;
  if (p.mode === "after") {
    await editTimeline(env, p.project_id, p.canvas_id, caller, ({ edl }) => {
      const plan = planAfter(edl, p.anchor_clip_id, p.seconds, { skipHead: 1 / edl.fps });
      placed = plan?.clipId ?? null;
      return plan ? { ops: plan.ops } : null;
    }).catch((err: unknown) => console.warn(JSON.stringify({ msg: "placement: planning failed", placement: p.id, error: String(err) })));
  } else placed = p.anchor_clip_id;
  await env.DB.prepare("UPDATE timeline_placements SET run_id = ?, placed_clip_id = ?, status = 'pending', updated_at = ? WHERE id = ?").bind(run.runId, placed, Date.now(), p.id).run();
  return { ...run, placedClipId: placed };
}

/** The open placement of a run: by run id, else by the run's quote (started through `POST /api/runs`). */
async function placementOfRun(env: Env, runId: string): Promise<PlacementRow | null> {
  const byRun = await env.DB.prepare("SELECT * FROM timeline_placements WHERE run_id = ? AND status = 'pending'").bind(runId).first<PlacementRow>();
  if (byRun) return byRun;
  return env.DB.prepare("SELECT p.* FROM timeline_placements p JOIN runs r ON r.quote_id = p.quote_id WHERE r.id = ? AND p.status = 'quoted'").bind(runId).first<PlacementRow>();
}

/** Job commit hook: the planned clip gets its asset (and real length); an unplanned extension is placed now. */
export async function settlePlacement(env: Env, runId: string, assetId: string | null): Promise<void> {
  if (!assetId) return;
  const p = await placementOfRun(env, runId);
  if (!p) return;
  const a = await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(assetId).first<{ meta: string | null }>();
  const d = Number(meta({ meta: a?.meta ?? null }).durationSec);
  const caller = { userId: p.created_by, workspaceId: p.workspace_id, canEdit: true };
  await editTimeline(env, p.project_id, p.canvas_id, caller, ({ edl }) => {
    let base = edl;
    let placedId = p.placed_clip_id ?? (p.mode === "replace" ? p.anchor_clip_id : null);
    if (!placedId) {
      const plan = planAfter(edl, p.anchor_clip_id, p.seconds, { skipHead: 1 / edl.fps });
      if (!plan) return null;
      const applied = applyOps(edl, plan.ops);
      if (!applied.ok) return null;
      base = applied.edl;
      placedId = plan.clipId;
    }
    const next = resolvePlacement(base, placedId, assetId, Number.isFinite(d) ? d : null, p.mode);
    return next ? { edl: next } : null;
  });
  await env.DB.prepare("UPDATE timeline_placements SET status = 'placed', run_id = COALESCE(run_id, ?), updated_at = ? WHERE id = ?").bind(runId, Date.now(), p.id).run();
}

/** Job failure / run cancel hook: the planned clip goes (an extension's gap closes; a replaced shot keeps its take). */
export async function dropPlacements(env: Env, runId: string): Promise<void> {
  const p = await placementOfRun(env, runId);
  if (!p) return;
  if (p.placed_clip_id && p.mode === "after") {
    const caller = { userId: p.created_by, workspaceId: p.workspace_id, canEdit: true };
    await editTimeline(env, p.project_id, p.canvas_id, caller, ({ edl }) => {
      const r = dropPlacement(edl, p.placed_clip_id!, p.mode);
      // Only a clip still waiting for its asset is removed (the user may have used the slot).
      const clip = findClip(edl, p.placed_clip_id!)?.clip as MediaClip | undefined;
      if (!r || !clip || clip.assetId) return null;
      return r;
    });
  }
  await env.DB.prepare("UPDATE timeline_placements SET status = 'dropped', run_id = COALESCE(run_id, ?), updated_at = ? WHERE id = ?").bind(runId, Date.now(), p.id).run();
}
