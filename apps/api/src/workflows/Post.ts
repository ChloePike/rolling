/**
 * PostWorkflow (D-033, D-034): one instance per `post_jobs` row (instance id =
 * job id). Captions / transcript: audio-only render in the FFmpeg container
 * (mono 16 kHz MP3 chunks) → Workers AI Whisper per chunk (language detected)
 * → transcript JSON in R2 → cues on the caption track (captions) and the
 * transcript on the voiceover asset. Resize: `/jobs` in the container
 * (Lanczos + mild sharpen) → new asset (+ node version). Failures mark the job
 * failed; nothing here costs credits.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { newId } from "@rolling/core/ids";
import { captionPatchOps, captionTrackOf, cuesFromTranscript, mergeTranscripts, parseWhisper, type Transcript } from "@rolling/core/post";
import { applyOps, type Edl } from "@rolling/core/timeline";
import type { RenderJob } from "@rolling/core/export";
import { renderer, type RenderState } from "../exports/renderer";
import { projectRoom } from "../lib/access";
import { presignPut, s3Config } from "../lib/r2s3";
import { signMediaUrl } from "../lib/mediaUrls";
import { CAPTION_CHUNK_SECONDS, loadPostJob, postJobDir, setPostJob, signInputs, type CaptionParams, type PostJobRow, type ResizeParams } from "../post/jobs";
import { editTimeline } from "../post/timeline";
import { toBase64, whisper } from "../post/seams";

export interface PostWorkflowParams {
  jobId: string;
}

const RETRY = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;
const AI_RETRY = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const MAX_POLLS = 240;

class PostFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function guard<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PostFailure) throw new NonRetryableError(JSON.stringify({ code: err.code, message: err.message }), "PostFailure");
      throw err;
    }
  };
}

function failureOf(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const start = message.indexOf("{");
  if (start !== -1) {
    try {
      const p = JSON.parse(message.slice(start)) as { code?: unknown; message?: unknown };
      if (typeof p.code === "string" && typeof p.message === "string") return { code: p.code, message: p.message };
    } catch {
      // Not ours.
    }
  }
  return { code: "internal", message: "This step failed. Try again." };
}

function container(env: Env) {
  const r = renderer(env);
  if (!r) throw new PostFailure("renderer_unavailable", "The media service is not available right now. Try again in a few minutes.");
  return r;
}

async function errorOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: { message?: string } }).error?.message ?? `status ${res.status}`;
  } catch {
    return `status ${res.status}`;
  }
}

export class PostWorkflow extends WorkflowEntrypoint<Env, PostWorkflowParams> {
  override async run(event: WorkflowEvent<PostWorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const row = await step.do("load", RETRY, async () => loadPostJob(env, event.payload.jobId));
    if (!row) return { status: "missing" as const };
    if (row.status === "done" || row.status === "failed") return { status: row.status };
    try {
      await step.do("start", RETRY, async () => {
        await setPostJob(env, row.id, { status: "running", progress: 0.05 });
        return { ok: true };
      });
      const result = row.kind === "resize" ? await this.resize(row, step) : await this.captions(row, step);
      await step.do("done", RETRY, async () => {
        await setPostJob(env, row.id, { status: "done", progress: 1, result: JSON.stringify(result), finished_at: Date.now() });
        return { ok: true };
      });
      return { status: "done" as const };
    } catch (err) {
      const failure = failureOf(err);
      await step.do("fail", RETRY, async () => {
        await setPostJob(env, row.id, { status: "failed", error_code: failure.code, error_message: failure.message, finished_at: Date.now() });
        return { ok: true };
      });
      return { status: "failed" as const, code: failure.code };
    } finally {
      await step.do("cleanup", RETRY, async () => {
        const r = renderer(env);
        if (r) await r(row.kind === "resize" ? `/jobs/${row.id}` : `/render/${row.id}`, { method: "DELETE" }).catch(() => null);
        return { ok: true };
      }).catch(() => null);
    }
  }

  /** Polls a container job until done; failure states throw. */
  private async poll(row: PostJobRow, step: WorkflowStep, path: string, from: number, to: number): Promise<RenderState> {
    const env = this.env;
    let interval = 2;
    for (let i = 1; i <= MAX_POLLS; i++) {
      await step.sleep(`wait-${i}`, `${interval} seconds`);
      interval = Math.min(10, Math.ceil(interval * 1.5));
      const s = await step.do(`poll-${i}`, RETRY, guard(async () => {
        const res = await container(env)(path);
        if (res.status === 404) throw new PostFailure("render_lost", "The media service restarted. Try again.");
        if (!res.ok) throw new Error(`poll failed: ${await errorOf(res)}`);
        const state = (await res.json()) as RenderState;
        if (state.status === "failed") throw new PostFailure(state.error?.code ?? "failed", state.error?.message ?? "The media service stopped.");
        await setPostJob(env, row.id, { progress: Math.round((from + (to - from) * Math.min(0.99, state.progress)) * 100) / 100 });
        return state;
      }));
      if (s.status === "done") return s;
    }
    throw new PostFailure("timeout", "This took too long. Try a shorter range.");
  }

  private async captions(row: PostJobRow, step: WorkflowStep): Promise<Record<string, unknown>> {
    const env = this.env;
    const p = JSON.parse(row.params) as CaptionParams;
    const duration = Math.max(0.1, p.range.end - p.range.start);
    await step.do("submit-audio", RETRY, guard(async () => {
      if (!whisper(env)) throw new PostFailure("captions_unavailable", "Captions are not available here right now.");
      const obj = await env.MEDIA.get(`${postJobDir(row)}/edl.json`);
      if (!obj) throw new PostFailure("missing_cut", "The audio to caption is missing. Start again.");
      const signed = await signInputs(env, row.workspace_id, (await obj.json()) as Edl);
      const job: RenderJob = { id: row.id, edl: signed.edl, width: 16, height: 16, fps: signed.edl.fps, duration, inputs: signed.inputs, audioOnly: { sampleRate: 16000, chunkSeconds: CAPTION_CHUNK_SECONDS } };
      const res = await container(env)("/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
      if (res.status === 400 || res.status === 422) throw new PostFailure("render_refused", await errorOf(res));
      if (!res.ok) throw new Error(`audio submit failed: ${await errorOf(res)}`);
      return { ok: true };
    }));
    const done = await this.poll(row, step, `/render/${encodeURIComponent(row.id)}`, 0.05, 0.4);
    const parts = (done.result as { parts?: number } | undefined)?.parts ?? 0;
    if (parts < 1) throw new PostFailure("no_audio", "There is no sound to caption here.");
    const transcripts: Transcript[] = [];
    for (let i = 0; i < parts; i++) {
      const t = await step.do(`transcribe-${i}`, AI_RETRY, guard(async () => {
        const res = await container(env)(`/render/${encodeURIComponent(row.id)}/file?part=${i}`);
        if (res.status === 404) throw new PostFailure("render_lost", "The media service restarted. Try again.");
        if (!res.ok) throw new Error(`audio part failed: ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const raw = await whisper(env)!({ audio: toBase64(bytes), ...(p.language && { language: p.language }) });
        const parsed = parseWhisper(raw, i * CAPTION_CHUNK_SECONDS);
        await setPostJob(env, row.id, { progress: Math.round((0.4 + (0.5 * (i + 1)) / parts) * 100) / 100 });
        return JSON.stringify(parsed);
      }));
      transcripts.push(JSON.parse(t) as Transcript);
    }
    const transcript = mergeTranscripts(transcripts);
    const language = p.language ?? transcript.language;
    const stored = await step.do("store-transcript", RETRY, async () => {
      const key = `${postJobDir(row)}/transcript.json`;
      // Times are relative to the transcribed range; the timeline start is `range.start`.
      await env.MEDIA.put(key, JSON.stringify({ ...transcript, language, offset: p.range.start }), { httpMetadata: { contentType: "application/json" } });
      if (p.transcriptAssetId) await saveAssetTranscript(env, p.transcriptAssetId, row.workspace_id, { key, language, text: transcript.text, durationSec: transcript.duration ?? duration });
      return { key };
    });
    let cues = 0;
    if (row.kind === "captions") {
      cues = await step.do("apply", RETRY, guard(async () => {
        const caller = { userId: row.created_by, workspaceId: row.workspace_id, canEdit: true };
        let count = 0;
        await editTimeline(env, row.project_id!, row.canvas_id!, caller, ({ edl }) => {
          const list = cuesFromTranscript(transcript, { ...(p.style && { style: p.style }), offset: p.range.start, until: p.range.end });
          count = list.length;
          let base = edl;
          let track = captionTrackOf(edl);
          if (!track) {
            base = { ...edl, tracks: [{ id: "C1", kind: "caption", clips: [] }, ...edl.tracks] };
            track = { id: "C1" };
          }
          const ops = captionPatchOps(base, track.id, list, { replace: p.replace, range: p.range, ...(p.style && { style: p.style }), lang: language ?? null });
          if (base === edl) return ops.length ? { ops } : null;
          const applied = applyOps(base, ops);
          if (!applied.ok) throw new PostFailure("timeline_invalid", applied.error);
          return { edl: applied.edl };
        });
        return count;
      }));
    }
    return { language, languageProbability: transcript.languageProbability ?? null, cues, audioSeconds: duration, transcriptKey: stored.key, text: transcript.text.slice(0, 4000) };
  }

  private async resize(row: PostJobRow, step: WorkflowStep): Promise<Record<string, unknown>> {
    const env = this.env;
    const p = JSON.parse(row.params) as ResizeParams;
    const ext = p.media === "image" ? "png" : "mp4";
    const key = `${postJobDir(row)}/resized.${ext}`;
    const submitted = await step.do("submit-resize", RETRY, guard(async () => {
      const a = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ? AND workspace_id = ?").bind(row.asset_id, row.workspace_id).first<{ r2_key: string }>();
      if (!a) throw new PostFailure("missing_source", "The original is gone.");
      const url = await signMediaUrl(env, a.r2_key, { workspaceId: row.workspace_id, expiresIn: 4 * 3600, absolute: true });
      const cfg = s3Config(env);
      const putUrl = cfg ? await presignPut(cfg, key, 4 * 3600) : undefined;
      const body = { id: row.id, kind: "resize", media: p.media, url, short: p.short, ...(p.durationSec && { duration: p.durationSec }), ...(putUrl && { putUrl }) };
      const res = await container(env)("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 400) throw new PostFailure("resize_refused", await errorOf(res));
      if (!res.ok) throw new Error(`resize submit failed: ${await errorOf(res)}`);
      return { uploaded: !!putUrl };
    }));
    const done = await this.poll(row, step, `/jobs/${encodeURIComponent(row.id)}`, 0.05, 0.9);
    const result = done.result as unknown as { size: number; width: number | null; height: number | null; durationSec: number | null; uploaded: boolean; contentType: string };
    await step.do("store-resized", RETRY, guard(async () => {
      if (!submitted.uploaded || !result.uploaded) {
        const res = await container(env)(`/jobs/${encodeURIComponent(row.id)}/file`);
        if (!res.ok) throw new PostFailure("render_lost", "The media service restarted. Try again.");
        await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: result.contentType } });
      }
      if (!(await env.MEDIA.head(key))) throw new PostFailure("upload_missing", "The file did not reach storage. Try again.");
      return { ok: true };
    }));
    return step.do("register-resized", RETRY, guard(async () => registerResized(env, row, p, key, result)));
  }
}

async function saveAssetTranscript(env: Env, assetId: string, workspaceId: string, t: { key: string; language: string | null; text: string; durationSec: number }): Promise<void> {
  const a = await env.DB.prepare("SELECT meta FROM assets WHERE id = ? AND workspace_id = ?").bind(assetId, workspaceId).first<{ meta: string | null }>();
  if (!a) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = a.meta ? (JSON.parse(a.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  meta.transcript = { key: t.key, language: t.language, text: t.text.slice(0, 4000), durationSec: t.durationSec, at: Date.now() };
  await env.DB.prepare("UPDATE assets SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), assetId).run();
}

/** The resized file as a new asset (same kind, source and mature flag), and the node's new version when asked. */
async function registerResized(env: Env, row: PostJobRow, p: ResizeParams, key: string, result: { size: number; width: number | null; height: number | null; durationSec: number | null; contentType: string }) {
  const src = await env.DB.prepare("SELECT kind, source, name, meta, mature, project_id FROM assets WHERE id = ?").bind(row.asset_id).first<{ kind: string; source: string; name: string; meta: string | null; mature: number | null; project_id: string | null }>();
  if (!src) throw new PostFailure("missing_source", "The original is gone.");
  const existing = (await loadPostJob(env, row.id))?.result;
  const prior = existing ? (JSON.parse(existing) as { assetId?: string }).assetId : undefined;
  const assetId = prior ?? newId("asset");
  let srcMeta: Record<string, unknown> = {};
  try {
    srcMeta = src.meta ? (JSON.parse(src.meta) as Record<string, unknown>) : {};
  } catch {
    srcMeta = {};
  }
  const meta: Record<string, unknown> = {
    width: result.width,
    height: result.height,
    ...(result.durationSec !== null && { durationSec: result.durationSec }),
    hasAudio: srcMeta.hasAudio,
    derivedFrom: row.asset_id,
    resize: { target: p.target, method: "lanczos+unsharp", ai: false },
    processing: "done",
    ...(p.media === "image" && { thumbKey: srcMeta.thumbKey }),
    ...(p.media === "video" && typeof srcMeta.thumbKey === "string" && { thumbKey: srcMeta.thumbKey }),
  };
  await setPostJob(env, row.id, { result: JSON.stringify({ assetId }) });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO assets (id, workspace_id, kind, source, name, r2_key, meta, project_id, created_by, created_at, status, mature, size, content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
  )
    .bind(assetId, row.workspace_id, src.kind, src.source, `${src.name} (${p.target})`.slice(0, 200), key, JSON.stringify(meta), src.project_id, row.created_by, Date.now(), src.mature ?? 0, result.size, result.contentType)
    .run();
  let version: number | null = null;
  if (p.projectId && p.nodeId) {
    const room = projectRoom(env, p.projectId);
    const caller = { userId: row.created_by, workspaceId: row.workspace_id, canEdit: true };
    const digest = await room.inputDigest(caller, p.nodeId);
    if ("digest" in digest) {
      const job = await env.DB.prepare("SELECT model FROM jobs WHERE asset_id = ? LIMIT 1").bind(row.asset_id).first<{ model: string | null }>();
      const r = await room.addVersion({ nodeId: p.nodeId, assetId, inputDigest: digest.digest, model: job?.model ?? null, output: { assetIds: [assetId], resize: p.target } });
      if (r.ok) version = r.version.n;
    }
  }
  return { assetId, target: p.target, width: result.width, height: result.height, version };
}
