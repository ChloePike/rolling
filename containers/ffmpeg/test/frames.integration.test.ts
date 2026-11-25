/**
 * /frames and /scenes with real ffmpeg: a generated clip with a hard cut
 * served over HTTP like a signed media URL, PNGs PUT to presigned-style URLs.
 * Skipped when ffmpeg is missing.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.FFMPEG_SERVER_NO_LISTEN = "1";
const { start } = await import("../src/server.ts");
const { isPng } = await import("../src/frames.ts");

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
let mediaBase = "";
let app: ReturnType<typeof start>;
let appBase = "";
const puts = new Map<string, { type: string | undefined; body: Buffer }>();

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

beforeAll(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), "frames-it-"));
  // 2 s of red, then 2 s of blue: one hard cut at 2 s.
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:size=640x360:rate=25:duration=2",
    "-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=25:duration=2",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "cut.mp4"),
  ]);
  media = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0]!.slice(1);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        puts.set(name, { type: req.headers["content-type"], body: Buffer.concat(chunks) });
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
  mediaBase = `http://127.0.0.1:${(media.address() as AddressInfo).port}`;
  app = start(0);
  await new Promise((r) => app.once("listening", r));
  appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!available) return;
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => media.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${appBase}${path}`, { method: "POST", body: JSON.stringify(body) });

/** Mean RGB of a PNG's centre, decoded by ffmpeg. */
function centreColor(png: Buffer): [number, number, number] {
  const file = join(dir, `probe-${Math.random().toString(36).slice(2)}.png`);
  writeFileSync(file, png);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "crop=8:8,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [raw[0]!, raw[1]!, raw[2]!];
}

describe.skipIf(!available)("frames and scenes (real ffmpeg)", () => {
  it("PUTs one PNG per time to its presigned URL, at the right moment of the clip", async () => {
    const res = await post("/frames", {
      url: `${mediaBase}/cut.mp4?exp=1&sig=x`,
      times: [0.5, 3, 99],
      puts: [`${mediaBase}/f0.png?X-Amz-Signature=a`, `${mediaBase}/f1.png?X-Amz-Signature=b`, `${mediaBase}/f2.png?X-Amz-Signature=c`],
      width: 320,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { frames: { at: number; size: number; uploaded: boolean }[] };
    expect(body.frames.map((f) => [f.at, f.uploaded])).toEqual([[0.5, true], [3, true], [99, true]]);
    for (const name of ["f0.png", "f1.png", "f2.png"]) {
      const put = puts.get(name)!;
      expect(put.type).toBe("image/png");
      expect(isPng(put.body)).toBe(true);
      expect(pngSize(put.body)).toEqual({ width: 320, height: 180 });
    }
    const [r0, , b0] = centreColor(puts.get("f0.png")!.body);
    const [r1, , b1] = centreColor(puts.get("f1.png")!.body);
    expect(r0).toBeGreaterThan(180);
    expect(b0).toBeLessThan(80);
    expect(b1).toBeGreaterThan(180);
    expect(r1).toBeLessThan(80);
    // Past the end: the last frames of the clip (blue).
    expect(centreColor(puts.get("f2.png")!.body)[2]).toBeGreaterThan(180);
  }, 60_000);

  it("returns a single PNG without puts", async () => {
    const res = await post("/frames", { url: `${mediaBase}/cut.mp4`, times: [1] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 640, height: 360 });
  }, 30_000);

  it("finds the hard cut", async () => {
    const res = await post("/scenes", { url: `${mediaBase}/cut.mp4` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cuts: number[]; threshold: number };
    expect(body.threshold).toBe(0.3);
    expect(body.cuts).toHaveLength(1);
    expect(body.cuts[0]).toBeGreaterThan(1.9);
    expect(body.cuts[0]).toBeLessThan(2.1);
  }, 30_000);

  it("refuses bad bodies and reports a missing file", async () => {
    expect((await post("/frames", { url: `${mediaBase}/cut.mp4`, times: [0, 1] })).status).toBe(400);
    expect((await post("/frames", { url: `${mediaBase}/missing.mp4`, times: [0] })).status).toBe(422);
  }, 30_000);
});
