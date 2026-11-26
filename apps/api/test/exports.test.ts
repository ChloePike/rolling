/**
 * Exports (canvas-flow step 11) in the workers pool: `POST /api/canvases/:id/export`
 * → ExportWorkflow with a fake FFmpeg container (renderer seam) → asset with a
 * poster and a safety rating → `export.done` on the project channel, and
 * `GET /api/exports/:id`. Failure and access paths too.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { ChatEvent, ChatRequest, LlmProvider } from "@rolling/core";
import type { RenderJob } from "@rolling/core/export";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setRendererForTests } from "../src/exports/renderer";
import { setSafetyLlmForTests } from "../src/safety/service";

const BASE = "https://example.com";
const DAY = 86_400_000;
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4]);
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);

// ---------------------------------------------------------------- fake container

interface FakeRender {
  job: RenderJob;
  polls: number;
}

const container = {
  renders: new Map<string, FakeRender>(),
  calls: [] as string[],
  /** Polls answered `running` before done. */
  runningPolls: 1,
  fail: null as { code: string; message: string } | null,
  thumbs: 0,
  deleted: [] as string[],
  reset() {
    this.renders.clear();
    this.calls = [];
    this.runningPolls = 1;
    this.fail = null;
    this.thumbs = 0;
    this.deleted = [];
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function fakeContainer(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  container.calls.push(`${method} ${path}`);
  if (path === "/render" && method === "POST") {
    const job = JSON.parse(String(init.body)) as RenderJob;
    if (!container.renders.has(job.id)) container.renders.set(job.id, { job, polls: 0 });
    return json({ id: job.id, status: "running" }, 202);
  }
  if (path === "/thumb" && method === "POST") {
    container.thumbs++;
    // Unique bytes per poster: the safety verdict cache is keyed by content hash.
    const poster = new Uint8Array([...JPEG, ...new TextEncoder().encode(crypto.randomUUID())]);
    return new Response(poster, { headers: { "content-type": "image/jpeg" } });
  }
  const m = /^\/render\/([^/]+)(\/file)?$/.exec(path);
  if (m) {
    const r = container.renders.get(decodeURIComponent(m[1]!));
    if (method === "DELETE") {
      container.deleted.push(m[1]!);
      container.renders.delete(m[1]!);
      return json({ ok: true });
    }
    if (!r) return json({ error: { code: "NOT_FOUND", message: "no such render" } }, 404);
    if (m[2]) return new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.byteLength) } });
    r.polls++;
    if (r.polls <= container.runningPolls) return json({ id: r.job.id, status: "running", progress: 0.4 * r.polls });
    if (container.fail) return json({ id: r.job.id, status: "failed", progress: 0.5, error: container.fail });
    return json({
      id: r.job.id,
      status: "done",
      progress: 1,
      result: { durationSec: r.job.duration, size: MP4.byteLength, width: r.job.width, height: r.job.height, videoCodec: "h264", audioCodec: "aac", uploaded: false },
    });
  }
  return json({ error: { code: "NOT_FOUND", message: `no route ${path}` } }, 404);
}

// ---------------------------------------------------------------- fake safety LLM

const vision = { rating: "safe" as "safe" | "suggestive" | "explicit", minorSexualized: false };

const fakeSafetyLlm: LlmProvider = {
  id: "fake-safety",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const user = req.messages.find((m) => m.role === "user")!;
    const images = typeof user.content === "string" ? 0 : user.content.filter((p) => p.type === "image_url").length;
    const image = {
      rating: vision.rating,
      confidence: 0.9,
      photographic: false,
      apparentMinor: vision.minorSexualized,
      minorSexualized: vision.minorSexualized,
      knownPerson: false,
      extremeViolence: false,
      violentExtremism: false,
      animalSexual: false,
      selfHarm: false,
    };
    const text = {
      sexualLevel: "none",
      apparentMinor: false,
      minorSexualized: false,
      realPerson: false,
      realPersonNames: [],
      realPersonSexualOrIntimate: false,
      nonConsensualSexual: false,
      extremeViolence: false,
      violentExtremism: false,
      animalSexual: false,
      selfHarm: false,
    };
    yield { type: "text", delta: JSON.stringify(images > 0 ? { images: Array.from({ length: images }, () => image) } : text) };
    yield { type: "done", id: "s", finishReason: "stop" };
  },
};

// ---------------------------------------------------------------- helpers

let seq = 0;
function newUser(tag: string): string {
  seq++;
  return `${tag}${Date.now().toString(36)}${seq}`;
}

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string, plan = true): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  if (plan) {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
      .bind(`sub_${user}`, ws, now + 30 * DAY, now)
      .run();
  }
  return { user, ws };
}

async function videoAsset(ws: string, user: string, mature = false): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const key = `ws/${ws}/uploads/${id}.mp4`;
  await env.MEDIA.put(key, MP4, { httpMetadata: { contentType: "video/mp4" } });
  await env.DB.prepare(
    "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'video', 'mine', 'clip', ?, '{\"durationSec\":5}', ?, ?, 'ready', ?)",
  )
    .bind(id, ws, key, user, Date.now(), mature ? 1 : 0)
    .run();
  return id;
}

/** A project with two generated shots (a script with a caption line) → a 2-shot cut on the timeline. */
async function project(user: string, ws: string): Promise<{ projectId: string; canvasId: string; assets: string[] }> {
  const res = await api(user, "/api/projects", { method: "POST", json: { title: "Export test" } });
  expect(res.status).toBe(201);
  const projectId = ((await res.json()) as { project: { id: string } }).project.id;
  const room = projectRoom(env, projectId);
  const caller = { userId: user, workspaceId: ws, canEdit: true };
  const r = (await room.applyPatch(caller, {
    baseRevision: 0,
    ops: [
      { op: "addNode", tempId: "a", kind: "video", title: "Shot A", params: { seconds: 4 }, position: { x: 0, y: 0 } },
      { op: "addNode", tempId: "b", kind: "video", title: "Shot B", params: { seconds: 3 }, position: { x: 300, y: 0 } },
    ],
  })) as any;
  expect(r.ok).toBe(true);
  const assets: string[] = [];
  for (const t of ["a", "b"]) {
    const nodeId = r.idMap[t];
    const asset = await videoAsset(ws, user);
    const d = (await room.inputDigest(caller, nodeId)) as any;
    expect((await room.addVersion({ nodeId, assetId: asset, inputDigest: d.digest, model: "bytedance/seedance-2.0-mini" })).ok).toBe(true);
    assets.push(asset);
  }
  return { projectId, canvasId: `cnv_${projectId.slice(4)}`, assets };
}

interface Envelope {
  type: string;
  payload: any;
}

/** Project socket collecting `export.*` events. */
async function listen(projectId: string, user: string): Promise<{ events: Envelope[]; close: () => void }> {
  const res = await api(user, `/api/projects/${projectId}/ws`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  const events: Envelope[] = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as Envelope;
    if (msg.type.startsWith("export.")) events.push(msg);
  });
  ws.accept();
  return { events, close: () => ws.close() };
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

async function finalExport(id: string): Promise<any> {
  return waitFor(`export ${id}`, async () => {
    const r = await env.DB.prepare("SELECT * FROM exports WHERE id = ?").bind(id).first<any>();
    return r && (r.status === "done" || r.status === "failed") ? r : null;
  });
}

// ---------------------------------------------------------------- setup

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => json(listing)) as unknown as typeof fetch,
  });
  setSafetyLlmForTests(() => fakeSafetyLlm);
  setRendererForTests(fakeContainer);
});

afterAll(() => {
  setSafetyLlmForTests(null);
  setRendererForTests(null);
});

beforeEach(async () => {
  container.reset();
  vision.rating = "safe";
  vision.minorSexualized = false;
  introspector = await introspectWorkflow(env.EXPORT);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
});

afterEach(async () => {
  await introspector.dispose();
});

// ---------------------------------------------------------------- tests

describe("exports", () => {
  it("renders the cut, registers a rated asset and reports progress and done on the project channel", async () => {
    const { user, ws } = await member("exp");
    const { projectId, canvasId, assets } = await project(user, ws);
    const sock = await listen(projectId, user);

    const res = await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = ((await res.json()) as any).export;
    expect(created).toMatchObject({ projectId, canvasId, preset: "mp4_720p", status: "queued", progress: 0, width: 720, height: 1280, duration: 7, url: null });
    expect(created.id).toMatch(/^exp_/);

    const row = await finalExport(created.id);
    expect(row).toMatchObject({ status: "done", progress: 1, size: MP4.byteLength });
    // The job the container got: the cut with signed input URLs for both shots.
    const submitted = container.calls.filter((c) => c === "POST /render");
    expect(submitted).toHaveLength(1);
    expect(container.calls).toContain(`GET /render/${created.id}/file`);
    expect(container.thumbs).toBe(1);
    await waitFor("container cleanup", async () => container.deleted.includes(created.id));

    const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(row.asset_id).first<any>();
    expect(asset).toMatchObject({ kind: "video", source: "generated", status: "ready", project_id: projectId, content_type: "video/mp4", rating: "safe", mature: 0, name: "Export test export" });
    expect(JSON.parse(asset.meta)).toMatchObject({ durationSec: 7, width: 720, height: 1280, exportId: created.id, thumbKey: `ws/${ws}/exports/${created.id}/poster.jpg` });
    const stored = await env.MEDIA.get(asset.r2_key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(MP4);
    const cut = (await (await env.MEDIA.get(`ws/${ws}/exports/${created.id}/edl.json`))!.json()) as any;
    expect(cut.tracks.find((t: any) => t.kind === "video").clips.map((c: any) => c.assetId)).toEqual(assets);

    await waitFor("export.done event", async () => sock.events.find((e) => e.type === "export.done"));
    const types = sock.events.map((e) => e.type);
    expect(types[0]).toBe("export.progress");
    expect(types).toContain("export.done");
    const done = sock.events.find((e) => e.type === "export.done")!.payload;
    expect(done).toMatchObject({ exportId: created.id, projectId, canvasId, assetId: row.asset_id, size: MP4.byteLength, fileName: expect.stringMatching(/\.mp4$/) });
    expect(done.url).toMatch(/\/media\/ws\//);
    const progress = sock.events.filter((e) => e.type === "export.progress").map((e) => e.payload.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toContain(0.4);
    sock.close();

    const got = await api(user, `/api/exports/${created.id}`);
    expect(got.status).toBe(200);
    const view = ((await got.json()) as any).export;
    expect(view).toMatchObject({ status: "done", progress: 1, assetId: row.asset_id, error: null });
    expect(view.url).toMatch(/^\/media\/ws\/.+\/export\.mp4\?exp=/);
  });

  it("exports a range and sends the job only the clips in it", async () => {
    const { user, ws } = await member("exprange");
    const { canvasId, assets } = await project(user, ws);
    const res = await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_1080p", range: { start: 4.5, end: 6 } } });
    expect(res.status).toBe(201);
    const created = ((await res.json()) as any).export;
    expect(created).toMatchObject({ duration: 1.5, width: 1080, height: 1920, range: { start: 4.5, end: 6 } });
    await finalExport(created.id);
    const cut = (await (await env.MEDIA.get(`ws/${ws}/exports/${created.id}/edl.json`))!.json()) as any;
    expect(cut.tracks.find((t: any) => t.kind === "video").clips).toMatchObject([{ assetId: assets[1], start: 0, in: 0.5, out: 2 }]);
  });

  it("marks the export failed and sends export.failed when the renderer fails", async () => {
    const { user, ws } = await member("expfail");
    const { projectId, canvasId } = await project(user, ws);
    const sock = await listen(projectId, user);
    container.fail = { code: "ffmpeg_failed", message: "The renderer stopped." };
    const created = ((await (await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_1080p" } })).json()) as any).export;
    const row = await finalExport(created.id);
    expect(row).toMatchObject({ status: "failed", error_code: "ffmpeg_failed", error_message: "The renderer stopped.", asset_id: null });
    await waitFor("export.failed event", async () => sock.events.find((e) => e.type === "export.failed"));
    expect(sock.events.find((e) => e.type === "export.failed")!.payload).toMatchObject({ exportId: created.id, code: "ffmpeg_failed", reason: "The renderer stopped." });
    const view = ((await (await api(user, `/api/exports/${created.id}`)).json()) as any).export;
    expect(view).toMatchObject({ status: "failed", url: null, error: { code: "ffmpeg_failed" } });
    sock.close();
  });

  it("fails with renderer_unavailable when the container does not answer", async () => {
    const { user, ws } = await member("expdown");
    const { canvasId } = await project(user, ws);
    setRendererForTests(async () => {
      throw new Error("connection refused");
    });
    try {
      const created = ((await (await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } })).json()) as any).export;
      expect(await finalExport(created.id)).toMatchObject({ status: "failed", error_code: "renderer_unavailable" });
    } finally {
      setRendererForTests(fakeContainer);
    }
  });

  it("fails without delivering when the poster breaks a hard limit (D-005)", async () => {
    const { user, ws } = await member("expsafe");
    const { canvasId } = await project(user, ws);
    vision.rating = "suggestive";
    vision.minorSexualized = true;
    const created = ((await (await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } })).json()) as any).export;
    const row = await finalExport(created.id);
    expect(row).toMatchObject({ status: "failed", error_code: "SAFETY_BLOCKED" });
    expect(await env.MEDIA.head(`ws/${ws}/exports/${created.id}/export.mp4`)).toBeNull();
  });

  it("checks plan, role, body and access", async () => {
    const { user, ws } = await member("expacc");
    const { canvasId } = await project(user, ws);
    expect((await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_4k" } })).status).toBe(400);
    expect((await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p", range: { start: 3, end: 2 } } })).status).toBe(400);
    const empty = await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p", range: { start: 50, end: 60 } } });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as any).error.data).toMatchObject({ reason: "BAD_RANGE" });
    expect((await api(null, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } })).status).toBe(401);

    const stranger = await member("expstranger");
    expect((await api(stranger.user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } })).status).toBe(404);

    const free = await member("expfree", false);
    const p = await project(free.user, free.ws);
    const noPlan = await api(free.user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } });
    expect(noPlan.status).toBe(402);
    expect(((await noPlan.json()) as any).error.code).toBe("NO_PLAN");

    const created = ((await (await api(user, `/api/canvases/${canvasId}/export`, { method: "POST", json: { preset: "mp4_720p" } })).json()) as any).export;
    await finalExport(created.id);
    expect((await api(stranger.user, `/api/exports/${created.id}`)).status).toBe(404);
    expect((await api(user, "/api/exports/exp_NOPE")).status).toBe(404);
  });
});
