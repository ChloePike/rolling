/**
 * Post-production in the workers pool (D-033 .. D-037): auto captions with a
 * mocked Workers AI Whisper and a fake FFmpeg container, extend clip (quote →
 * start → planned clip → a failed run takes it back; a commit gives it the
 * asset), export presets and options (batch, reframe, -14 LUFS, captions,
 * brand kit, preview), brand kit CRUD, voiceover split, resize plan caps,
 * voice rights and the agent's context.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { RenderJob } from "@rolling/core/export";
import type { Edl, MediaClip } from "@rolling/core/timeline";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setRendererForTests } from "../src/exports/renderer";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { setFramesContainerForTests } from "../src/runs/frames";
import { setPostContainerForTests, setWhisperForTests } from "../src/post/seams";
import { settlePlacement } from "../src/post/placements";
import { postContext } from "../src/post/agentContext";

const BASE = "https://example.com";
const DAY = 86_400_000;
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const WOFF2 = new Uint8Array([...new TextEncoder().encode("wOF2"), 0, 1, 0, 0, 0, 0, 0, 0]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- fakes

const fake = {
  renders: new Map<string, RenderJob>(),
  jobs: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
  whisperCalls: 0,
  whisperLanguage: undefined as string | undefined,
  silences: [{ start: 1.4, end: 2.2 }, { start: 3.6, end: 4.4 }],
  reset() {
    this.renders.clear();
    this.jobs.clear();
    this.calls = [];
    this.whisperCalls = 0;
    this.whisperLanguage = undefined;
  },
};

async function renderer(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  fake.calls.push(`${method} ${path}`);
  if (path === "/render" && method === "POST") {
    const job = JSON.parse(String(init.body)) as RenderJob;
    fake.renders.set(job.id, job);
    return json({ id: job.id, status: "running" }, 202);
  }
  if (path === "/jobs" && method === "POST") {
    const job = JSON.parse(String(init.body)) as Record<string, unknown>;
    fake.jobs.set(String(job.id), job);
    return json({ id: job.id, status: "running", progress: 0 }, 202);
  }
  if (path === "/thumb") return new Response(PNG, { headers: { "content-type": "image/jpeg" } });
  const j = /^\/jobs\/([^/]+)(\/file)?$/.exec(path);
  if (j) {
    const job = fake.jobs.get(j[1]!);
    if (method === "DELETE") return json({ ok: true });
    if (!job) return json({ error: { code: "NOT_FOUND" } }, 404);
    if (j[2]) return new Response(job.media === "image" ? PNG : MP4);
    const short = Number(job.short);
    return json({ id: job.id, status: "done", progress: 1, result: { size: 16, width: (short * 16) / 9, height: short, durationSec: job.media === "video" ? 5 : null, uploaded: false, contentType: job.media === "image" ? "image/png" : "video/mp4" } });
  }
  const m = /^\/render\/([^/?]+)(\/file)?(\?part=(\d+))?$/.exec(path);
  if (m) {
    const job = fake.renders.get(decodeURIComponent(m[1]!));
    if (method === "DELETE") return json({ ok: true });
    if (!job) return json({ error: { code: "NOT_FOUND" } }, 404);
    if (m[2] && m[4] !== undefined) return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    if (m[2]) return new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.byteLength) } });
    if (job.audioOnly) return json({ id: job.id, status: "done", progress: 1, result: { durationSec: job.duration, size: 14, width: null, height: null, videoCodec: null, audioCodec: "mp3", uploaded: false, parts: 1 } });
    return json({ id: job.id, status: "done", progress: 1, result: { durationSec: job.duration, size: MP4.byteLength, width: job.width, height: job.height, videoCodec: "h264", audioCodec: "aac", uploaded: false } });
  }
  return json({ error: { code: "NOT_FOUND", message: path } }, 404);
}

async function postContainer(_env: Env, path: string, body: unknown): Promise<Response> {
  fake.calls.push(`POST ${path}`);
  if (path === "/last-frame") return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (path === "/frames") return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (path === "/audio-cut") return new Response(MP3, { headers: { "content-type": "audio/mp4" } });
  if (path === "/silences") {
    const b = body as { start: number };
    // Relative to the requested start, like the container.
    return json({ silences: fake.silences.map((s) => ({ start: s.start - b.start, end: s.end - b.start })) });
  }
  return json({ error: { code: "NOT_FOUND" } }, 404);
}

const WHISPER_EN = {
  text: "Fresh coffee every morning. Come by the shop.",
  transcription_info: { language: "en", language_probability: 0.97, duration: 4 },
  segments: [
    {
      start: 0.3,
      end: 3.6,
      text: " Fresh coffee every morning. Come by the shop.",
      words: [
        { word: " Fresh", start: 0.3, end: 0.6 },
        { word: " coffee", start: 0.6, end: 1.0 },
        { word: " every", start: 1.0, end: 1.3 },
        { word: " morning.", start: 1.3, end: 1.9 },
        { word: " Come", start: 2.3, end: 2.6 },
        { word: " by", start: 2.6, end: 2.8 },
        { word: " the", start: 2.8, end: 2.9 },
        { word: " shop.", start: 2.9, end: 3.6 },
      ],
    },
  ],
};

/** Gateway: every generation request is refused, so a started run fails (and refunds) quickly. */
const refusingGateway = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname === "/v1/chat/completions") {
    const chunk = { id: "c1", choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  return json({ error: { message: "bad request", type: "invalid_request_error", code: "invalid_request" } }, 400, );
}) as typeof fetch;

// ---------------------------------------------------------------- helpers

let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string, plan: "starter" | "plus" | "pro" | null = "plus"): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  if (plan) {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, 'month', 'active', ?, 0, ?)")
      .bind(`sub_${user}`, ws, plan, now + 30 * DAY, now)
      .run();
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    expect((await stub.grant({ planId: plan, interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
    expect((await stub.purchase(5000, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  }
  return { user, ws };
}

async function asset(ws: string, user: string, kind: "video" | "audio" | "image", meta: Record<string, unknown> = {}, source = "generated"): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const key = `ws/${ws}/uploads/${id}.${kind === "video" ? "mp4" : kind === "audio" ? "m4a" : "png"}`;
  await env.MEDIA.put(key, kind === "image" ? PNG : MP4);
  await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0)")
    .bind(id, ws, kind, source, `${kind} file`, key, JSON.stringify({ durationSec: 5, width: 1920, height: 1080, ...meta }), user, Date.now())
    .run();
  return id;
}

/** A project whose timeline has two shots, a voice clip and music. */
async function project(user: string, ws: string): Promise<{ projectId: string; canvasId: string; shots: string[]; voice: string }> {
  const res = await api(user, "/api/projects", { method: "POST", json: { title: "Post test" } });
  const projectId = ((await res.json()) as { project: { id: string } }).project.id;
  const canvasId = `cnv_${projectId.slice(4)}`;
  const shots = [await asset(ws, user, "video"), await asset(ws, user, "video")];
  const voice = await asset(ws, user, "audio", { durationSec: 6 }, "mine");
  const music = await asset(ws, user, "audio", { durationSec: 10 }, "mine");
  const room = projectRoom(env, projectId);
  const caller = { userId: user, workspaceId: ws, canEdit: true };
  const t = (await room.getTimeline(caller, canvasId)) as { ok: true; timeline: { revision: number } };
  const edl: Edl = {
    fps: 24,
    width: 1920,
    height: 1080,
    tracks: [
      { id: "C1", kind: "caption", clips: [] },
      { id: "V1", kind: "video", clips: [{ id: "v1", assetId: shots[0]!, in: 0, out: 3, start: 0 }, { id: "v2", assetId: shots[1]!, in: 0, out: 3, start: 3 }] },
      { id: "A1", kind: "voice", clips: [{ id: "a1", assetId: voice, in: 0, out: 6, start: 0 }] },
      { id: "A2", kind: "music", clips: [{ id: "m1", assetId: music, in: 0, out: 6, start: 0 }] },
    ],
  };
  const r = (await room.patchTimeline(caller, { canvasId, baseRevision: t.timeline.revision, ops: [{ op: "replaceEdl", edl, baseRevision: t.timeline.revision }] })) as { ok: boolean };
  expect(r.ok).toBe(true);
  return { projectId, canvasId, shots, voice };
}

async function timeline(canvasId: string, user: string): Promise<{ revision: number; edl: Edl }> {
  return (await (await api(user, `/api/canvases/${canvasId}/timeline`)).json()) as { revision: number; edl: Edl };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function finished(user: string, jobId: string): Promise<any> {
  return waitFor(`post job ${jobId}`, async () => {
    const j = ((await (await api(user, `/api/post-jobs/${jobId}`)).json()) as any).job;
    return j && (j.status === "done" || j.status === "failed") ? j : null;
  });
}

// ---------------------------------------------------------------- setup

const introspectors: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
  setRendererForTests(renderer);
  setPostContainerForTests(postContainer);
  setFramesContainerForTests(postContainer);
  setGatewayFetchForTests(refusingGateway);
  setWhisperForTests(async (input) => {
    fake.whisperCalls++;
    fake.whisperLanguage = input.language;
    expect(atob(input.audio).charCodeAt(0)).toBe(0x49);
    return WHISPER_EN;
  });
});

afterAll(() => {
  setRendererForTests(null);
  setPostContainerForTests(null);
  setFramesContainerForTests(null);
  setGatewayFetchForTests(null);
  setWhisperForTests(null);
});

beforeEach(async () => {
  fake.reset();
  for (const wf of [env.POST, env.EXPORT, env.GENERATE]) {
    const i = await introspectWorkflow(wf);
    await i.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    introspectors.push(i);
  }
});

afterEach(async () => {
  while (introspectors.length) await introspectors.pop()!.dispose();
});

// ---------------------------------------------------------------- tests

describe("auto captions (D-033)", () => {
  it("transcribes the timeline's audio with Whisper and puts timed, styled captions on the caption track", async () => {
    const { user } = await member("cap");
    const ws = personalWorkspaceId(user);
    const p = await project(user, ws);
    const res = await api(user, `/api/canvases/${p.canvasId}/captions`, { method: "POST", json: { source: { kind: "timeline" }, style: "bold_social" } });
    expect(res.status).toBe(202);
    const created = ((await res.json()) as any).job;
    expect(created).toMatchObject({ kind: "captions", status: "queued" });
    const done = await finished(user, created.id);
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    expect(done.result).toMatchObject({ language: "en", audioSeconds: 6 });
    expect(fake.whisperCalls).toBe(1);
    expect(fake.whisperLanguage).toBeUndefined();
    // The container rendered a mono 16 kHz audio mix of the cut, no picture.
    const job = [...fake.renders.values()][0]!;
    expect(job.audioOnly).toEqual({ sampleRate: 16000, chunkSeconds: 240 });
    const t = await timeline(p.canvasId, user);
    const track = t.edl.tracks.find((x) => x.kind === "caption")!;
    expect(track).toMatchObject({ style: "bold_social", lang: "en" });
    const texts = track.clips.map((c: any) => c.text);
    expect(texts.join(" ")).toBe("Fresh coffee every morning. Come by the shop.");
    for (const c of track.clips as any[]) expect(c.text).not.toContain("\n");
    expect((track.clips[0] as any).start).toBeCloseTo(0.3, 3);
    // The transcript is kept in R2 for the job.
    expect(await env.MEDIA.head(done.result.transcriptKey)).not.toBeNull();
  });

  it("captions one voice clip in a requested language, stores the transcript on the voiceover, and checks plan and input", async () => {
    const { user, ws } = await member("cap2");
    const p = await project(user, ws);
    const created = ((await (await api(user, `/api/canvases/${p.canvasId}/captions`, { method: "POST", json: { source: { kind: "clip", clipId: "a1" }, language: "en", transcriptOnly: true } })).json()) as any).job;
    expect(created.kind).toBe("transcript");
    const done = await finished(user, created.id);
    expect(done.status).toBe("done");
    expect(fake.whisperLanguage).toBe("en");
    // Transcript only: the caption track stays empty; the voice asset carries the transcript.
    expect((await timeline(p.canvasId, user)).edl.tracks[0]!.clips).toHaveLength(0);
    const meta = JSON.parse((await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(p.voice).first<{ meta: string }>())!.meta);
    expect(meta.transcript).toMatchObject({ language: "en", text: WHISPER_EN.text });
    // The agent's context gets the voiceover's length and transcript.
    const ctx = await postContext(env, { workspaceId: ws, userId: user, projectId: p.projectId, canvasId: p.canvasId });
    expect(ctx.voiceover).toContain("for 6 s");
    expect(ctx.voiceover).toContain("Fresh coffee every morning.");

    expect((await api(user, `/api/canvases/${p.canvasId}/captions`, { method: "POST", json: { source: { kind: "clip", clipId: "nope" } } })).status).toBe(422);
    expect((await api(user, `/api/canvases/${p.canvasId}/captions`, { method: "POST", json: { style: "fancy" } })).status).toBe(400);
    const free = await member("cap3", null);
    const fp = await project(free.user, free.ws);
    expect((await api(free.user, `/api/canvases/${fp.canvasId}/captions`, { method: "POST", json: {} })).status).toBe(402);
  });

  it("caps captioning per workspace per day", async () => {
    const { user, ws } = await member("cap4");
    const p = await project(user, ws);
    await env.DB.prepare("INSERT INTO post_jobs (id, kind, workspace_id, status, audio_seconds, created_by, created_at) VALUES (?, 'captions', ?, 'done', ?, ?, ?)")
      .bind(`pjb_X${seq}`, ws, 240 * 60, user, Date.now())
      .run();
    const res = await api(user, `/api/canvases/${p.canvasId}/captions`, { method: "POST", json: {} });
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.data.reason).toBe("DAILY_LIMIT");
  });
});

describe("extend clip (D-036)", () => {
  it("quotes i2v from the last frame, plans the clip after the original, and a failed run takes it back", async () => {
    const { user, ws } = await member("ext");
    const p = await project(user, ws);
    const q = await api(user, `/api/canvases/${p.canvasId}/extend/quote`, { method: "POST", json: { clipId: "v1", prompt: "She keeps walking toward the door", seconds: 5 } });
    expect(q.status).toBe(200);
    const quote = (await q.json()) as any;
    expect(fake.calls).toContain("POST /last-frame");
    expect(quote.quoteId).toBeTruthy();
    expect(quote.placementId).toMatch(/^plc_/);
    expect(quote.total).toBeGreaterThan(0);
    expect(quote.items[0]).toMatchObject({ action: "run", kind: "video" });
    const frame = await env.DB.prepare("SELECT kind, source, meta FROM assets WHERE id = ?").bind(quote.frameAssetId).first<{ kind: string; source: string; meta: string }>();
    expect(frame).toMatchObject({ kind: "image", source: "generated" });
    expect(JSON.parse(frame!.meta)).toMatchObject({ frameOf: "last" });
    const spec = JSON.parse((await env.DB.prepare("SELECT request FROM quotes WHERE id = ?").bind(quote.quoteId).first<{ request: string }>())!.request).promptSpec;
    expect(spec).toMatchObject({ kind: "video", inputs: { firstFrameAssetId: quote.frameAssetId }, ratio: "16:9", seconds: 5 });

    const start = await api(user, `/api/canvases/${p.canvasId}/placed-runs`, { method: "POST", json: { quoteId: quote.quoteId } });
    expect(start.status).toBe(201);
    const started = (await start.json()) as any;
    expect(started.placedClipId).toMatch(/^ext/);
    // The run fails at the gateway; its planned clip is removed and v2 moves back.
    await waitFor("placement dropped", async () => (await env.DB.prepare("SELECT status FROM timeline_placements WHERE run_id = ?").bind(started.runId).first<{ status: string }>())?.status === "dropped");
    const after = await timeline(p.canvasId, user);
    const v = after.edl.tracks.find((t) => t.id === "V1")!.clips as MediaClip[];
    expect(v.map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(v[1]!.start).toBe(3);
  });

  it("a committed run gives the planned clip its asset and real length; later clips follow", async () => {
    const { user, ws } = await member("ext2");
    const p = await project(user, ws);
    const room = projectRoom(env, p.projectId);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const t = await timeline(p.canvasId, user);
    // A pending placement as `startPlaced` leaves it: ext1 (5 s, first frame skipped) after v1, v2 moved right.
    const ops = [
      { op: "move", clipId: "v2", start: 3 + 5 - 1 / 24 },
      { op: "insert", trackId: "V1", clip: { id: "ext1", assetId: null, in: 1 / 24, out: 5, start: 3 } },
    ];
    expect(((await room.patchTimeline(caller, { canvasId: p.canvasId, baseRevision: t.revision, ops })) as any).ok).toBe(true);
    await env.DB.prepare(
      "INSERT INTO timeline_placements (id, quote_id, run_id, workspace_id, project_id, canvas_id, mode, anchor_clip_id, placed_clip_id, seconds, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'after', 'v1', 'ext1', 5, 'pending', ?, ?, ?)",
    )
      .bind(`plc_T${seq}`, `qt_T${seq}`, `run_T${seq}`, ws, p.projectId, p.canvasId, user, Date.now(), Date.now())
      .run();
    const out = await asset(ws, user, "video", { durationSec: 4 });
    await settlePlacement(env, `run_T${seq}`, out);
    const v = (await timeline(p.canvasId, user)).edl.tracks.find((x) => x.id === "V1")!.clips as MediaClip[];
    const ext = v.find((c) => c.id === "ext1")!;
    expect(ext).toMatchObject({ assetId: out, out: 4 });
    expect(v.find((c) => c.id === "v2")!.start).toBeCloseTo(3 + 4 - 1 / 24, 5);
  });

  it("refuses non-shots and non-members", async () => {
    const { user, ws } = await member("ext3");
    const p = await project(user, ws);
    expect((await api(user, `/api/canvases/${p.canvasId}/extend/quote`, { method: "POST", json: { clipId: "a1", prompt: "go on" } })).status).toBe(422);
    const free = await member("ext4", null);
    const fp = await project(free.user, free.ws);
    expect((await api(free.user, `/api/canvases/${fp.canvasId}/extend/quote`, { method: "POST", json: { clipId: "v1", prompt: "go on" } })).status).toBe(402);
  });
});

describe("export presets and options (D-034, D-035)", () => {
  it("batch-exports social presets with reframing, platform encode, captions, smoother motion and the brand kit", async () => {
    const { user, ws } = await member("exp");
    const p = await project(user, ws);
    const room = projectRoom(env, p.projectId);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const t = await timeline(p.canvasId, user);
    await room.patchTimeline(caller, { canvasId: p.canvasId, baseRevision: t.revision, ops: [{ op: "insert", trackId: "C1", clip: { id: "c1", start: 0.5, end: 2, text: "Hello" } }, { op: "setCaptionTrack", trackId: "C1", style: "clean", lang: "en" }] });
    const logo = await asset(ws, user, "image", {}, "mine");
    expect((await api(user, "/api/brand-kit", { method: "PUT", json: { logoAssetId: logo, colors: ["#3b82f6"], watermark: { enabled: true, position: "top_left" }, outro: { enabled: true, text: "See you" } } })).status).toBe(200);
    const res = await api(user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "vertical_9x16", presets: ["square_1x1", "landscape_16x9"], options: { interpolate: 60, brand: true } } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.exports.map((e: any) => [e.preset, e.width, e.height])).toEqual([["vertical_9x16", 1080, 1920], ["square_1x1", 1080, 1080], ["landscape_16x9", 1920, 1080]]);
    expect(new Set(body.exports.map((e: any) => e.batchId))).toEqual(new Set([body.exports[0].id]));
    await waitFor("renders", async () => fake.renders.size === 3);
    const jobs = [...fake.renders.values()];
    const vertical = jobs.find((j) => j.width === 1080 && j.height === 1920)!;
    const wide = jobs.find((j) => j.width === 1920)!;
    expect(vertical.reframe).toBe(true);
    expect(wide.reframe).toBe(false);
    expect(vertical.encode).toMatchObject({ videoKbps: 8000, loudnessLufs: -14, profile: "high" });
    expect(vertical.interpolateFps).toBe(60);
    expect(vertical.voiceLufs).toBe(-16);
    expect(vertical.captions!.look).toMatchObject({ id: "clean", boxColor: "#3B82F6", text: "#FFFFFF", fontFamily: "Noto Sans" });
    expect(vertical.brand!.watermark).toMatchObject({ position: "top_left" });
    expect(vertical.brand!.watermark!.url).toMatch(/^https?:\/\//);
    expect(vertical.brand!.outro).toMatchObject({ text: "See you", background: "#3B82F6", color: "#FFFFFF" });
  });

  it("burns no captions when off, previews without an asset, and validates options", async () => {
    const { user, ws } = await member("exp2");
    const p = await project(user, ws);
    const pre = await api(user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "vertical_9x16", range: { start: 1, end: 4 }, options: { preview: true, interpolate: 48, burnCaptions: false } } });
    expect(pre.status).toBe(201);
    const created = ((await pre.json()) as any).export;
    expect(created).toMatchObject({ preview: true, width: 540, height: 960 });
    const row = await waitFor("preview done", async () => {
      const r = await env.DB.prepare("SELECT * FROM exports WHERE id = ?").bind(created.id).first<any>();
      return r?.status === "done" || r?.status === "failed" ? r : null;
    });
    expect(row.status).toBe("done");
    expect(row.asset_id).toBeNull();
    const job = fake.renders.get(created.id)!;
    expect(job.captions).toBeNull();
    expect(job.encode!.crf).toBe(26);
    const view = ((await (await api(user, `/api/exports/${created.id}`)).json()) as any).export;
    expect(view.url).toBeTruthy();
    expect(view.fileName).toMatch(/-9x16-preview\.mp4$/);
    expect((await api(user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "vertical_9x16", options: { preview: true } } })).status).toBe(422);
    expect((await api(user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "vertical_9x16", options: { interpolate: 30 } } })).status).toBe(400);
  });
});

describe("brand kit (D-035)", () => {
  it("reads, updates, uploads and removes fonts, and summarises for the agent", async () => {
    const { user, ws } = await member("bk");
    const empty = ((await (await api(user, "/api/brand-kit")).json()) as any).brandKit;
    expect(empty).toMatchObject({ logoAssetId: null, colors: [], fonts: [], updatedAt: null });
    const font = await api(user, "/api/brand-kit/fonts", { method: "POST", body: WOFF2, headers: { "content-type": "font/woff2", "x-file-name": "Inter-Bold.woff2", "x-license-confirmed": "true" } });
    expect(font.status).toBe(201);
    const kit = ((await font.json()) as any).brandKit;
    expect(kit.fonts[0]).toMatchObject({ family: "Inter Bold", format: "woff2", licenseConfirmed: true });
    expect(kit.fonts[0].url).toBeTruthy();
    const fontId = kit.fonts[0].id;
    expect(await env.MEDIA.head(`ws/${ws}/brand/fonts/${fontId}.woff2`)).not.toBeNull();
    // No license confirmation, a wrong signature or an unknown type are refused.
    expect((await api(user, "/api/brand-kit/fonts", { method: "POST", body: WOFF2, headers: { "content-type": "font/woff2", "x-file-name": "a.woff2" } })).status).toBe(422);
    expect((await api(user, "/api/brand-kit/fonts", { method: "POST", body: PNG, headers: { "content-type": "font/ttf", "x-file-name": "a.ttf", "x-license-confirmed": "true" } })).status).toBe(415);
    expect((await api(user, "/api/brand-kit/fonts", { method: "POST", body: PNG, headers: { "content-type": "application/octet-stream", "x-file-name": "a.exe", "x-license-confirmed": "true" } })).status).toBe(415);
    const put = await api(user, "/api/brand-kit", { method: "PUT", json: { colors: ["#ff0000"], captionFontId: fontId, tone: "Warm, plain words.", intro: { enabled: true, text: "Hi" } } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).brandKit).toMatchObject({ colors: ["#FF0000"], captionFontId: fontId, intro: { enabled: true, text: "Hi", seconds: 2 } });
    expect((await api(user, "/api/brand-kit", { method: "PUT", json: { colors: ["red"] } })).status).toBe(400);
    const other = await member("bk2");
    const foreignLogo = await asset(other.ws, other.user, "image", {}, "mine");
    expect((await api(user, "/api/brand-kit", { method: "PUT", json: { logoAssetId: foreignLogo } })).status).toBe(422);
    const ctx = await postContext(env, { workspaceId: ws, userId: user, projectId: null, canvasId: null });
    expect(ctx.brandKit).toBe("colors #FF0000 (primary #FF0000); caption font “Inter Bold”; intro card “Hi”. Tone: Warm, plain words.");
    const del = await api(user, `/api/brand-kit/fonts/${fontId}`, { method: "DELETE" });
    expect(((await del.json()) as any).brandKit).toMatchObject({ fonts: [], captionFontId: null });
    expect(await env.MEDIA.head(`ws/${ws}/brand/fonts/${fontId}.woff2`)).toBeNull();
  });
});

describe("imported voiceover (D-037)", () => {
  it("splits a voice clip on its pauses and lines the parts up with the shots", async () => {
    const { user, ws } = await member("vo");
    const p = await project(user, ws);
    fake.silences = [{ start: 2.6, end: 3.2 }];
    const res = await api(user, `/api/canvases/${p.canvasId}/voiceover/split`, { method: "POST", json: { clipId: "a1", assign: true } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.parts).toEqual(["a1", "a2"]);
    const voice = (await timeline(p.canvasId, user)).edl.tracks.find((t) => t.id === "A1")!.clips as MediaClip[];
    expect(voice.map((c) => [c.id, c.start, c.in, c.out])).toEqual([["a1", 0, 0, 2.9], ["a2", 3, 2.9, 6]]);
    expect((await api(user, `/api/canvases/${p.canvasId}/voiceover/split`, { method: "POST", json: { clipId: "v1" } })).status).toBe(422);
  });

  it("lip-sync needs the voice rights note, then quotes the Avatar model with the voice part", async () => {
    const { user, ws } = await member("ls");
    const p = await project(user, ws);
    const refused = await api(user, `/api/canvases/${p.canvasId}/lipsync/quote`, { method: "POST", json: { shotClipId: "v1", voiceClipId: "a1" } });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.data.reason).toBe("VOICE_RIGHTS_REQUIRED");
    expect((await api(user, `/api/assets/${p.voice}/voice-rights`, { method: "POST" })).status).toBe(200);
    const q = await api(user, `/api/canvases/${p.canvasId}/lipsync/quote`, { method: "POST", json: { shotClipId: "v1", voiceClipId: "a1" } });
    expect(q.status).toBe(200);
    const quote = (await q.json()) as any;
    expect(fake.calls).toContain("POST /audio-cut");
    expect(quote.items[0]).toMatchObject({ kind: "video" });
    const cut = JSON.parse((await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(quote.audioAssetId).first<{ meta: string }>())!.meta);
    expect(cut).toMatchObject({ derivedFrom: p.voice, durationSec: 6 });
    expect(cut.voiceRights).toBeTruthy();
  });
});

describe("resize (D-034)", () => {
  it("is Lanczos scaling within the plan caps, saved as a new asset", async () => {
    const plus = await member("rz", "plus");
    const video = await asset(plus.ws, plus.user, "video", { width: 1280, height: 720 });
    const r = await api(plus.user, `/api/assets/${video}/resize`, { method: "POST", json: { target: "1080p" } });
    expect(r.status).toBe(202);
    const job = ((await r.json()) as any).job;
    const done = await finished(plus.user, job.id);
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    const out = await env.DB.prepare("SELECT kind, name, meta FROM assets WHERE id = ?").bind(done.result.assetId).first<{ kind: string; name: string; meta: string }>();
    expect(out!.kind).toBe("video");
    expect(out!.name).toContain("(1080p)");
    expect(JSON.parse(out!.meta)).toMatchObject({ derivedFrom: video, resize: { target: "1080p", ai: false } });
    expect(fake.jobs.get(job.id)).toMatchObject({ kind: "resize", media: "video", short: 1080 });
    // 4K video needs Pro; Starter can't make 1080p video; already large is refused.
    const fourK = await api(plus.user, `/api/assets/${video}/resize`, { method: "POST", json: { target: "4K" } });
    expect(fourK.status).toBe(402);
    expect(((await fourK.json()) as any).error.data.lowestPlan).toBe("pro");
    const starter = await member("rz2", "starter");
    const sv = await asset(starter.ws, starter.user, "video", { width: 1280, height: 720 });
    expect((await api(starter.user, `/api/assets/${sv}/resize`, { method: "POST", json: { target: "1080p" } })).status).toBe(402);
    const simg = await asset(starter.ws, starter.user, "image", { width: 1024, height: 1024 });
    expect((await api(starter.user, `/api/assets/${simg}/resize`, { method: "POST", json: { target: "1080p" } })).status).toBe(202);
    const big = await asset(plus.ws, plus.user, "video", { width: 1920, height: 1080 });
    expect((await api(plus.user, `/api/assets/${big}/resize`, { method: "POST", json: { target: "1080p" } })).status).toBe(422);
  });
});

describe("extend through the shared run flow", () => {
  it("a run started with POST /api/runs is found by its quote and placed when it lands", async () => {
    const { user, ws } = await member("ext5");
    const p = await project(user, ws);
    const quote = (await (await api(user, `/api/canvases/${p.canvasId}/extend/quote`, { method: "POST", json: { clipId: "v2", prompt: "Pan to the window" } })).json()) as any;
    const now = Date.now();
    await env.DB.prepare("INSERT INTO runs (id, workspace_id, project_id, scope, status, quote_id, created_by, created_at) VALUES (?, ?, ?, 'spec', 'running', ?, ?, ?)")
      .bind(`run_Q${seq}`, ws, p.projectId, quote.quoteId, user, now)
      .run();
    const out = await asset(ws, user, "video", { durationSec: 5 });
    await settlePlacement(env, `run_Q${seq}`, out);
    const v = (await timeline(p.canvasId, user)).edl.tracks.find((x) => x.id === "V1")!.clips as MediaClip[];
    expect(v.map((c) => c.assetId)).toEqual([p.shots[0], p.shots[1], out]);
    expect(v[2]).toMatchObject({ start: 6, out: 5 });
    expect(v[2]!.in).toBeCloseTo(1 / 24, 5);
    expect((await env.DB.prepare("SELECT status, run_id FROM timeline_placements WHERE quote_id = ?").bind(quote.quoteId).first<any>())).toMatchObject({ status: "placed", run_id: `run_Q${seq}` });
  });
});
