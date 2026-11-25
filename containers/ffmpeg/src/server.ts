/**
 * Tiny HTTP server inside the FFmpeg container.
 * /health; /probe, /thumb, /waveform (M3, media.process) take `{ url }` of a
 * signed media URL and read the input over HTTP; /render (exports) runs a
 * render job in the background (render.ts, graph.ts):
 * `POST /render` job → 202 state; `GET /render/:id` → state;
 * `GET /render/:id/file` → the MP4 when the job had no `putUrl`;
 * `DELETE /render/:id`. /frames and /scenes (Remix shots, frames.ts): PNG
 * frames at given times PUT to presigned URLs, and detected scene cuts.
 * Must stay erasable TypeScript (no enums/namespaces) so Node can strip types.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { Renderer, RenderError, validateJob } from "./render.ts";
import { endFrameArgs, FramesError, frameArgs, isPng, parseSceneCuts, sceneArgs, validateFrames } from "./frames.ts";

const PORT = Number(process.env.PORT ?? 8080);
const MEDIA_ROUTES = new Set(["/probe", "/thumb", "/waveform", "/frames", "/scenes"]);
const MAX_OUTPUT = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : (stdout.split("\n")[0] ?? null));
    });
  });
}

function readJson(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => {
      try {
        if (size > limit) return resolve(null);
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function run(cmd: string, args: string[], timeout = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: MAX_OUTPUT, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr).slice(-500) || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Runs a command for its log (stderr), e.g. ffmpeg filters that report through `showinfo`. */
function runLog(cmd: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr).slice(-500) || err.message}`));
      else resolve(String(stderr));
    });
  });
}

/** One PNG at `at`; a time at or past the end falls back to the last second of the clip. */
async function framePng(url: string, at: number, width: number | null): Promise<Buffer> {
  for (const args of [frameArgs(url, at, width), endFrameArgs(url, 1, width), endFrameArgs(url, 3, width), frameArgs(url, 0, width)]) {
    const png = await run("ffmpeg", args);
    if (isPng(png)) return png;
  }
  throw new FramesError("NO_FRAME", "No frame at that time");
}

async function putPng(url: string, png: Buffer): Promise<void> {
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(png), headers: { "content-type": "image/png", "content-length": String(png.length) } });
  if (!res.ok) throw new FramesError("upload_failed", `Storage answered ${res.status}`);
}

async function frames(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  let req;
  try {
    req = validateFrames(body);
  } catch (err) {
    if (err instanceof FramesError) return sendJson(res, 400, { error: { code: err.code, message: err.message, data: {} } });
    throw err;
  }
  if (!req.puts) {
    const png = await framePng(req.url, req.times[0]!, req.width);
    res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
    res.end(png);
    return;
  }
  const out: { at: number; size: number; uploaded: boolean }[] = [];
  for (const [i, at] of req.times.entries()) {
    const png = await framePng(req.url, at, req.width);
    await putPng(req.puts[i]!, png);
    out.push({ at, size: png.length, uploaded: true });
  }
  sendJson(res, 200, { frames: out });
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Duration, size and audio presence from ffprobe. */
export async function probe(url: string) {
  const out = JSON.parse(
    (await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url])).toString("utf8"),
  ) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; codec_name?: string; disposition?: { attached_pic?: number } }[] };
  const video = out.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = out.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(out.format?.duration);
  return {
    durationSec: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: !!audio,
    hasVideo: !!video,
  };
}

/** Peak envelope (0..1) in `points` buckets from mono 8 kHz PCM. */
export function peaks(pcm: Buffer, points: number): number[] {
  const samples = Math.floor(pcm.length / 2);
  const out: number[] = [];
  const per = Math.max(1, Math.floor(samples / points));
  for (let p = 0; p < points && p * per < samples; p++) {
    let max = 0;
    const end = Math.min(samples, (p + 1) * per);
    for (let i = p * per; i < end; i++) max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)));
    out.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return out;
}

async function media(path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const url = body.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "url must be an http(s) URL", data: {} } });
    return;
  }
  if (path === "/probe") {
    sendJson(res, 200, await probe(url));
    return;
  }
  if (path === "/frames") return frames(body, res);
  if (path === "/scenes") {
    const threshold = num(body.threshold, 0.3, 0.05, 0.95);
    const max = Math.round(num(body.max, 50, 1, 50));
    sendJson(res, 200, { threshold, cuts: parseSceneCuts(await runLog("ffmpeg", sceneArgs(url, threshold), 300_000), max) });
    return;
  }
  if (path === "/thumb") {
    const width = Math.round(num(body.width, 512, 16, 2048));
    const at = num(body.at, 1, 0, 36000);
    const jpg = await run("ffmpeg", ["-v", "error", "-ss", String(at), "-i", url, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2", "-c:v", "mjpeg", "pipe:1"]);
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpg.length });
    res.end(jpg);
    return;
  }
  const points = Math.round(num(body.points, 400, 16, 4000));
  const pcm = await run("ffmpeg", ["-v", "error", "-i", url, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], 300_000);
  sendJson(res, 200, { points, durationSec: pcm.length / 2 / 8000, peaks: peaks(pcm, points) });
}

export const renderer = new Renderer({ probe, concurrency: Number(process.env.RENDER_CONCURRENCY ?? 2) });

async function renderRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === "/render") {
    if (req.method !== "POST") return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST", data: {} } });
    const body = await readJson(req, 8 * 1024 * 1024);
    if (!body) return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Body must be JSON", data: {} } });
    try {
      return sendJson(res, 202, renderer.start(validateJob(body)));
    } catch (err) {
      if (err instanceof RenderError) return sendJson(res, 400, { error: { code: err.code, message: err.message, data: {} } });
      throw err;
    }
  }
  const m = /^\/render\/([A-Za-z0-9_-]{1,64})(\/file)?$/.exec(path);
  if (!m) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found", data: { path } } });
  const id = m[1]!;
  if (m[2]) {
    if (req.method !== "GET") return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET", data: {} } });
    const file = renderer.filePath(id);
    if (!file) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "No file for this render", data: {} } });
    res.writeHead(200, { "content-type": "video/mp4", "content-length": file.size });
    createReadStream(file.path).pipe(res);
    return;
  }
  if (req.method === "DELETE") return sendJson(res, 200, { ok: await renderer.remove(id) });
  if (req.method !== "GET") return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or DELETE", data: {} } });
  const state = renderer.get(id);
  if (!state) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "No such render", data: {} } });
  sendJson(res, 200, state);
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://container").pathname;
  if (path === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ffmpeg: await ffmpegVersion() });
    return;
  }
  if (MEDIA_ROUTES.has(path)) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST", data: {} } });
      return;
    }
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Body must be JSON", data: {} } });
      return;
    }
    try {
      await media(path, body, res);
    } catch (err) {
      sendJson(res, 422, { error: { code: "MEDIA_FAILED", message: String(err instanceof Error ? err.message : err).slice(0, 500), data: {} } });
    }
    return;
  }
  if (path === "/render" || path.startsWith("/render/")) {
    await renderRoute(req, res, path);
    return;
  }
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found", data: { path } } });
}

export function start(port = PORT) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(JSON.stringify({ msg: "request failed", error: String(err) }));
      if (!res.headersSent) sendJson(res, 500, { error: { code: "INTERNAL", message: "Internal error", data: {} } });
    });
  });
  server.listen(port, () => console.log(JSON.stringify({ msg: "ffmpeg server listening", port })));
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

if (process.env.FFMPEG_SERVER_NO_LISTEN !== "1") start();
