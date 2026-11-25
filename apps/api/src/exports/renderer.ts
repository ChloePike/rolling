/**
 * Calls into the FfmpegRenderer container for exports. One named instance
 * ("export") runs every render (wrangler `max_instances` is small; the server
 * renders several jobs at once). Tests swap in a fake with
 * `setRendererForTests`. `MEDIA_CONTAINER=off` means no renderer.
 *
 * Container contract (containers/ffmpeg/src/server.ts):
 * - `POST /render` RenderJob → `202 { id, status }` (same id again → its current state)
 * - `GET /render/:id` → `{ id, status: running|uploading|done|failed, progress, result?, error? }`
 * - `GET /render/:id/file` → the MP4 when the job had no `putUrl`
 * - `DELETE /render/:id` → drops the job and its files
 * - `POST /thumb { url, width, at }` → JPEG (poster frame)
 */
export type RendererFetch = (path: string, init?: RequestInit) => Promise<Response>;

let testRenderer: RendererFetch | null = null;

export function setRendererForTests(fake: RendererFetch | null): void {
  testRenderer = fake;
}

export function renderer(env: Env): RendererFetch | null {
  if (testRenderer) return testRenderer;
  if (env.MEDIA_CONTAINER === "off") return null;
  const stub = env.FFMPEG.get(env.FFMPEG.idFromName("export"));
  return (path, init) => stub.fetch(new Request(`http://container${path}`, init));
}

export interface RenderResult {
  durationSec: number | null;
  size: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** True when the container wrote the file to the presigned URL. */
  uploaded: boolean;
}

export interface RenderState {
  id: string;
  status: "running" | "uploading" | "done" | "failed";
  progress: number;
  result?: RenderResult;
  error?: { code: string; message: string };
}
