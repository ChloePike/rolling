/**
 * Remix shot frames: the reference video's frame at a shot's start, made by
 * the FFmpeg container (`/frames`) and stored in R2
 * (`ws/<workspace>/frames/<assetId>/<ms>.png`, reused by later runs). With R2 S3
 * credentials the container `PUT`s the PNG straight to a presigned URL (like
 * exports); without them (local dev, tests) it answers with the PNG and the
 * Worker stores it. Unreachable container → null (the caller falls back to
 * the poster frame).
 */
import { keyBelongsTo } from "@rolling/core/media";
import { presignPut, s3Config } from "../lib/r2s3";
import { signMediaUrl } from "../lib/mediaUrls";
import { container, ContainerUnavailable } from "../queues/mediaProcess";

const FRAME_WIDTH = 1280;
const URL_TTL = 900;

type ContainerCall = (env: Env, path: string, body: unknown) => Promise<Response>;
let call: ContainerCall = container;

/** Tests: replace the container call (null restores the real one). */
export function setFramesContainerForTests(fn: ContainerCall | null): void {
  call = fn ?? container;
}

/** R2 key of a video's frame at `atSec` (millisecond precision). */
export function frameKey(workspaceId: string, assetId: string, atSec: number): string {
  return `ws/${workspaceId}/frames/${assetId}/${Math.round(atSec * 1000)}.png`;
}

export interface VideoRow {
  id: string;
  r2_key: string;
  workspace_id: string;
}

/** The frame's R2 key, extracting it when missing; null when the container can't make it. */
export async function ensureFrame(env: Env, video: VideoRow, atSec: number): Promise<string | null> {
  const key = frameKey(video.workspace_id, video.id, atSec);
  if (!keyBelongsTo(key, video.workspace_id)) return null;
  if (await env.MEDIA.head(key)) return key;
  const url = await signMediaUrl(env, video.r2_key, { workspaceId: video.workspace_id, expiresIn: URL_TTL, absolute: true });
  const cfg = s3Config(env);
  try {
    if (cfg) {
      const put = await presignPut(cfg, key, URL_TTL);
      await call(env, "/frames", { url, times: [atSec], puts: [put], width: FRAME_WIDTH });
      if (!(await env.MEDIA.head(key))) throw new Error("frame was not stored");
    } else {
      const res = await call(env, "/frames", { url, times: [atSec], width: FRAME_WIDTH });
      await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
    }
    return key;
  } catch (err) {
    console.warn(JSON.stringify({ msg: err instanceof ContainerUnavailable ? "frames: container unavailable" : "frames: extraction failed", key, error: String(err) }));
    return null;
  }
}
