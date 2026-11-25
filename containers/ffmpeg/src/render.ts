/**
 * `/render` jobs: validate the job, probe its inputs, run ffmpeg with the
 * graph from `graph.ts`, probe the result, then `PUT` it to the presigned R2
 * URL (or keep it for `GET /render/:id/file`). Jobs live in memory; a
 * restarted container answers 404 and the workflow fails the export.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildRender, type InputInfo, type RenderJob } from "./graph.ts";

export type RenderStatus = "running" | "uploading" | "done" | "failed";

export interface RenderResult {
  durationSec: number | null;
  size: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  uploaded: boolean;
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
      const built = buildRender(job, { inputs, assPath: join(e.dir, "captions.ass"), filterPath: join(e.dir, "graph.txt"), outPath: e.out });
      await writeFile(join(e.dir, "graph.txt"), built.filter);
      if (built.ass) await writeFile(join(e.dir, "captions.ass"), built.ass);
      await this.ffmpeg(built.args, job.duration, e);
      if (e.canceled) return;
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
