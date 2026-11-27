/**
 * `/render` jobs: validate the job, probe its inputs, run ffmpeg with the
 * graph from `graph.ts`, probe the result, then `PUT` it to the presigned R2
 * URL (or keep it for `GET /render/:id/file`). Jobs live in memory; a
 * restarted container answers 404 and the workflow fails the export.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildRender, type FocusKey, type InputInfo, type MediaClip, type RenderCard, type RenderJob } from "./graph.ts";
import { analysisArgs, focusSamples, smoothPath, splitFrames, toClipTime } from "./reframe.ts";

export type RenderStatus = "running" | "uploading" | "done" | "failed";

export interface RenderResult {
  durationSec: number | null;
  size: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  uploaded: boolean;
  /** Audio-only jobs: number of MP3 chunks (`GET /render/:id/file?part=n`). */
  parts?: number;
}

export interface RenderState {
  id: string;
  status: RenderStatus;
  progress: number;
  result?: RenderResult;
  /** `detail`: the tail of ffmpeg's log (for logs, not for users). */
  error?: { code: string; message: string; detail?: string };
}

interface Entry {
  state: RenderState;
  dir: string;
  out: string;
  proc: ChildProcess | null;
  canceled: boolean;
  touched: number;
}

export interface ProbeInfo {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface RenderDeps {
  probe: (url: string) => Promise<ProbeInfo>;
  /** Uploads the file to a presigned URL. */
  upload?: (url: string, path: string, size: number) => Promise<void>;
  ffmpeg?: string;
  /** Concurrent ffmpeg processes. */
  concurrency?: number;
  workDir?: string;
  /** Raw 64×64 gray frames of a source range (smart reframe). */
  analyze?: (url: string, start: number, len: number) => Promise<Uint8Array>;
  /** Family names inside a font file (`fc-scan`). */
  fontFamilies?: (path: string) => Promise<string[]>;
  /** A system font file for a fontconfig pattern (`fc-match`). */
  systemFont?: (pattern: string) => Promise<string | null>;
  /** Downloads a URL to a file. */
  download?: (url: string, path: string) => Promise<void>;
}

const MAX_DURATION = 15 * 60;
const MAX_SIDE = 4096;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Finished jobs are forgotten after this long (their files too). */
const KEEP_MS = 2 * 3600_000;

export class RenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isNum = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Shape checks for an incoming job (the Worker validated the EDL with the shared schema). */
export function validateJob(body: unknown): RenderJob {
  const j = body as Partial<RenderJob> | null;
  if (!j || typeof j !== "object") throw new RenderError("BAD_REQUEST", "Body must be a render job");
  if (typeof j.id !== "string" || !ID.test(j.id)) throw new RenderError("BAD_REQUEST", "id is invalid");
  if (!isNum(j.width, 16, MAX_SIDE) || !isNum(j.height, 16, MAX_SIDE) || j.width! % 2 || j.height! % 2) throw new RenderError("BAD_REQUEST", "width and height must be even, 16..4096");
  if (!isNum(j.fps, 1, 60) || !Number.isInteger(j.fps)) throw new RenderError("BAD_REQUEST", "fps must be an integer 1..60");
  if (!isNum(j.duration, 0.05, MAX_DURATION)) throw new RenderError("BAD_REQUEST", "duration is out of range");
  const edl = j.edl;
  if (!edl || !Array.isArray(edl.tracks)) throw new RenderError("BAD_REQUEST", "edl.tracks is missing");
  for (const t of edl.tracks) {
    if (!t || !Array.isArray(t.clips) || !["caption", "video", "voice", "music"].includes(t.kind)) throw new RenderError("BAD_REQUEST", "edl track is invalid");
    for (const c of t.clips as unknown as Record<string, unknown>[]) {
      if (t.kind === "caption") {
        if (!isNum(c.start, 0, 86400) || !isNum(c.end, 0, 86400) || typeof c.text !== "string") throw new RenderError("BAD_REQUEST", "caption clip is invalid");
      } else if (!isNum(c.in, 0, 86400) || !isNum(c.out, 0, 86400) || !isNum(c.start, 0, 86400) || (c.out as number) <= (c.in as number)) {
        throw new RenderError("BAD_REQUEST", "media clip is invalid");
      }
    }
  }
  if (!j.inputs || typeof j.inputs !== "object") throw new RenderError("BAD_REQUEST", "inputs is missing");
  for (const v of Object.values(j.inputs)) {
    if (!v || typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) throw new RenderError("BAD_REQUEST", "inputs must be http(s) URLs");
  }
  if (j.putUrl !== undefined && (typeof j.putUrl !== "string" || !/^https?:\/\//.test(j.putUrl))) throw new RenderError("BAD_REQUEST", "putUrl must be an http(s) URL");
  if (j.interpolateFps !== undefined && j.interpolateFps !== 48 && j.interpolateFps !== 60) throw new RenderError("BAD_REQUEST", "interpolateFps must be 48 or 60");
  for (const f of j.fonts ?? []) {
    if (!f || typeof f.url !== "string" || !/^https?:\/\//.test(f.url) || typeof f.family !== "string" || !["woff2", "ttf", "otf"].includes(f.format)) throw new RenderError("BAD_REQUEST", "fonts are invalid");
  }
  const urls = [j.brand?.watermark?.url, j.brand?.intro?.logoUrl, j.brand?.outro?.logoUrl].filter((u) => u !== undefined);
  if (urls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) throw new RenderError("BAD_REQUEST", "brand images must be http(s) URLs");
  for (const c of [j.brand?.intro, j.brand?.outro]) {
    if (c && (!isNum(c.seconds, 0.5, 10) || typeof c.text !== "string" || c.text.length > 200 || !/^#[0-9a-f]{6}$/i.test(c.background) || !/^#[0-9a-f]{6}$/i.test(c.color))) throw new RenderError("BAD_REQUEST", "a brand card is invalid");
  }
  if (j.audioOnly && (j.audioOnly.sampleRate !== 16000 || !isNum(j.audioOnly.chunkSeconds, 10, 900))) throw new RenderError("BAD_REQUEST", "audioOnly is invalid");
  return j as RenderJob;
}

/** `out_time_us` from ffmpeg's `-progress` output. */
export function parseProgress(chunk: string, duration: number): number | null {
  let last: number | null = null;
  for (const m of chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)) last = Number(m[1]) / 1e6;
  if (last === null || duration <= 0) return null;
  return Math.min(0.99, Math.max(0, last / duration));
}

async function defaultUpload(url: string, path: string, size: number): Promise<void> {
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "content-type": "video/mp4", "content-length": String(size) },
    // Node fetch needs this for a streamed body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) throw new RenderError("upload_failed", `Storage answered ${res.status}`);
}

function capture(cmd: string, args: string[], timeout = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const defaultAnalyze = (url: string, start: number, len: number) => capture("ffmpeg", analysisArgs(url, start, len), 120_000).then((b) => new Uint8Array(b));

async function defaultFontFamilies(path: string): Promise<string[]> {
  try {
    const out = (await capture("fc-scan", ["--format", "%{family}\\n", path], 10_000)).toString("utf8");
    return [...new Set(out.split(/[\n,]/).map((f) => f.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

async function defaultSystemFont(pattern: string): Promise<string | null> {
  try {
    const f = (await capture("fc-match", ["-f", "%{file}", pattern], 10_000)).toString("utf8").trim();
    return f || null;
  } catch {
    return null;
  }
}

async function defaultDownload(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new RenderError("input_unreadable", `A font could not be read (${res.status})`);
  await writeFile(path, new Uint8Array(await res.arrayBuffer()));
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** Clips whose crop follows the subject (auto reframe on the base video track). */
export function autoReframeClips(job: RenderJob): MediaClip[] {
  if (!job.reframe) return [];
  const base = job.edl.tracks.find((t) => t.kind === "video");
  if (!base || base.kind !== "video") return [];
  return base.clips.filter((c) => c.assetId && job.inputs[c.assetId] && (!c.reframe || c.reframe.mode === "auto") && c.start < job.duration);
}

export class Renderer {
  private jobs = new Map<string, Entry>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private deps: RenderDeps;

  constructor(deps: RenderDeps) {
    this.deps = deps;
  }

  get(id: string): RenderState | null {
    const e = this.jobs.get(id);
    if (!e) return null;
    e.touched = Date.now();
    return e.state;
  }

  filePath(id: string): { path: string; size: number } | null {
    const e = this.jobs.get(id);
    if (!e || e.state.status !== "done" || !e.state.result || e.state.result.uploaded) return null;
    return { path: e.out, size: e.state.result.size };
  }

  /** Starts a job; the same id again returns the existing state. */
  start(job: RenderJob): RenderState {
    this.sweep();
    const existing = this.jobs.get(job.id);
    if (existing) return existing.state;
    const dir = join(this.deps.workDir ?? tmpdir(), `render-${job.id}`);
    const entry: Entry = { state: { id: job.id, status: "running", progress: 0 }, dir, out: join(dir, "out.mp4"), proc: null, canceled: false, touched: Date.now() };
    this.jobs.set(job.id, entry);
    void this.run(job, entry);
    return entry.state;
  }

  async remove(id: string): Promise<boolean> {
    const e = this.jobs.get(id);
    if (!e) return false;
    e.canceled = true;
    e.proc?.kill("SIGKILL");
    this.jobs.delete(id);
    await rm(e.dir, { recursive: true, force: true });
    return true;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, e] of this.jobs) if ((e.state.status === "done" || e.state.status === "failed") && now - e.touched > KEEP_MS) void this.remove(id);
  }

  private async slot(): Promise<() => void> {
    const limit = this.deps.concurrency ?? 2;
    if (this.active >= limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  private async run(job: RenderJob, e: Entry): Promise<void> {
    const release = await this.slot();
    try {
      await mkdir(e.dir, { recursive: true });
      const inputs: Record<string, InputInfo> = {};
      for (const [assetId, input] of Object.entries(job.inputs)) {
        try {
          const p = await this.deps.probe(input.url);
          inputs[assetId] = { url: input.url, hasVideo: p.hasVideo, hasAudio: p.hasAudio };
        } catch (err) {
          throw new RenderError("input_unreadable", `An input could not be read (${assetId}): ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        }
      }
      const prepared = await this.prepare(job, e, inputs);
      const built = buildRender(prepared.job, {
        inputs,
        assPath: join(e.dir, "captions.ass"),
        filterPath: join(e.dir, "graph.txt"),
        outPath: e.out,
        fontsDir: prepared.fontsDir,
        focus: prepared.focus,
        cards: prepared.cards,
        audioPattern: join(e.dir, "part%03d.mp3"),
      });
      await writeFile(join(e.dir, "graph.txt"), built.filter);
      if (built.ass) await writeFile(join(e.dir, "captions.ass"), built.ass);
      await this.ffmpeg(built.args, built.totalDuration, e);
      if (e.canceled) return;
      if (job.audioOnly) {
        const parts = (await readdir(e.dir)).filter((f) => /^part\d{3}\.mp3$/.test(f)).sort();
        let size = 0;
        for (const f of parts) size += (await stat(join(e.dir, f))).size;
        e.state = { id: job.id, status: "done", progress: 1, result: { durationSec: job.duration, size, width: null, height: null, videoCodec: null, audioCodec: "mp3", uploaded: false, parts: parts.length } };
        return;
      }
      const size = (await stat(e.out)).size;
      const p = await this.deps.probe(e.out);
      let uploaded = false;
      if (job.putUrl) {
        e.state = { ...e.state, status: "uploading", progress: 0.99 };
        await (this.deps.upload ?? defaultUpload)(job.putUrl, e.out, size);
        uploaded = true;
        await rm(e.out, { force: true });
      }
      e.state = {
        id: job.id,
        status: "done",
        progress: 1,
        result: { durationSec: p.durationSec, size, width: p.width, height: p.height, videoCodec: p.videoCodec, audioCodec: p.audioCodec, uploaded },
      };
    } catch (err) {
      const code = err instanceof RenderError ? err.code : "render_failed";
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: "render failed", id: job.id, code, error: message.slice(0, 2000) }));
      e.state = { id: job.id, status: "failed", progress: e.state.progress, error: { code, message: code === "ffmpeg_failed" ? "The renderer stopped." : message.slice(0, 300), ...(code === "ffmpeg_failed" ? { detail: message.slice(-1500) } : {}) } };
    } finally {
      e.touched = Date.now();
      release();
    }
  }

  /**
   * Fonts into the job's font folder (their real family names replace the
   * labels the Worker sent), card text files with a font that has the glyphs,
   * and subject paths for auto-reframed clips (a failed analysis centers).
   */
  private async prepare(job: RenderJob, e: Entry, inputs: Record<string, InputInfo>) {
    const out: { job: RenderJob; fontsDir?: string; focus: Record<string, FocusKey[]>; cards: { intro?: { textPath: string; fontFile: string }; outro?: { textPath: string; fontFile: string } } } = { job, focus: {}, cards: {} };
    const families = new Map<string, { path: string; real: string }>();
    if (job.fonts?.length) {
      const dir = join(e.dir, "fonts");
      await mkdir(dir, { recursive: true });
      for (const [i, f] of job.fonts.entries()) {
        const path = join(dir, `font${i}.${f.format}`);
        await (this.deps.download ?? defaultDownload)(f.url, path);
        const real = (await (this.deps.fontFamilies ?? defaultFontFamilies)(path))[0] ?? f.family;
        families.set(f.family, { path, real });
      }
      out.fontsDir = dir;
    }
    if (job.captions?.look) {
      const mapped = families.get(job.captions.look.fontFamily);
      if (mapped) out.job = { ...job, captions: { ...job.captions, look: { ...job.captions.look, fontFamily: mapped.real } } };
    }
    const systemFont = this.deps.systemFont ?? defaultSystemFont;
    const cardFiles = async (name: "intro" | "outro", c: RenderCard | undefined) => {
      if (!c) return;
      const textPath = join(e.dir, `${name}.txt`);
      await writeFile(textPath, c.text);
      const brand = c.fontFamily ? families.get(c.fontFamily)?.path : undefined;
      const fontFile = brand ?? (await systemFont(CJK.test(c.text) ? "Noto Sans CJK SC:bold" : "Noto Sans:bold")) ?? (await systemFont("DejaVu Sans:bold")) ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
      out.cards[name] = { textPath, fontFile };
    };
    await cardFiles("intro", job.brand?.intro);
    await cardFiles("outro", job.brand?.outro);
    for (const clip of autoReframeClips(job)) {
      const info = inputs[clip.assetId!];
      if (!info?.hasVideo) continue;
      try {
        const raw = await (this.deps.analyze ?? defaultAnalyze)(info.url, clip.in, clip.out - clip.in);
        out.focus[clip.id] = toClipTime(smoothPath(focusSamples(splitFrames(raw))), clip);
      } catch (err) {
        console.warn(JSON.stringify({ msg: "reframe analysis failed", id: job.id, clip: clip.id, error: String(err).slice(0, 300) }));
      }
    }
    return out;
  }

  /** Audio-only chunk file. */
  partPath(id: string, part: number): string | null {
    const e = this.jobs.get(id);
    if (!e || e.state.status !== "done" || !e.state.result?.parts || part < 0 || part >= e.state.result.parts) return null;
    return join(e.dir, `part${String(part).padStart(3, "0")}.mp3`);
  }

  private ffmpeg(args: string[], duration: number, e: Entry): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.deps.ffmpeg ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      e.proc = proc;
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        const p = parseProgress(chunk, duration);
        if (p !== null && p > e.state.progress) e.state = { ...e.state, progress: Math.round(p * 1000) / 1000 };
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      proc.on("error", (err) => reject(new RenderError("ffmpeg_failed", String(err))));
      proc.on("close", (code) => {
        e.proc = null;
        if (code === 0 || e.canceled) resolve();
        else reject(new RenderError("ffmpeg_failed", `ffmpeg exited with ${code}: ${stderr.trim()}`));
      });
    });
  }
}
