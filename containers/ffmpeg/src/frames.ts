/**
 * Still frames and scene cuts of a video (Remix shots):
 * - `/frames { url, times: [s…], puts?: [url…], width? }` → one PNG per time,
 *   `PUT` to the matching presigned R2 URL (like exports). Without `puts` and
 *   with exactly one time, the PNG is the response body (local dev, tests).
 * - `/scenes { url, threshold?, max? }` → `{ cuts: [s…] }`, the times where
 *   ffmpeg's scene score exceeds the threshold (shot boundaries to propose).
 * Pure builders and parsers here; the server wires them to ffmpeg.
 */

export const MAX_FRAMES = 12;
export const MAX_SCENE_CUTS = 50;

export class FramesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface FramesRequest {
  url: string;
  times: number[];
  puts: string[] | null;
  width: number | null;
}

const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);

/** Validates a `/frames` body. */
export function validateFrames(body: Record<string, unknown>): FramesRequest {
  if (!isHttp(body.url)) throw new FramesError("BAD_REQUEST", "url must be an http(s) URL");
  const times = body.times;
  if (!Array.isArray(times) || times.length === 0 || times.length > MAX_FRAMES) throw new FramesError("BAD_REQUEST", `times must hold 1 to ${MAX_FRAMES} seconds`);
  if (!times.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 36_000)) throw new FramesError("BAD_REQUEST", "times must be seconds from 0 to 36000");
  let puts: string[] | null = null;
  if (body.puts !== undefined) {
    if (!Array.isArray(body.puts) || body.puts.length !== times.length || !body.puts.every(isHttp)) throw new FramesError("BAD_REQUEST", "puts must hold one http(s) URL per time");
    puts = body.puts as string[];
  } else if (times.length !== 1) throw new FramesError("BAD_REQUEST", "Without puts, ask for one frame");
  let width: number | null = null;
  if (body.width !== undefined) {
    if (typeof body.width !== "number" || !Number.isInteger(body.width) || body.width < 16 || body.width > 4096) throw new FramesError("BAD_REQUEST", "width must be 16 to 4096");
    width = body.width;
  }
  return { url: body.url, times: times as number[], puts, width };
}

/**
 * ffmpeg arguments for one PNG frame at `at` seconds, to stdout. Input seeking
 * (`-ss` before `-i`) is fast and frame-accurate for re-encoded output; `at`
 * past the end yields no frame (the caller then retries slightly earlier).
 */
export function frameArgs(url: string, at: number, width: number | null): string[] {
  return [
    "-v", "error",
    "-ss", at.toFixed(3),
    "-i", url,
    "-frames:v", "1",
    ...(width ? ["-vf", `scale=${width}:-2`] : []),
    "-f", "image2",
    "-c:v", "png",
    "pipe:1",
  ];
}

/** Like `frameArgs`, for a frame `fromEnd` seconds before the end of the clip (`-sseof`). */
export function endFrameArgs(url: string, fromEnd: number, width: number | null): string[] {
  const args = frameArgs(url, 0, width);
  args.splice(2, 2, "-sseof", (-Math.abs(fromEnd)).toFixed(3));
  return args;
}

/** ffmpeg arguments that log a `showinfo` line (with `pts_time`) per frame whose scene score exceeds `threshold`. */
export function sceneArgs(url: string, threshold: number): string[] {
  const t = Math.min(0.95, Math.max(0.05, threshold));
  return ["-v", "info", "-hide_banner", "-nostats", "-i", url, "-an", "-sn", "-vf", `scale=320:-2,select='gt(scene,${t})',showinfo`, "-f", "null", "-"];
}

/** Cut times (seconds, ascending, de-duplicated within 0.1 s) from ffmpeg's `showinfo` log. */
export function parseSceneCuts(log: string, max = MAX_SCENE_CUTS): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/\[Parsed_showinfo[^\]]*\][^\n]*?pts_time:\s*([0-9.]+)/g)) {
    const t = Math.round(Number(m[1]) * 100) / 100;
    if (!Number.isFinite(t) || t <= 0) continue;
    if (out.length && t - out[out.length - 1]! < 0.1) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a - b);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (b: Buffer): boolean => b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);
