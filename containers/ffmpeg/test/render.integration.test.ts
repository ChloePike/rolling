/**
 * Renders a small EDL with real ffmpeg: generated test clips (testsrc, sine)
 * served over HTTP like signed media URLs, every filter feature in one job,
 * the result PUT to a presigned-style URL. Skipped when ffmpeg is missing.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderJob } from "../src/graph.ts";

process.env.FFMPEG_SERVER_NO_LISTEN = "1";
const { probe } = await import("../src/server.ts");
const { Renderer } = await import("../src/render.ts");

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const available = hasFfmpeg();
let dir = "";
let server: Server;
let base = "";
const uploads = new Map<string, Buffer>();

function gen(name: string, args: string[]) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(dir, name)]);
}

beforeAll(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), "render-it-"));
  gen("a.mp4", ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  gen("b.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  gen("voice.m4a", ["-f", "lavfi", "-i", "sine=frequency=880:duration=4", "-c:a", "aac"]);
  gen("music.m4a", ["-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-c:a", "aac"]);
  server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0]!.slice(1);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        uploads.set(name, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    const path = join(dir, name);
    try {
      // Ranges like the media route (ffmpeg seeks in MP4 inputs).
      const size = statSync(path).size;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { "content-type": "application/octet-stream", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
        createReadStream(path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size, "accept-ranges": "bytes" });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!available) return;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function waitDone(r: InstanceType<typeof Renderer>, id: string) {
  for (let i = 0; i < 1200; i++) {
    const s = r.get(id)!;
    if (s.status === "done" || s.status === "failed") return s;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("render timed out");
}

function meanVolume(file: string, from: number, len: number): number {
  const log = execFileSync("sh", ["-c", `ffmpeg -hide_banner -ss ${from} -t ${len} -i '${file}' -af volumedetect -vn -f null - 2>&1`], { encoding: "utf8" });
  const m = /mean_volume: (-?[\d.]+) dB/.exec(log);
  return m ? Number(m[1]) : -999;
}

describe.skipIf(!available)("render (real ffmpeg)", () => {
  it("renders every feature of a small EDL and uploads the MP4", async () => {
    const job: RenderJob = {
      id: "exp_it1",
      width: 360,
      height: 640,
      fps: 24,
      duration: 6,
      edl: {
        fps: 24,
        width: 1080,
        height: 1920,
        tracks: [
          { id: "C1", kind: "caption", clips: [{ id: "c1", start: 0.4, end: 2.5, text: "Morning. The first sip." }, { id: "c2", start: 3, end: 5, text: "Line one\nline {two}" }] },
          {
            id: "V1",
            kind: "video",
            clips: [
              { id: "v1", assetId: "a", in: 0.5, out: 2.5, start: 0, fadeIn: 0.5, transitionOut: { type: "dissolve", dur: 0.5 }, transform: { scale: 1.2, x: 20, y: -10, rotation: 8, opacity: 0.9 } },
              { id: "v2", assetId: "b", in: 0, out: 2, start: 2, speed: 2, reverse: true },
              { id: "v3", assetId: null, in: 0, out: 1, start: 3 },
              { id: "v4", assetId: "a", in: 0, out: 1, start: 4.5, speed: 0.5 },
            ],
          },
          { id: "V2", kind: "video", clips: [{ id: "o1", assetId: "b", in: 0, out: 1, start: 1, transform: { scale: 0.3, x: 100, y: 200, rotation: 0, opacity: 0.8 } }] },
          { id: "A1", kind: "voice", clips: [{ id: "a1", assetId: "voice", in: 0, out: 2, start: 1, gainDb: 0 }] },
          {
            id: "A2",
            kind: "music",
            clips: [{ id: "m1", assetId: "music", in: 0, out: 6, start: 0, gainDb: -6, duckUnder: ["A1"], gainKeyframes: [{ t: 0, db: -24 }, { t: 0.5, db: -6 }, { t: 6, db: -6 }] }],
          },
        ],
      },
      inputs: {
        a: { url: `${base}/a.mp4?exp=1&sig=x` },
        b: { url: `${base}/b.mp4?exp=1&sig=x` },
        voice: { url: `${base}/voice.m4a` },
        music: { url: `${base}/music.m4a` },
      },
      putUrl: `${base}/out-it1.mp4?X-Amz-Signature=fake`,
    };
    const work = mkdtempSync(join(tmpdir(), "render-work-"));
    const r = new Renderer({ probe, workDir: work });
    expect(r.start(job).status).toBe("running");
    // The same id again is the same job.
    expect(r.start(job)).toBe(r.get(job.id));
    const s = await waitDone(r, job.id);
    if (s.status === "failed") {
      const graph = readFileSync(join(work, `render-${job.id}`, "graph.txt"), "utf8");
      throw new Error(`${s.error?.detail ?? s.error?.message}\n${graph}`);
    }
    expect(s.result).toMatchObject({ uploaded: true, width: 360, height: 640, videoCodec: "h264", audioCodec: "aac" });
    expect(Math.abs(s.result!.durationSec! - 6)).toBeLessThan(0.15);
    const file = uploads.get("out-it1.mp4");
    expect(file && file.length).toBe(s.result!.size);
    // faststart: the moov atom comes before mdat.
    const out = join(work, "check.mp4");
    writeFileSync(out, file!);
    if (process.env.RENDER_IT_KEEP) writeFileSync(process.env.RENDER_IT_KEEP, file!);
    const head = file!.subarray(0, 4096).toString("latin1");
    expect(head.indexOf("moov")).toBeGreaterThan(-1);
    expect(head.indexOf("moov")).toBeLessThan(file!.indexOf("mdat"));
    // There is sound (voice over ducked music).
    expect(meanVolume(out, 1.2, 1)).toBeGreaterThan(-40);
    expect(r.filePath(job.id)).toBeNull();
    expect(await r.remove(job.id)).toBe(true);
    rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("keeps the file for GET /render/:id/file without a putUrl, and reports ffmpeg failures", async () => {
    const work = mkdtempSync(join(tmpdir(), "render-work-"));
    const r = new Renderer({ probe, workDir: work });
    const job: RenderJob = {
      id: "exp_it2",
      width: 320,
      height: 180,
      fps: 25,
      duration: 1.5,
      edl: { fps: 25, width: 1920, height: 1080, tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "b", in: 0, out: 1.5, start: 0 }] }] },
      inputs: { b: { url: `${base}/b.mp4` } },
    };
    r.start(job);
    const s = await waitDone(r, job.id);
    expect(s.status, JSON.stringify(s.error)).toBe("done");
    expect(s.result!.uploaded).toBe(false);
    const file = r.filePath(job.id)!;
    expect(statSync(file.path).size).toBe(file.size);
    const info = await probe(file.path);
    expect(info).toMatchObject({ width: 320, height: 180, hasAudio: true, hasVideo: true });

    const missing: RenderJob = { ...job, id: "exp_it3", inputs: { b: { url: `${base}/nope.mp4` } } };
    r.start(missing);
    const f = await waitDone(r, missing.id);
    expect(f).toMatchObject({ status: "failed", error: { code: "input_unreadable" } });
    rmSync(work, { recursive: true, force: true });
  }, 120_000);
});
