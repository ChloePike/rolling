/**
 * Post-production with real ffmpeg (D-026..D-030): a render with burned-in
 * captions, reframing to 9:16, interpolation to 48 fps, a logo watermark, an
 * intro card and -14 LUFS loudness; the last-frame, silence, audio-cut and
 * resize commands through the server; transcription audio chunks.
 * Media is served over HTTP like signed URLs. Skipped without ffmpeg.
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
const { probe, start } = await import("../src/server.ts");
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
let media: Server;
let base = "";
let app: ReturnType<typeof start>;
let appBase = "";
const puts = new Map<string, Buffer>();

const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const sh = (cmd: string) => execFileSync("sh", ["-c", cmd], { encoding: "utf8" });

beforeAll(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), "post-it-"));
  // 16:9 clip whose subject (a white box) sits left of center; with tone.
  ff(["-f", "lavfi", "-i", "color=c=0x202020:size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "color=c=white:size=90x100:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-filter_complex", "[0:v][1:v]overlay=x=120+t*20:y=130[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "a.mp4")]);
  // testsrc draws a frame counter: the last frame differs from every other one.
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "count.mp4")]);
  // Voice: tone, 0.8 s pause, tone, 0.8 s pause, tone (quiet: loudness normalisation lifts it).
  ff(["-f", "lavfi", "-i", "sine=frequency=300:duration=1.5", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.8",
    "-filter_complex", "[0:a]aformat=sample_rates=48000:channel_layouts=mono,volume=-20dB[t];[t]asplit=3[t1][t2][t3];[1:a]asplit=2[s1][s2];[t1][s1][t2][s2][t3]concat=n=5:v=0:a=1[a]",
    "-map", "[a]", "-c:a", "aac", join(dir, "vo.m4a")]);
  ff(["-f", "lavfi", "-i", "color=c=0xFFCB2B:size=128x64", "-frames:v", "1", join(dir, "logo.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", join(dir, "still.png")]);
  media = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0]!.slice(1);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        puts.set(name, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    try {
      const path = join(dir, name);
      const size = statSync(path).size;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (m) {
        const s = Number(m[1]);
        const e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { "content-length": e - s + 1, "content-range": `bytes ${s}-${e}/${size}`, "accept-ranges": "bytes" });
        createReadStream(path, { start: s, end: e }).pipe(res);
        return;
      }
      res.writeHead(200, { "content-length": size, "accept-ranges": "bytes" });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(media.address() as AddressInfo).port}`;
  app = start(0);
  await new Promise((r) => app.once("listening", r));
  appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!available) return;
  await new Promise<void>((r) => media.close(() => r()));
  await new Promise<void>((r) => app.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function waitDone(r: InstanceType<typeof Renderer>, id: string) {
  for (let i = 0; i < 1800; i++) {
    const s = r.get(id)!;
    if (s.status === "done" || s.status === "failed") return s;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("render timed out");
}

const post = (path: string, body: unknown) => fetch(`${appBase}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Integrated loudness (LUFS) of a file, from ebur128. */
function lufs(file: string): number {
  const log = sh(`ffmpeg -hide_banner -nostats -i '${file}' -af ebur128 -f null - 2>&1`);
  const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(log);
  return m ? Number(m[1]) : NaN;
}

/** Raw RGB of one frame at `at` seconds. */
function frameAt(file: string, at: number, w: number, h: number): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-s", `${w}x${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}

const meanAbsDiff = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i]! - b[i]!);
  return s / Math.min(a.length, b.length);
};

describe.skipIf(!available)("post-production (real ffmpeg)", () => {
  it("renders captions, reframe to 9:16, 48 fps, watermark, intro card and -14 LUFS", async () => {
    const look = { id: "bold_social", weight: 800, size: 0.072, outline: 0.12, box: null, shadow: true, marginV: 0.22, maxLines: 1, text: "#FFFFFF", outlineColor: "#000000", boxColor: "#000000", fontFamily: "DejaVu Sans", cjkFamily: "Noto Sans CJK SC" };
    const edl: RenderJob["edl"] = {
      fps: 24,
      width: 1920,
      height: 1080,
      tracks: [
        { id: "C1", kind: "caption", clips: [{ id: "c1", start: 0, end: 2, text: "BIG CAPTION" }] },
        { id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 2, start: 0 }] },
        { id: "A1", kind: "voice", clips: [{ id: "a1", assetId: "vo", in: 0, out: 2, start: 0 }] },
      ],
    };
    const common: RenderJob = {
      id: "post_it1",
      width: 270,
      height: 480,
      fps: 24,
      duration: 2,
      edl,
      inputs: { a: { url: `${base}/a.mp4` }, vo: { url: `${base}/vo.m4a` } },
      reframe: true,
      interpolateFps: 48,
      voiceLufs: -16,
      encode: { crf: null, videoKbps: 1500, maxKbps: 2000, bufferKbps: 3000, profile: "high", level: "4.2", audioKbps: 128, loudnessLufs: -14, truePeakDb: -1 },
      captions: { look, lang: "en" },
      brand: { watermark: { url: `${base}/logo.png`, position: "top_right", opacity: 0.9, size: 0.2 }, intro: { seconds: 1, background: "#3B82F6", color: "#FFFFFF", text: "Intro" } },
    };
    const work = mkdtempSync(join(tmpdir(), "post-work-"));
    const r = new Renderer({ probe, workDir: work });
    r.start(common);
    r.start({ ...common, id: "post_it2", captions: null });
    const s1 = await waitDone(r, "post_it1");
    const s2 = await waitDone(r, "post_it2");
    for (const [s, id] of [[s1, "post_it1"], [s2, "post_it2"]] as const) {
      if (s.status === "failed") throw new Error(`${s.error?.detail ?? s.error?.message}\n${readFileSync(join(work, `render-${id}`, "graph.txt"), "utf8")}`);
    }
    expect(s1.result).toMatchObject({ width: 270, height: 480, videoCodec: "h264", audioCodec: "aac" });
    expect(Math.abs(s1.result!.durationSec! - 3)).toBeLessThan(0.15);
    const f1 = r.filePath("post_it1")!.path;
    const f2 = r.filePath("post_it2")!.path;
    expect(sh(`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 '${f1}'`).trim()).toBe("48/1");
    // The intro card is the brand color.
    const intro = frameAt(f1, 0.5, 27, 48);
    expect(intro[0]).toBeLessThan(90);
    expect(intro[2]).toBeGreaterThan(200);
    // Captions are burned in: the two renders differ where the text is, not elsewhere.
    const a = frameAt(f1, 2, 270, 480);
    const b = frameAt(f2, 2, 270, 480);
    const rows = (buf: Buffer, y0: number, y1: number) => buf.subarray(y0 * 270 * 3, y1 * 270 * 3);
    expect(meanAbsDiff(rows(a, 330, 400), rows(b, 330, 400))).toBeGreaterThan(3);
    expect(meanAbsDiff(rows(a, 120, 200), rows(b, 120, 200))).toBeLessThan(1);
    // Reframed (no letterbox): the top rows are picture, not black bars; the subject (white box) is in frame.
    const top = rows(b, 100, 101);
    expect(Math.max(...top)).toBeGreaterThan(20);
    expect(Math.max(...rows(b, 180, 300))).toBeGreaterThan(200);
    // The watermark (brand yellow) sits top right.
    const px = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * 270 + x) * 3, (y * 270 + x) * 3 + 3)];
    const wm = px(b, 270 - 12 - 20, 12 + 8);
    expect(wm[0]).toBeGreaterThan(200);
    expect(wm[2]).toBeLessThan(120);
    // Quiet voice lifted to about -14 LUFS (one-pass loudnorm, short clip: allow a margin).
    expect(Math.abs(lufs(f1) - -14)).toBeLessThan(3);
    rmSync(work, { recursive: true, force: true });
  }, 240_000);

  it("writes transcription audio as mono 16 kHz MP3 chunks", async () => {
    const work = mkdtempSync(join(tmpdir(), "post-work-"));
    const r = new Renderer({ probe, workDir: work });
    const job: RenderJob = {
      id: "post_audio",
      width: 16,
      height: 16,
      fps: 24,
      duration: 6,
      edl: { fps: 24, width: 1920, height: 1080, tracks: [{ id: "A1", kind: "voice", clips: [{ id: "a1", assetId: "vo", in: 0, out: 6, start: 0 }] }] },
      inputs: { vo: { url: `${base}/vo.m4a` } },
      audioOnly: { sampleRate: 16000, chunkSeconds: 10 },
    };
    // Validation allows chunks of 10 s or more; this file is 6 s, so one chunk.
    r.start(job);
    const s = await waitDone(r, job.id);
    expect(s.status, JSON.stringify(s.error)).toBe("done");
    expect(s.result!.parts).toBe(1);
    const part = r.partPath(job.id, 0)!;
    const info = sh(`ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 '${part}'`).trim();
    expect(info).toBe("mp3,16000,1");
    expect(r.partPath(job.id, 1)).toBeNull();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it("extracts the true last frame", async () => {
    const res = await post("/last-frame", { url: `${base}/count.mp4` });
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    const tmp = join(dir, "last.png");
    writeFileSync(tmp, png);
    const ours = execFileSync("ffmpeg", ["-v", "error", "-i", tmp, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    // Frame 50 of 50 (index 49), decoded by number.
    const exact = execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "count.mp4"), "-vf", "select=eq(n\\,49)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const before = execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "count.mp4"), "-vf", "select=eq(n\\,48)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(meanAbsDiff(ours, exact)).toBeLessThan(0.5);
    expect(meanAbsDiff(ours, before)).toBeGreaterThan(meanAbsDiff(ours, exact));
    const put = await post("/last-frame", { url: `${base}/count.mp4`, width: 160, put: `${base}/frame.png?sig=x` });
    expect(await put.json()).toMatchObject({ uploaded: true, contentType: "image/png" });
    expect(puts.get("frame.png")!.readUInt32BE(16)).toBe(160);
  }, 60_000);

  it("finds the pauses of a voiceover and cuts a part of it", async () => {
    const res = await post("/silences", { url: `${base}/vo.m4a`, noiseDb: -50, minSilence: 0.5 });
    const body = (await res.json()) as { silences: { start: number; end: number }[] };
    expect(body.silences).toHaveLength(2);
    expect(Math.abs(body.silences[0]!.start - 1.5)).toBeLessThan(0.15);
    expect(Math.abs(body.silences[1]!.start - 3.8)).toBeLessThan(0.15);
    const cut = await post("/audio-cut", { url: `${base}/vo.m4a`, start: 2.3, duration: 1.5 });
    expect(cut.status).toBe(200);
    const file = join(dir, "cut.m4a");
    writeFileSync(file, Buffer.from(await cut.arrayBuffer()));
    expect(Math.abs((await probe(file)).durationSec! - 1.5)).toBeLessThan(0.1);
  }, 60_000);

  it("resizes an image and a video with Lanczos in the background", async () => {
    const img = await post("/jobs", { id: "rz_img", kind: "resize", media: "image", url: `${base}/still.png`, short: 1080 });
    expect(img.status).toBe(202);
    const vid = await post("/jobs", { id: "rz_vid", kind: "resize", media: "video", url: `${base}/a.mp4`, short: 1080, duration: 2, putUrl: `${base}/rz.mp4?sig=x` });
    expect(vid.status).toBe(202);
    const wait = async (id: string) => {
      for (let i = 0; i < 600; i++) {
        const s = (await (await fetch(`${appBase}/jobs/${id}`)).json()) as { status: string; result?: { width: number; height: number; uploaded: boolean } };
        if (s.status === "done" || s.status === "failed") return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timeout");
    };
    expect(await wait("rz_img")).toMatchObject({ status: "done", result: { width: 1920, height: 1080, uploaded: false } });
    const file = await fetch(`${appBase}/jobs/rz_img/file`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(await wait("rz_vid")).toMatchObject({ status: "done", result: { width: 1920, height: 1080, uploaded: true } });
    expect(puts.get("rz.mp4")!.length).toBeGreaterThan(1000);
    expect(((await (await fetch(`${appBase}/jobs/rz_vid`, { method: "DELETE" })).json()) as { ok: boolean }).ok).toBe(true);
  }, 120_000);
});
