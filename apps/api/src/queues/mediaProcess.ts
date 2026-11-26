/**
 * `media-process` consumer (M3): probe, thumbnail and waveform for uploads.
 *
 * - Images: Cloudflare Images (`IMAGES`) for dimensions and a 512px WebP thumbnail;
 *   if the binding fails, the original serves as its own thumbnail.
 * - Video / audio: the FfmpegRenderer container (`/probe`, `/thumb`, `/waveform`,
 *   and `/scenes` for videos: `meta.sceneCuts`, proposed Remix shot boundaries),
 *   fed a short-lived signed URL of the object. If the container is not
 *   reachable (local dev without Docker, tests), the asset becomes `ready` with
 *   `meta.processing = "pending"` so it is usable; a later re-queue fills in
 *   thumbnails. `MEDIA_CONTAINER=off` skips the container (tests, local dev
 *   without Docker). Other failures retry (max_retries in wrangler) and then go to the DLQ.
 * - Safety (D-005): once an image is ready, or a video is ready with its poster,
 *   `rateAsset` stores its content rating (`assets.rating`, `mature`) and fails
 *   the asset on a hard-limit violation. Pending videos are rated when the
 *   re-queue (cron, `requeuePendingMedia`) fills in the poster.
 */
import { z } from "zod";
import { assetMeta, signMediaUrl, type AssetRow } from "../lib/mediaUrls";
import { rateAsset } from "../safety/service";

export const MediaProcessMessage = z.object({ assetId: z.string(), r2Key: z.string(), kind: z.string() });
export type MediaProcessMessage = z.infer<typeof MediaProcessMessage>;

const THUMB_WIDTH = 512;
const CONTAINER_TIMEOUT_MS = 60_000;

export class ContainerUnavailable extends Error {}

function dirOf(key: string): string {
  return key.slice(0, key.lastIndexOf("/"));
}

async function updateAsset(env: Env, id: string, status: AssetRow["status"], meta: Record<string, unknown>): Promise<void> {
  await env.DB.prepare("UPDATE assets SET status = ?, meta = ? WHERE id = ?").bind(status, JSON.stringify(meta), id).run();
}

async function processImage(env: Env, row: AssetRow, meta: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const info = await env.IMAGES.info((await env.MEDIA.get(row.r2_key))!.body);
    const dims = "width" in info ? { width: info.width, height: info.height } : {};
    const obj = await env.MEDIA.get(row.r2_key);
    if (!obj) throw new Error("object missing");
    const out = await env.IMAGES.input(obj.body).transform({ width: THUMB_WIDTH }).output({ format: "image/webp", quality: 80 });
    const thumbKey = `${dirOf(row.r2_key)}/thumb.webp`;
    await env.MEDIA.put(thumbKey, out.image(), { httpMetadata: { contentType: "image/webp" } });
    return { ...meta, ...dims, thumbKey, processing: "done" };
  } catch (err) {
    console.warn(JSON.stringify({ msg: "media-process: images binding failed, original is the thumbnail", assetId: row.id, error: String(err) }));
    return { ...meta, processing: "done" };
  }
}

/** POSTs JSON to the FFmpeg container; `ContainerUnavailable` when it is off, unreachable or not deployed. */
export async function container(env: Env, path: string, body: unknown, timeoutMs = CONTAINER_TIMEOUT_MS): Promise<Response> {
  if (env.MEDIA_CONTAINER === "off") throw new ContainerUnavailable("MEDIA_CONTAINER=off");
  let res: Response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = env.FFMPEG.get(env.FFMPEG.idFromName("media"));
    res = await Promise.race([
      stub.fetch(new Request(`http://container${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("container timeout")), timeoutMs);
      }),
    ]);
  } catch (err) {
    throw new ContainerUnavailable(String(err));
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 501 || res.status === 502 || res.status === 503) throw new ContainerUnavailable(`container answered ${res.status}`);
  if (!res.ok) throw new Error(`container ${path} failed: ${res.status}`);
  return res;
}

async function processAv(env: Env, row: AssetRow, meta: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ws = row.workspace_id ?? "_";
  const url = await signMediaUrl(env, row.r2_key, { workspaceId: ws, expiresIn: 900, absolute: true });
  const probe = (await (await container(env, "/probe", { url })).json()) as { durationSec?: number; width?: number; height?: number; hasAudio?: boolean };
  const next: Record<string, unknown> = { ...meta, ...probe };
  // The probed length replaces the browser-reported one; jobs quoted with the latter re-check it (`prepare`).
  if (typeof probe.durationSec === "number" && probe.durationSec > 0) next.durationSource = "probe";
  else if (meta.durationSource === "declared") next.durationSec = meta.durationSec;
  const dir = dirOf(row.r2_key);
  if (row.kind === "video") {
    const thumb = await container(env, "/thumb", { url, width: THUMB_WIDTH, at: Math.min(1, (probe.durationSec ?? 0) / 2) });
    const thumbKey = `${dir}/thumb.jpg`;
    await env.MEDIA.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: thumb.headers.get("content-type") ?? "image/jpeg" } });
    next.thumbKey = thumbKey;
    // Scene cuts propose Remix shot boundaries; cheap at 320 px, and optional.
    try {
      const scenes = (await (await container(env, "/scenes", { url, threshold: 0.3 })).json()) as { cuts?: unknown };
      if (Array.isArray(scenes.cuts)) next.sceneCuts = scenes.cuts.filter((c): c is number => typeof c === "number" && Number.isFinite(c)).slice(0, 50);
    } catch (err) {
      if (err instanceof ContainerUnavailable) throw err;
      console.warn(JSON.stringify({ msg: "media-process: scene detection failed", assetId: row.id, error: String(err) }));
    }
  }
  if (row.kind === "audio" || probe.hasAudio) {
    const wave = await container(env, "/waveform", { url, points: 400 });
    const waveformKey = `${dir}/waveform.json`;
    await env.MEDIA.put(waveformKey, await wave.arrayBuffer(), { httpMetadata: { contentType: "application/json" } });
    next.waveformKey = waveformKey;
  }
  next.processing = "done";
  return next;
}

/** Rates a ready upload (D-005). A classifier outage leaves it unrated (logged); it never fails processing. */
async function rateReady(env: Env, assetId: string): Promise<void> {
  try {
    const out = await rateAsset(env, assetId);
    if (out.blocked) console.warn(JSON.stringify({ msg: "media-process: upload blocked by safety", assetId }));
  } catch (err) {
    console.error(JSON.stringify({ msg: "media-process: rating failed, asset left unrated", assetId, error: String(err) }));
  }
}

export async function processAsset(env: Env, msg: MediaProcessMessage): Promise<"done" | "pending" | "skipped"> {
  const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(msg.assetId).first<AssetRow>();
  if (!row || row.r2_key !== msg.r2Key || row.status === "uploading") return "skipped";
  const meta = assetMeta(row);
  if (row.kind === "image") {
    await updateAsset(env, row.id, "ready", await processImage(env, row, meta));
    await rateReady(env, row.id);
    return "done";
  }
  if (row.kind === "video" || row.kind === "audio") {
    try {
      await updateAsset(env, row.id, "ready", await processAv(env, row, meta));
      if (row.kind === "video") await rateReady(env, row.id);
      return "done";
    } catch (err) {
      if (!(err instanceof ContainerUnavailable)) throw err;
      console.warn(JSON.stringify({ msg: "media-process: container unavailable, marked pending", assetId: row.id, error: err.message }));
      await updateAsset(env, row.id, "ready", { ...meta, processing: "pending" });
      return "pending";
    }
  }
  await updateAsset(env, row.id, "ready", { ...meta, processing: "done" });
  return "done";
}

export async function handleMediaProcess(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = MediaProcessMessage.safeParse(msg.body);
    if (!parsed.success) {
      console.warn(JSON.stringify({ queue: "media-process", msg: "invalid message dropped", id: msg.id }));
      msg.ack();
      continue;
    }
    try {
      await processAsset(env, parsed.data);
      msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ queue: "media-process", msg: "processing failed, will retry", assetId: parsed.data.assetId, error: String(err) }));
      msg.retry();
    }
  }
}

/** True when the FFmpeg container answers `/health` (never with `MEDIA_CONTAINER=off`). */
export async function containerReachable(env: Env, timeoutMs = 30_000): Promise<boolean> {
  if (env.MEDIA_CONTAINER === "off") return false;
  try {
    const stub = env.FFMPEG.get(env.FFMPEG.idFromName("media"));
    const res = await Promise.race([
      stub.fetch(new Request("http://container/health")),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("container timeout")), timeoutMs)),
    ]);
    return res.ok;
  } catch {
    return false;
  }
}

/** Uploads re-queued per cron run. */
const REQUEUE_BATCH = 50;

/**
 * Cron: re-queues `media.process` for video/audio uploads left `ready` with
 * `meta.processing = "pending"` (the container was down), once the container
 * answers again. The consumer fills in poster/waveform and rates the video.
 */
export async function requeuePendingMedia(env: Env, opts: { reachable?: (env: Env) => Promise<boolean> } = {}): Promise<{ requeued: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, r2_key, kind FROM assets
     WHERE status = 'ready' AND kind IN ('video','audio') AND json_extract(meta, '$.processing') = 'pending'
     ORDER BY created_at LIMIT ?`,
  )
    .bind(REQUEUE_BATCH)
    .all<{ id: string; r2_key: string; kind: string }>();
  if (!rows.results.length) return { requeued: 0 };
  if (!(await (opts.reachable ?? containerReachable)(env))) return { requeued: 0 };
  await env.MEDIA_PROCESS_QUEUE.sendBatch(rows.results.map((r) => ({ body: { assetId: r.id, r2Key: r.r2_key, kind: r.kind } satisfies MediaProcessMessage })));
  return { requeued: rows.results.length };
}
