/**
 * Background jobs that are one ffmpeg command each (Resize). Like `/render`:
 * `POST /jobs` → 202 state, `GET /jobs/:id`, `GET /jobs/:id/file` when there
 * was no `putUrl`, `DELETE /jobs/:id`. Jobs live in memory.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resizeArgs } from "./post.ts";
import { parseProgress } from "./render.ts";

export interface ResizeJob {
  id: string;
  kind: "resize";
  media: "video" | "image";
  url: string;
  /** Short side in pixels. */
  short: 1080 | 2160;
  /** Seconds (video), for progress. */
  duration?: number;
  putUrl?: string;
}

export interface JobState {
  id: string;
  status: "running" | "uploading" | "done" | "failed";
  progress: number;
  result?: { size: number; width: number | null; height: number | null; durationSec: number | null; uploaded: boolean; contentType: string };
  error?: { code: string; message: string };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);

export class JobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateResizeJob(body: Record<string, unknown>): ResizeJob {
  if (typeof body.id !== "string" || !ID.test(body.id)) throw new JobError("BAD_REQUEST", "id is invalid");
  if (body.kind !== "resize") throw new JobError("BAD_REQUEST", "kind must be resize");
  if (body.media !== "video" && body.media !== "image") throw new JobError("BAD_REQUEST", "media must be video or image");
  if (!isHttp(body.url)) throw new JobError("BAD_REQUEST", "url must be an http(s) URL");
  if (body.short !== 1080 && body.short !== 2160) throw new JobError("BAD_REQUEST", "short must be 1080 or 2160");
  if (body.putUrl !== undefined && !isHttp(body.putUrl)) throw new JobError("BAD_REQUEST", "putUrl must be an http(s) URL");
  if (body.duration !== undefined && (typeof body.duration !== "number" || !(body.duration > 0) || body.duration > 600)) throw new JobError("BAD_REQUEST", "duration is out of range");
  return body as unknown as ResizeJob;
}

interface Entry {
  state: JobState;
  dir: string;
  out: string;
  contentType: string;
  kill: (() => void) | null;
}

export interface JobDeps {
  probe: (path: string) => Promise<{ width: number | null; height: number | null; durationSec: number | null }>;
  upload?: (url: string, path: string, size: number, contentType: string) => Promise<void>;
  ffmpeg?: string;
  workDir?: string;
}

async function defaultUpload(url: string, path: string, size: number, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream,
    headers: { "content-type": contentType, "content-length": String(size) },
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) throw new JobError("upload_failed", `Storage answered ${res.status}`);
}

export class CommandJobs {
  private jobs = new Map<string, Entry>();
  private deps: JobDeps;
  constructor(deps: JobDeps) {
    this.deps = deps;
  }

  get(id: string): JobState | null {
    return this.jobs.get(id)?.state ?? null;
  }

  file(id: string): { path: string; size: number; contentType: string } | null {
    const e = this.jobs.get(id);
    if (!e || e.state.status !== "done" || !e.state.result || e.state.result.uploaded) return null;
    return { path: e.out, size: e.state.result.size, contentType: e.contentType };
  }

  start(job: ResizeJob): JobState {
    const existing = this.jobs.get(job.id);
    if (existing) return existing.state;
    const dir = join(this.deps.workDir ?? tmpdir(), `job-${job.id}`);
    const image = job.media === "image";
    const entry: Entry = { state: { id: job.id, status: "running", progress: 0 }, dir, out: join(dir, image ? "out.png" : "out.mp4"), contentType: image ? "image/png" : "video/mp4", kill: null };
    this.jobs.set(job.id, entry);
    void this.run(job, entry);
    return entry.state;
  }

  async remove(id: string): Promise<boolean> {
    const e = this.jobs.get(id);
    if (!e) return false;
    e.kill?.();
    this.jobs.delete(id);
    await rm(e.dir, { recursive: true, force: true });
    return true;
  }

  private async run(job: ResizeJob, e: Entry): Promise<void> {
    try {
      await mkdir(e.dir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.deps.ffmpeg ?? "ffmpeg", resizeArgs(job.media, job.url, job.short, e.out), { stdio: ["ignore", "pipe", "pipe"] });
        e.kill = () => proc.kill("SIGKILL");
        let stderr = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
          const p = job.duration ? parseProgress(chunk, job.duration) : null;
          if (p !== null && p > e.state.progress) e.state = { ...e.state, progress: Math.round(p * 1000) / 1000 };
        });
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-3000)));
        proc.on("error", (err) => reject(new JobError("ffmpeg_failed", String(err))));
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new JobError("ffmpeg_failed", `ffmpeg exited with ${code}: ${stderr.trim()}`))));
      });
      const size = (await stat(e.out)).size;
      const p = await this.deps.probe(e.out);
      let uploaded = false;
      if (job.putUrl) {
        e.state = { ...e.state, status: "uploading", progress: 0.99 };
        await (this.deps.upload ?? defaultUpload)(job.putUrl, e.out, size, e.contentType);
        uploaded = true;
        await rm(e.out, { force: true });
      }
      e.state = { id: job.id, status: "done", progress: 1, result: { size, width: p.width, height: p.height, durationSec: p.durationSec, uploaded, contentType: e.contentType } };
    } catch (err) {
      const code = err instanceof JobError ? err.code : "job_failed";
      console.error(JSON.stringify({ msg: "job failed", id: job.id, code, error: String(err instanceof Error ? err.message : err).slice(0, 1500) }));
      e.state = { id: job.id, status: "failed", progress: e.state.progress, error: { code, message: code === "ffmpeg_failed" ? "The resize stopped." : String(err instanceof Error ? err.message : err).slice(0, 300) } };
    } finally {
      e.kill = null;
    }
  }
}
