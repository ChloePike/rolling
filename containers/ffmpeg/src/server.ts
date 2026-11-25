/**
 * Tiny HTTP server inside the FFmpeg container.
 * M0: /health works; /render, /probe, /thumb, /waveform answer 501 until M3/M7.
 * Must stay erasable TypeScript (no enums/namespaces) so Node can strip types.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8080);
const STUB_ROUTES = new Set(["/render", "/probe", "/thumb", "/waveform"]);

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

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://container").pathname;
  if (path === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ffmpeg: await ffmpegVersion() });
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
