/**
 * Tiny HTTP server inside the FFmpeg container.
 * /health; /probe, /thumb, /waveform (M3, media.process) take `{ url }` of a
 * signed media URL and read the input over HTTP; /render answers 501 until M7.
 * Must stay erasable TypeScript (no enums/namespaces) so Node can strip types.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8080);
const STUB_ROUTES = new Set(["/render"]);
const MEDIA_ROUTES = new Set(["/probe", "/thumb", "/waveform"]);
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 65536) chunks.push(c);
    });
    req.on("end", () => {
      try {
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

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Duration, size and audio presence from ffprobe. */
export async function probe(url: string) {
  const out = JSON.parse(
    (await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url])).toString("utf8"),
  ) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; codec_name?: string }[] };
  const video = out.streams?.find((s) => s.codec_type === "video");
  const audio = out.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(out.format?.duration);
  return {
    durationSec: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: !!audio,
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
  if (STUB_ROUTES.has(path)) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST", data: {} } });
      return;
    }
    sendJson(res, 501, { error: { code: "NOT_IMPLEMENTED", message: `${path} is not implemented yet`, data: {} } });
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
