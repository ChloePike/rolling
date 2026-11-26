/**
 * Step bodies of GenerateWorkflow (one job = one ledger hold). Each function is
 * idempotent: a step may run again after a crash or a retry.
 */
import { hyperouter, type CatalogModel, type GenerateRequest, type JobError, type JobStatus } from "@rolling/core";
import { buildGenerateRequest, paramsHash, priceRequestOf, requestProblems, type GenInput, type GenSpec, type ResolvedInput } from "@rolling/core/generation";
import { creditsFor, creditsForUsd } from "@rolling/core/pricing/config";
import { newId } from "@rolling/core/ids";
import type { ImageSource } from "@rolling/core";
import { keyBelongsTo } from "@rolling/core/media";
import { isRoomError } from "../lib/room";
import { signMediaUrl } from "../lib/mediaUrls";
import { publicMediaUrl } from "../routes/media";
import { loadCatalog } from "../models/catalog";
import { gatewayFetch, generationProvider, hyperouterClient } from "./provider";
import { ports, quietly } from "./ports";
import { advanceRun, advanceWorkspace, pushCredits } from "./service";
import { isMatureRating, type FaceResult, type SafetyOutput, type SafetyReference } from "@rolling/core/safety";
import { jobPostCheck, jobPreCheck, referenceSource } from "../safety/pipeline";
import { faceResultFromMeta, pictureDataUrl, r2Picture, sha256OfBytes } from "../safety/service";
import { getItem, getJob, getRun, parseJson, refreshRun, type RunOptions } from "./store";
import { ensureFrame } from "./frames";

export interface GenerateParams {
  jobId: string;
  runId: string;
  ref: string;
  workspaceId: string;
}

/** Everything the steps need, loaded once (step result, JSON). */
export interface JobContext {
  jobId: string;
  runId: string;
  ref: string;
  workspaceId: string;
  projectId: string | null;
  nodeId: string | null;
  createdBy: string;
  title: string;
  spec: GenSpec;
  modelId: string;
  /** Credits held for this job. */
  credits: number;
  paramsHash: string | null;
  forceFailure: boolean;
  canceled: boolean;
}

export async function loadJobContext(env: Env, p: GenerateParams): Promise<JobContext | null> {
  const [run, item, job] = await Promise.all([getRun(env.DB, p.runId), getItem(env.DB, p.runId, p.ref), getJob(env.DB, p.jobId)]);
  if (!run || !item || !job) return null;
  const options = parseJson<RunOptions>(run.options, {});
  const force = options.forceFailure === true || (Array.isArray(options.forceFailure) && options.forceFailure.includes(p.ref));
  return {
    jobId: p.jobId,
    runId: p.runId,
    ref: p.ref,
    workspaceId: run.workspace_id,
    projectId: run.project_id,
    nodeId: item.node_id,
    createdBy: run.created_by,
    title: item.title ?? item.ref,
    spec: JSON.parse(item.spec) as GenSpec,
    modelId: item.model,
    credits: job.cost_quote,
    paramsHash: item.params_hash,
    forceFailure: force && env.ENVIRONMENT !== "production",
    canceled: run.status === "canceled" || job.status === "canceled",
  };
}

function caller(ctx: JobContext) {
  return { userId: ctx.createdBy, workspaceId: ctx.workspaceId, canEdit: true };
}

/** A failure that ends the job (no workflow retry). */
export class JobFailure extends Error {
  constructor(readonly error: JobError) {
    super(error.message);
    this.name = "JobFailure";
  }
}

function fail(code: string, message: string, retryable = false): never {
  throw new JobFailure({ code, message, retryable, refundable: true });
}

async function modelFor(env: Env, modelId: string): Promise<CatalogModel> {
  const model = (await loadCatalog(env)).get(modelId);
  if (!model) fail("unknown_model", `Model ${modelId} is not available.`);
  return model;
}

const SIGNED_INPUT_TTL = 6 * 3600;

/** A resolved input file; `face` is the face metadata stored at upload for exactly this picture (UP-4). */
type InputFile = { url: string; origin: ImageSource; key: string; name: string; face?: FaceResult | null };

async function assetUrl(env: Env, ctx: JobContext, assetId: string): Promise<InputFile | null> {
  const row = await env.DB.prepare("SELECT r2_key, workspace_id, source, status, name, mature, kind, meta FROM assets WHERE id = ?").bind(assetId).first<{
    r2_key: string;
    mature: number | null;
    kind: string;
    meta: string | null;
    workspace_id: string | null;
    source: string;
    status: string;
    name: string;
  }>();
  // `processing` uploads are usable: the object is complete in R2, probing only adds metadata.
  if (!row || (row.status !== "ready" && row.status !== "processing") || (row.workspace_id !== null && row.workspace_id !== ctx.workspaceId)) return null;
  const origin: ImageSource = row.source === "generated" || row.source === "public" || row.source === "builtin" ? row.source : row.source === "team" ? "team" : "upload";
  // Mature public-library objects are not in the public bucket (D-008): they are signed below.
  if (row.r2_key.startsWith("public/") && !row.mature && env.PUBLIC_MEDIA_BASE_URL) return { url: publicMediaUrl(row.r2_key, env.PUBLIC_MEDIA_BASE_URL), origin, key: row.r2_key, name: row.name };
  const ws = row.workspace_id && keyBelongsTo(row.r2_key, row.workspace_id) ? row.workspace_id : "_";
  if (!keyBelongsTo(row.r2_key, ws)) return null;
  const url = await signMediaUrl(env, row.r2_key, { workspaceId: ws, expiresIn: SIGNED_INPUT_TTL, absolute: true });
  const face = row.kind === "image" ? faceResultFromMeta(parseJson(row.meta, {})) : null;
  return { url: url.startsWith("http") ? url : new URL(url, env.PUBLIC_APP_URL).toString(), origin, key: row.r2_key, name: row.name, face };
}

/** The poster frame (thumbnail) of a video asset as a signed picture URL (Remix on models without reference-video input). */
async function posterUrl(env: Env, ctx: JobContext, assetId: string): Promise<InputFile | null> {
  const row = await env.DB.prepare("SELECT workspace_id, meta, status, name, source FROM assets WHERE id = ?").bind(assetId).first<{ workspace_id: string | null; meta: string | null; status: string; name: string; source: string }>();
  if (!row || row.status !== "ready" || row.workspace_id !== ctx.workspaceId) return null;
  const meta = parseJson<{ thumbKey?: unknown }>(row.meta, {});
  const key = meta.thumbKey;
  if (typeof key !== "string" || !keyBelongsTo(key, ctx.workspaceId)) return null;
  const url = await signMediaUrl(env, key, { workspaceId: ctx.workspaceId, expiresIn: SIGNED_INPUT_TTL, absolute: true });
  const origin: ImageSource = row.source === "generated" ? "generated" : row.source === "team" ? "team" : "upload";
  // Face detection of a video upload ran on this poster frame.
  return { url: url.startsWith("http") ? url : new URL(url, env.PUBLIC_APP_URL).toString(), origin, key, name: `${row.name} (poster)`, face: faceResultFromMeta(meta) };
}

/** The reference video's frame at `atSec` as a signed picture URL (Remix shots without their own frame). */
async function videoFrameUrl(env: Env, ctx: JobContext, assetId: string, atSec: number): Promise<{ url: string; origin: ImageSource; key: string; name: string } | null> {
  const row = await env.DB.prepare("SELECT r2_key, workspace_id, status, name, source, kind FROM assets WHERE id = ?")
    .bind(assetId)
    .first<{ r2_key: string; workspace_id: string | null; status: string; name: string; source: string; kind: string }>();
  if (!row || row.kind !== "video" || (row.status !== "ready" && row.status !== "processing") || row.workspace_id !== ctx.workspaceId) return null;
  const key = await ensureFrame(env, { id: assetId, r2_key: row.r2_key, workspace_id: row.workspace_id }, atSec);
  if (!key) return null;
  const url = await signMediaUrl(env, key, { workspaceId: ctx.workspaceId, expiresIn: SIGNED_INPUT_TTL, absolute: true });
  const origin: ImageSource = row.source === "generated" ? "generated" : row.source === "team" ? "team" : "upload";
  return { url: url.startsWith("http") ? url : new URL(url, env.PUBLIC_APP_URL).toString(), origin, key, name: `${row.name} (frame at ${Math.round(atSec * 10) / 10}s)` };
}

/** How much longer than the browser-reported length a probed file may be before the quote no longer holds. */
export function durationOverrun(declaredSec: number, probedSec: number): boolean {
  return probedSec > declaredSec + Math.max(1, declaredSec * 0.1);
}

/**
 * Re-checks lengths the item was quoted with before probing (the upload's
 * browser-reported `durationMs`): once probed, a file clearly longer than
 * reported would make the provider bill more than the hold, so the job fails
 * (refunded) and the user quotes again. Not probed yet → the declared length stands.
 */
async function checkDeclaredDurations(env: Env, ctx: JobContext): Promise<void> {
  const declared = ctx.spec.declaredDurations;
  if (!declared) return;
  for (const [assetId, declaredSec] of Object.entries(declared)) {
    const row = await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(assetId).first<{ meta: string | null }>();
    const meta = parseJson<{ durationSec?: unknown; durationSource?: unknown }>(row?.meta ?? null, {});
    if (meta.durationSource !== "probe" || typeof meta.durationSec !== "number") continue;
    if (durationOverrun(declaredSec, meta.durationSec)) {
      fail("input_changed", `The file is ${Math.round(meta.durationSec)}s long, longer than the ${Math.round(declaredSec)}s it was quoted for. Quote again.`);
    }
  }
}

export interface Prepared {
  request: GenerateRequest;
  /** Digest the new version records: current inputs, or a stale marker when the node changed after the quote. */
  digest: string;
}

/**
 * `prepare`: resolves inputs to signed URLs (upstream outputs have landed by
 * now), builds the request and runs the D-005 pre-check (block = the job
 * fails before any provider call and the hold is released).
 */
export async function prepareJob(env: Env, ctx: JobContext, modelId: string): Promise<Prepared> {
  const model = await modelFor(env, modelId);
  let digest = `dg_spec_${ctx.jobId}`;
  let activeAssets: Record<string, string> = {};
  if (ctx.projectId && ctx.nodeId) {
    const room = ports(env).room(ctx.projectId);
    const graph = await room.getGraph(caller(ctx));
    if (isRoomError(graph)) fail("node_missing", "The project is not available.");
    const node = graph.state.nodes.find((n) => n.id === ctx.nodeId);
    if (!node) fail("node_missing", "The node was removed.");
    activeAssets = graph.assets;
    const d = await room.inputDigest(caller(ctx), ctx.nodeId);
    // Edited since the quote: the run uses the quoted settings, so the version shows "Input changed".
    digest = !isRoomError(d) && (ctx.paramsHash === null || paramsHash(node) === ctx.paramsHash) ? d.digest : `dg_changed_${ctx.jobId}`;
  }
  await checkDeclaredDurations(env, ctx);
  const resolved: ResolvedInput[] = [];
  const references: SafetyReference[] = [];
  for (const input of ctx.spec.inputs as GenInput[]) {
    let assetId: string | undefined;
    if ("node" in input.from) {
      assetId = activeAssets[input.from.node];
      if (!assetId) fail("input_missing", "An input has no output yet.");
    } else if ("item" in input.from) {
      // Another item of this run (a character's face from its full body): its stored output.
      const row = await env.DB.prepare("SELECT asset_id FROM jobs WHERE run_id = ? AND item_ref = ? AND status = 'succeeded' AND asset_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
        .bind(ctx.runId, input.from.item)
        .first<{ asset_id: string }>();
      if (!row) fail("input_missing", "An input has no output yet.");
      assetId = row!.asset_id;
    } else if ("assetId" in input.from) assetId = input.from.assetId;
    else continue;
    const from = "assetId" in input.from ? input.from : null;
    let a: Awaited<ReturnType<typeof assetUrl>>;
    if (from?.frameAt !== undefined) {
      // Remix: the shot's frame of the reference video, else its poster; optional frames are dropped.
      a = (await videoFrameUrl(env, ctx, assetId!, from.frameAt)) ?? (from.poster ? await posterUrl(env, ctx, assetId!) : null);
      if (!a && from.optional) continue;
    } else a = from?.poster ? await posterUrl(env, ctx, assetId!) : await assetUrl(env, ctx, assetId!);
    if (!a) fail("input_missing", "An input file is not available.");
    const origin: ImageSource = "node" in input.from || "item" in input.from ? "generated" : (input.from as { origin: ImageSource }).origin;
    resolved.push({ input, url: a.url, origin });
    const ref: SafetyReference = { kind: input.media, source: referenceSource(origin), caption: a.name };
    // Mature runs: image references go to the vision check as inline pictures (the gateway can't reach private media).
    if (ctx.spec.mature && input.media === "image") {
      const pic = await r2Picture(env, a.key);
      if (pic) Object.assign(ref, { url: pic.url, hash: pic.hash });
      // Stored at upload; absent (or "unavailable") means preCheck detects again and fails closed if it cannot.
      if (a.face) ref.face = a.face;
    }
    references.push(ref);
  }
  const request = buildGenerateRequest(ctx.spec, model, resolved);
  const problems = requestProblems(model, request);
  if (problems.length) fail("invalid_request", `The request does not fit ${model.displayName}: ${problems.join("; ")}.`);
  const blocked = await jobPreCheck(env, safetyJob(ctx), model, request.prompt, ctx.spec.negativePrompt, references);
  if (blocked) fail(blocked.code, blocked.message);
  return { request, digest };
}

/** Provider idempotency key: the job id, then `<job>.r<n>` for the Auto retry on another model. */
export function providerKey(jobId: string, attempt: number): string {
  return attempt === 1 ? jobId : `${jobId}.r${attempt}`;
}

/** `submit`: starts the provider job (idempotent by key). */
export async function submitJob(env: Env, ctx: JobContext, modelId: string, request: GenerateRequest, attempt: number): Promise<{ externalId: string; forced: boolean }> {
  const now = Date.now();
  if (ctx.forceFailure) {
    await env.DB.prepare("UPDATE jobs SET status = 'submitted', external_id = ?, attempt = ?, updated_at = ? WHERE id = ?").bind(`forced_${ctx.jobId}`, attempt, now, ctx.jobId).run();
    return { externalId: `forced_${ctx.jobId}`, forced: true };
  }
  const model = await modelFor(env, modelId);
  let externalId: string;
  try {
    ({ externalId } = await generationProvider(env, model).submit(request, providerKey(ctx.jobId, attempt)));
  } catch (err) {
    if (err instanceof hyperouter.HyperouterError) {
      // Retryable errors are retried by the step (same idempotency key); others end the job.
      if (err.retryable) throw err;
      fail(err.code, err.message, err.code === "unknown_model" || err.code === "model_not_enabled");
    }
    if (err instanceof JobFailure) throw err;
    fail("invalid_request", err instanceof Error ? err.message : "The request was refused.");
  }
  await env.DB.prepare("UPDATE jobs SET status = 'submitted', external_id = ?, model = ?, attempt = ?, updated_at = ? WHERE id = ?")
    .bind(externalId, modelId, attempt, now, ctx.jobId)
    .run();
  if (ctx.projectId && ctx.nodeId) {
    const room = ports(env).room(ctx.projectId);
    await quietly("markRunning", () => room.markRunning({ nodeId: ctx.nodeId!, jobId: ctx.jobId, progress: 0, status: "generating" }));
  }
  return { externalId, forced: false };
}

/** `poll`: reads the provider status and pushes progress. */
export async function pollJob(env: Env, ctx: JobContext, modelId: string, externalId: string): Promise<JobStatus> {
  const model = await modelFor(env, modelId);
  const status = await generationProvider(env, model).status(externalId);
  await reportProgress(env, ctx, status);
  return status;
}

export async function reportProgress(env: Env, ctx: JobContext, status: JobStatus): Promise<void> {
  if (status.state !== "running" && status.state !== "queued") return;
  const progress = Math.max(0, Math.min(0.99, status.progress / 100));
  await env.DB.prepare("UPDATE jobs SET status = ?, progress = ?, updated_at = ? WHERE id = ? AND status IN ('queued','submitted','running')")
    .bind(status.state === "running" ? "running" : "submitted", progress, Date.now(), ctx.jobId)
    .run();
  if (ctx.projectId && ctx.nodeId) {
    const room = ports(env).room(ctx.projectId);
    await quietly("progress", () => room.markRunning({ nodeId: ctx.nodeId!, jobId: ctx.jobId, progress, status: "generating" }));
  }
}

/** Status of a webhook event or the provider for an external id (hooks route). */
export async function fetchProviderStatus(env: Env, eventType: string, externalId: string): Promise<JobStatus | null> {
  const client = hyperouterClient(env);
  if (eventType.startsWith("video.")) return hyperouter.videoJobStatus(client, externalId);
  if (eventType.startsWith("image.")) return hyperouter.generationToJobStatus(await hyperouter.getGeneration(client, externalId));
  return null;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

async function download(url: string): Promise<{ body: ArrayBuffer; contentType: string }> {
  const res = await gatewayFetch()(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Output download failed: HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  return { body: await res.arrayBuffer(), contentType };
}

export interface Stored {
  assetIds: string[];
  kind: "image" | "video";
  /** D-005 content rating of the outputs (highest), null when unrated. */
  rating?: { rating: string; confidence: number; model: string } | null;
}

function safetyJob(ctx: JobContext) {
  return { jobId: ctx.jobId, runId: ctx.runId, workspaceId: ctx.workspaceId, userId: ctx.createdBy, spec: ctx.spec };
}

/**
 * `store`: copies outputs to R2 right away (provider URLs expire), makes
 * thumbnails, runs the D-005 post-check over what was stored, then registers
 * assets with their content rating. A blocked output is deleted from R2 and
 * never registered; the job fails and its hold is released.
 */
export async function storeOutputs(env: Env, ctx: JobContext, status: JobStatus, modelId: string): Promise<Stored> {
  // A repeat of this step after a crash reuses what it stored (already reviewed).
  const existing = await env.DB.prepare("SELECT id, rating, rating_confidence, rating_model FROM assets WHERE json_extract(meta, '$.jobId') = ? ORDER BY name")
    .bind(ctx.jobId)
    .all<{ id: string; rating: string | null; rating_confidence: number | null; rating_model: string | null }>();
  if (existing.results.length > 0) {
    const r = existing.results.find((x) => x.rating) ?? null;
    return { assetIds: existing.results.map((r) => r.id), kind: ctx.spec.kind, rating: r ? { rating: r.rating!, confidence: r.rating_confidence ?? 0, model: r.rating_model ?? "" } : null };
  }
  const main = status.outputs.filter((o) => o.kind === ctx.spec.kind);
  if (main.length === 0) fail("no_output", "The provider returned no output.");
  const poster = status.outputs.find((o) => o.kind === "thumbnail");
  const base = `ws/${ctx.workspaceId}/gen/${ctx.jobId}`;
  const now = Date.now();
  const written: string[] = [];
  const files: { key: string; meta: Record<string, unknown>; size: number; contentType: string }[] = [];
  const review: SafetyOutput[] = [];
  for (const [i, out] of main.entries()) {
    const file = await download(out.url);
    const ext = EXT[file.contentType] ?? (ctx.spec.kind === "video" ? "mp4" : "png");
    const key = `${base}/${i}.${ext}`;
    await env.MEDIA.put(key, file.body, { httpMetadata: { contentType: file.contentType } });
    written.push(key);
    const hash = await sha256OfBytes(file.body);
    const meta: Record<string, unknown> = { jobId: ctx.jobId, runId: ctx.runId, model: modelId };
    if (ctx.spec.kind === "image") {
      let thumb: ArrayBuffer | null = null;
      try {
        const info = await env.IMAGES.info(new Blob([file.body]).stream());
        if ("width" in info) Object.assign(meta, { width: info.width, height: info.height });
        thumb = await (await env.IMAGES.input(new Blob([file.body]).stream()).transform({ width: 480 }).output({ format: "image/webp" })).response().arrayBuffer();
        const thumbKey = `${base}/${i}.thumb.webp`;
        await env.MEDIA.put(thumbKey, thumb, { httpMetadata: { contentType: "image/webp" } });
        written.push(thumbKey);
        meta.thumbKey = thumbKey;
      } catch (err) {
        // Images binding unavailable (local tests): the original serves as its own thumbnail.
        console.warn(JSON.stringify({ msg: "runs: thumbnail failed", jobId: ctx.jobId, error: String(err) }));
      }
      const picture = (await pictureDataUrl(env, file.body, file.contentType)) ?? out.url;
      review.push({ kind: "image", url: picture, hash });
    } else {
      let frame: string | null = null;
      if (poster && i === 0) {
        try {
          const p = await download(poster.url);
          const thumbKey = `${base}/poster.${EXT[p.contentType] ?? "jpg"}`;
          await env.MEDIA.put(thumbKey, p.body, { httpMetadata: { contentType: p.contentType } });
          written.push(thumbKey);
          meta.thumbKey = thumbKey;
          frame = await pictureDataUrl(env, p.body, p.contentType);
        } catch (err) {
          console.warn(JSON.stringify({ msg: "runs: poster failed", jobId: ctx.jobId, error: String(err) }));
        }
      }
      review.push({ kind: "video", frames: frame ? [frame] : [], hash });
    }
    if (ctx.spec.kind === "video" && ctx.spec.seconds) meta.durationSec = ctx.spec.seconds;
    files.push({ key, meta, size: file.body.byteLength, contentType: file.contentType });
  }

  const checked = await jobPostCheck(env, safetyJob(ctx), review);
  if (checked.error) {
    await env.MEDIA.delete(written);
    fail(checked.error.code, checked.error.message);
  }
  const rating = checked.verdict.rating ?? null;
  // D-005 visibility follows the rating; unrated outputs keep the run's mature flag.
  const mature = rating ? isMatureRating(rating.rating) : ctx.spec.mature;
  const assetIds: string[] = [];
  for (const [i, f] of files.entries()) {
    const assetId = newId("asset");
    await env.DB.prepare(
      "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, project_id, created_by, created_at, status, mature, size, content_type, rating, rating_confidence, rating_model) VALUES (?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        assetId,
        ctx.workspaceId,
        ctx.spec.kind,
        main.length > 1 ? `${ctx.title} ${i + 1}` : ctx.title,
        f.key,
        JSON.stringify(f.meta),
        ctx.projectId,
        ctx.createdBy,
        now + i,
        mature ? 1 : 0,
        f.size,
        f.contentType,
        rating?.rating ?? null,
        rating?.confidence ?? null,
        rating?.model ?? null,
      )
      .run();
    assetIds.push(assetId);
  }
  return { assetIds, kind: ctx.spec.kind, rating };
}

/** Credits actually charged: the provider's cost through creditsFor (D-006), else the quoted price for the model used. */
export async function actualCredits(env: Env, ctx: JobContext, status: JobStatus, modelId: string): Promise<number> {
  if (status.costUsd !== null && Number.isFinite(status.costUsd)) return creditsForUsd(status.costUsd);
  if (modelId === ctx.modelId) return ctx.credits;
  try {
    const model = await modelFor(env, modelId);
    return creditsFor(model, priceRequestOf(ctx.spec, model));
  } catch {
    return ctx.credits;
  }
}

/** `commit`: new active version (broadcasts), settle, Activity row, pushes. */
export async function commitJob(env: Env, ctx: JobContext, stored: Stored, prepared: Prepared, status: JobStatus, modelId: string): Promise<{ spent: number; version: number | null }> {
  const p = ports(env);
  let version: number | null = null;
  if (ctx.projectId && ctx.nodeId) {
    const room = p.room(ctx.projectId);
    // The postCheck's rating is stored on the version (ProjectRoom `node_versions.rating`) and kept in `output.rating` for older readers.
    const r = await room.addVersion({
      nodeId: ctx.nodeId,
      assetId: stored.assetIds[0] ?? null,
      inputDigest: prepared.digest,
      model: modelId,
      jobId: ctx.jobId,
      output: { assetIds: stored.assetIds, rating: stored.rating?.rating ?? null },
      rating: stored.rating?.rating ?? null,
    });
    if (!isRoomError(r)) {
      version = r.version.n;
      await quietly("job.done", () => room.broadcast("job.done", { jobId: ctx.jobId, nodeId: ctx.nodeId, version: { n: r.version.n, total: r.version.n }, assetId: stored.assetIds[0] ?? null }));
    }
  }
  const actual = await actualCredits(env, ctx, status, modelId);
  const settled = await p.credits(ctx.workspaceId).settle(ctx.jobId, actual, `settle:${ctx.jobId}`);
  let spent = Math.min(actual, ctx.credits);
  if (settled.ok) spent = settled.value.spent;
  else if (settled.error.code !== "JOB_CLOSED") throw new Error(`settle failed: ${settled.error.code}`);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = 'succeeded', progress = 1, cost_actual = ?, asset_id = ?, model = ?, finished_at = ?, updated_at = ? WHERE id = ?").bind(
      spent,
      stored.assetIds[0] ?? null,
      modelId,
      now,
      now,
      ctx.jobId,
    ),
    env.DB.prepare("UPDATE run_items SET status = 'succeeded', updated_at = ? WHERE run_id = ? AND ref = ?").bind(now, ctx.runId, ctx.ref),
  ]);
  await refreshRun(env.DB, ctx.runId, now);
  if (settled.ok) await pushCredits(env, { created_by: ctx.createdBy, project_id: ctx.projectId, workspace_id: ctx.workspaceId }, settled.value.balance);
  await quietly("activity", () => p.hub(ctx.createdBy).broadcast("activity.updated", { runId: ctx.runId, jobId: ctx.jobId }));
  return { spent, version };
}

/** Failure: release the hold (refund), node shows failed with the refund, Activity row. */
export async function failJob(env: Env, ctx: JobContext, error: JobError): Promise<{ refunded: number }> {
  const p = ports(env);
  const released = await p.credits(ctx.workspaceId).release(ctx.jobId, error.code, `release:${ctx.jobId}`);
  const refunded = released.ok ? released.value.refunded : 0;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = 'failed', refunded = ?, error_code = ?, error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?").bind(
      released.ok ? 1 : 0,
      error.code,
      error.message.slice(0, 500),
      now,
      now,
      ctx.jobId,
    ),
    env.DB.prepare("UPDATE run_items SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ? AND ref = ? AND status != 'canceled'").bind(
      error.code,
      error.message.slice(0, 500),
      now,
      ctx.runId,
      ctx.ref,
    ),
  ]);
  if (ctx.projectId && ctx.nodeId) {
    const room = p.room(ctx.projectId);
    await quietly("markFailed", () => room.markFailed({ nodeId: ctx.nodeId!, jobId: ctx.jobId, refunded, reason: error.message }));
  }
  await refreshRun(env.DB, ctx.runId, now);
  if (released.ok) await pushCredits(env, { created_by: ctx.createdBy, project_id: ctx.projectId, workspace_id: ctx.workspaceId }, released.value.balance);
  await quietly("activity", () => p.hub(ctx.createdBy).broadcast("activity.updated", { runId: ctx.runId, jobId: ctx.jobId }));
  return { refunded };
}

/** The Auto retry (D-009): the next fallback model that fits under the same hold. */
export async function nextFallback(env: Env, ctx: JobContext, tried: readonly string[]): Promise<string | null> {
  if (ctx.spec.fallbacks.length === 0) return null;
  const catalog = await loadCatalog(env);
  for (const id of ctx.spec.fallbacks) {
    if (tried.includes(id)) continue;
    const model = catalog.get(id);
    if (!model) continue;
    try {
      if (creditsFor(model, priceRequestOf(ctx.spec, model)) <= ctx.credits) return id;
    } catch {
      // Unpriced: skip.
    }
  }
  return null;
}

/** After a job ends: start dependents of this run and anything waiting for a slot. */
export async function advanceAfter(env: Env, ctx: JobContext): Promise<void> {
  await advanceRun(env, ctx.runId);
  await advanceWorkspace(env, ctx.workspaceId, ctx.runId);
}
