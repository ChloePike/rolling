import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { newId } from "@rolling/core/ids";
import type { RenderJob } from "@rolling/core/export";
import { exportDir, exportFileName, exportView, ExportFailure, buildRenderJob, loadExport, notify, setStatus, EXPORT_URL_TTL_SECONDS, type ExportRow } from "../exports/service";
import { renderer, type RenderState } from "../exports/renderer";
import { signMediaUrl } from "../lib/mediaUrls";
import { rateAsset } from "../safety/service";

export interface ExportWorkflowParams {
  exportId: string;
}

const RETRY = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;
/** First poll after 2 s, then ×1.5 up to 15 s; give up after this many polls (≈ 1 h). */
const FIRST_WAIT_S = 2;
const MAX_WAIT_S = 15;
const MAX_POLLS = 260;
const POSTER_WIDTH = 512;

function guard<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ExportFailure) throw new NonRetryableError(JSON.stringify({ code: err.code, message: err.message }), "ExportFailure");
      throw err;
    }
  };
}

function failureOf(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const start = message.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(message.slice(start)) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string" && typeof parsed.message === "string") return { code: parsed.code, message: parsed.message };
    } catch {
      // Not ours.
    }
  }
  return { code: "internal", message: "The export failed. Try again." };
}

function render(env: Env) {
  const r = renderer(env);
  if (!r) throw new ExportFailure("renderer_unavailable", "The renderer is not available right now. Try again in a few minutes.");
  return r;
}

async function containerError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `status ${res.status}`;
  } catch {
    return `status ${res.status}`;
  }
}

/**
 * One instance per export (instance id = export id). Steps: prepare (signed
 * input URLs, presigned PUT) → submit `/render` → poll with backoff, relaying
 * `export.progress` → store (verify the object in R2, or pull the file from the
 * container when there was no presigned URL) → register the asset with a
 * poster frame and the safety rating → `export.done` with a signed download
 * URL. Any failure marks the export failed and sends `export.failed`. Free of
 * credits for now.
 */
export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  override async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const exportId = event.payload.exportId;
    const row = await step.do("load", RETRY, async () => loadExport(env, exportId));
    if (!row) return { status: "missing" as const };
    if (row.status === "done" || row.status === "failed") return { status: row.status };
    const key = `${exportDir(row)}/export.mp4`;

    try {
      const prepared = await step.do("prepare", RETRY, guard(async () => {
        const job = await buildRenderJob(env, row);
        const ids = Object.keys(job.inputs);
        let mature = false;
        if (ids.length) {
          const m = await env.DB.prepare(`SELECT MAX(mature) AS m FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).first<{ m: number | null }>();
          mature = m?.m === 1;
        }
        await setStatus(env, row.id, { status: "running", progress: 0 });
        await notify(env, row, "export.progress", { status: "running", progress: 0 });
        // Signed URLs cross the step boundary as JSON.
        return { job: JSON.stringify(job), mature };
      }));
      const job = JSON.parse(prepared.job) as RenderJob;

      await step.do("submit", RETRY, guard(async () => {
        let res: Response;
        try {
          res = await render(env)("/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
        } catch (err) {
          if (err instanceof ExportFailure) throw err;
          // Retried by the step; the last attempt's message names the cause.
          throw new Error(JSON.stringify({ code: "renderer_unavailable", message: "The renderer is not available right now. Try again in a few minutes." }));
        }
        if (res.status === 400 || res.status === 422) throw new ExportFailure("render_refused", await containerError(res));
        if (!res.ok) throw new Error(`render submit failed: ${await containerError(res)}`);
        return { ok: true };
      }));

      let done: RenderState | null = null;
      let interval = FIRST_WAIT_S;
      let lastProgress = 0;
      for (let i = 1; i <= MAX_POLLS && !done; i++) {
        await step.sleep(`wait-${i}`, `${interval} seconds`);
        interval = Math.min(MAX_WAIT_S, Math.ceil(interval * 1.5));
        const before = lastProgress;
        const state = await step.do(`poll-${i}`, RETRY, guard(async () => {
          const res = await render(env)(`/render/${encodeURIComponent(row.id)}`);
          if (res.status === 404) throw new ExportFailure("render_lost", "The renderer restarted during the export. Try again.");
          if (!res.ok) throw new Error(`render poll failed: ${await containerError(res)}`);
          const s = (await res.json()) as RenderState;
          if (s.status === "failed") throw new ExportFailure(s.error?.code ?? "render_failed", s.error?.message ?? "The renderer stopped.");
          const progress = Math.round(Math.min(0.99, Math.max(0, s.progress)) * 100) / 100;
          if (progress > before) {
            await setStatus(env, row.id, { progress });
            await notify(env, row, "export.progress", { status: "running", progress });
          }
          return { ...s, progress: Math.max(progress, before) };
        }));
        lastProgress = state.progress;
        if (state.status === "done") done = state;
      }
      if (!done?.result) throw new ExportFailure("timeout", "The export took too long. Try a shorter range.");
      const result = done.result;

      const stored = await step.do("store", RETRY, guard(async () => {
        if (!result.uploaded) {
          const res = await render(env)(`/render/${encodeURIComponent(row.id)}/file`);
          if (res.status === 404) throw new ExportFailure("render_lost", "The renderer restarted during the export. Try again.");
          if (!res.ok || !res.body) throw new Error(`render file failed: ${res.status}`);
          const len = Number(res.headers.get("content-length"));
          const body = Number.isFinite(len) && len > 0 ? res.body.pipeThrough(new FixedLengthStream(len)) : await res.arrayBuffer();
          await env.MEDIA.put(key, body, { httpMetadata: { contentType: "video/mp4", contentDisposition: `attachment; filename="${exportFileName(row)}"` } });
        }
        const head = await env.MEDIA.head(key);
        if (!head) throw new ExportFailure("upload_missing", "The file did not reach storage. Try again.");
        return { size: head.size };
      }));

      const registered = await step.do("register", RETRY, guard(async () => registerAsset(env, row, key, stored.size, result.durationSec ?? row.duration, prepared.mature)));

      await step.do("notify-done", RETRY, async () => {
        const fresh = (await loadExport(env, row.id))!;
        const view = await exportView(env, fresh, { mayViewMature: false });
        // Mature exports get no URL in the broadcast; viewers allowed to see them read GET /api/exports/:id.
        await notify(env, row, "export.done", { status: "done", progress: 1, assetId: registered.assetId, url: view.url, fileName: view.fileName, size: stored.size, duration: fresh.duration, urlExpiresIn: EXPORT_URL_TTL_SECONDS });
        return { ok: true };
      });
      await step.do("cleanup", RETRY, async () => {
        await render(env)(`/render/${encodeURIComponent(row.id)}`, { method: "DELETE" }).catch(() => null);
        return { ok: true };
      }).catch(() => null);
      return { status: "done" as const, assetId: registered.assetId, size: stored.size };
    } catch (err) {
      const failure = failureOf(err);
      await step.do("fail", RETRY, async () => {
        await setStatus(env, row.id, { status: "failed", error_code: failure.code, error_message: failure.message, finished_at: Date.now() });
        await notify(env, row, "export.failed", { status: "failed", code: failure.code, reason: failure.message });
        try {
          const r = renderer(env);
          if (r) await r(`/render/${encodeURIComponent(row.id)}`, { method: "DELETE" });
        } catch {
          // Best effort.
        }
        return { ok: true };
      });
      return { status: "failed" as const, code: failure.code };
    }
  }
}

/**
 * Poster frame from the container, the asset row (kind video, source generated,
 * mature when any input was), then the safety rating on the poster (D-005). A
 * hard-limit block fails the export and removes the file.
 */
async function registerAsset(env: Env, row: ExportRow, key: string, size: number, durationSec: number, mature: boolean): Promise<{ assetId: string }> {
  const dir = exportDir(row);
  const meta: Record<string, unknown> = { durationSec, width: row.width, height: row.height, exportId: row.id, processing: "done", hasAudio: true };
  try {
    const url = await signMediaUrl(env, key, { workspaceId: row.workspace_id, expiresIn: 900, absolute: true });
    const res = await render(env)("/thumb", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, width: POSTER_WIDTH, at: Math.min(1, durationSec / 2) }) });
    if (res.ok) {
      const thumbKey = `${dir}/poster.jpg`;
      await env.MEDIA.put(thumbKey, await res.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
      meta.thumbKey = thumbKey;
    }
  } catch (err) {
    console.warn(JSON.stringify({ msg: "exports: poster failed", exportId: row.id, error: String(err) }));
  }
  const project = await env.DB.prepare("SELECT title FROM projects WHERE id = ?").bind(row.project_id).first<{ title: string }>();
  // The id is stored before the insert so a retried step reuses it.
  const assetId = (await loadExport(env, row.id))?.asset_id ?? newId("asset");
  await setStatus(env, row.id, { asset_id: assetId });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO assets (id, workspace_id, kind, source, name, r2_key, meta, project_id, created_by, created_at, status, mature, size, content_type)
     VALUES (?, ?, 'video', 'generated', ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 'video/mp4')`,
  )
    .bind(assetId, row.workspace_id, `${project?.title ?? "Project"} export`, key, JSON.stringify(meta), row.project_id, row.created_by, Date.now(), mature ? 1 : 0, size)
    .run();
  await setStatus(env, row.id, { asset_id: assetId, r2_key: key, size, duration: durationSec });
  let blocked = false;
  try {
    blocked = (await rateAsset(env, assetId)).blocked;
  } catch (err) {
    console.error(JSON.stringify({ msg: "exports: rating failed, export left unrated", exportId: row.id, error: String(err) }));
  }
  if (blocked) {
    await env.MEDIA.delete([key, `${dir}/poster.jpg`]);
    throw new ExportFailure("SAFETY_BLOCKED", "This export can't be delivered: it breaks the content rules.");
  }
  await setStatus(env, row.id, { status: "done", progress: 1, finished_at: Date.now() });
  return { assetId };
}
