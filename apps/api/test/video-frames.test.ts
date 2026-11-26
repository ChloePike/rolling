/**
 * Video outputs without a provider poster (workers pool, fake gateway, fake
 * FfmpegRenderer `/frames`, fake safety LLM): stills from the stored clip are
 * the poster, the post-output hard-limit check and the rating; container down
 * → the clip is unrated and waits for review (D-005).
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { ChatEvent, ChatRequest, LlmProvider } from "@rolling/core";
import { FACE_DETECT_MODEL, type ImageAssessment, type TextAssessment } from "@rolling/core/safety";
import { personalWorkspaceId } from "../src/auth/workspace";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { setFramesContainerForTests } from "../src/runs/frames";
import { outputFrameTimes } from "../src/runs/jobs";
import { ContainerUnavailable } from "../src/queues/mediaProcess";
import { rateAsset, setSafetyLlmForTests } from "../src/safety/service";

/** Fake FfmpegRenderer `/frames` (no R2 S3 credentials in tests: one PNG per call). */
const frames = { calls: [] as { url: string; times: number[]; width: number }[], down: false };
async function fakeContainer(_env: Env, path: string, body: unknown): Promise<Response> {
  if (frames.down) throw new ContainerUnavailable("container down (test)");
  if (path !== "/frames") throw new Error(`fake container: no ${path}`);
  const b = body as { url: string; times: number[]; width: number };
  frames.calls.push(b);
  return new Response(uniquePng(`frame:${b.times.join(",")}`), { headers: { "content-type": "image/png" } });
}

const BASE = "https://example.com";
const DAY = 86_400_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

function uniquePng(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG, ...new TextEncoder().encode(`${tag}:${crypto.randomUUID()}`)]);
}

// ---------------------------------------------------------------------------
// Fake generation gateway (images only) and fake safety LLM
// ---------------------------------------------------------------------------

const gateway = {
  creates: 0,
  seq: 0,
  bodies: [] as any[],
  paths: [] as string[],
  /** Fail video jobs with this provider error (non-retryable codes end the job). */
  failVideo: null as { code: string; message: string } | null,
  /** Keep image jobs running (cancel tests). */
  holdImages: false,
  /** The provider has no poster for its clips (404 on the thumbnail variant). */
  noPoster: true,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  // Unique bytes per output: verdicts are cached by content hash.
  if (url.hostname === "cdn.fake") {
    if (url.pathname.endsWith(".mp4")) return new Response(new Uint8Array([...MP4, ...new TextEncoder().encode(url.pathname)]), { headers: { "content-type": "video/mp4" } });
    return new Response(uniquePng(url.pathname), { headers: { "content-type": "image/png" } });
  }
  if (url.pathname === "/v1/chat/completions") {
    // Auto classifier: no answer → deterministic fallback.
    return new Response(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (req.method === "POST" && (url.pathname.startsWith("/v1/images/") || url.pathname === "/v1/videos")) {
    gateway.creates++;
    gateway.paths.push(url.pathname);
    gateway.bodies.push(await req.clone().json().catch(() => null));
    const video = url.pathname === "/v1/videos";
    return video ? json({ id: `vid_${++gateway.seq}`, object: "video", status: "queued" }) : json({ id: `gen_${++gateway.seq}`, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) {
    if (gateway.holdImages) return json({ data: { id: gen[1], kind: "image", status: "running" } });
    return json({ data: { id: gen[1], kind: "image", status: "done", usage: { cost: 0.013 }, outputs: [{ url: `https://cdn.fake/${gen[1]}.png` }] } });
  }
  const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname);
  if (content) {
    const variant = url.searchParams.get("variant");
    if (variant === "thumbnail" && gateway.noPoster) return json({ error: { message: "no thumbnail", code: "not_found" } }, 404);
    return new Response(null, { status: 302, headers: { location: `https://cdn.fake/${content[1]}${variant === "thumbnail" ? ".png" : ".mp4"}` } });
  }
  const vid = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname);
  if (vid) {
    if (gateway.failVideo) return json({ id: vid[1], status: "failed", error: gateway.failVideo });
    return json({ id: vid[1], status: "completed", progress: 100, usage: { cost: 0.1 } });
  }
  return json({ error: { message: "no route", code: "not_found" } }, 404);
}) as typeof fetch;

const SAFE_TEXT: TextAssessment = {
  sexualLevel: "none",
  apparentMinor: false,
  minorSexualized: false,
  realPerson: false,
  realPersonNames: [],
  realPersonSexualOrIntimate: false,
  nonConsensualSexual: false,
  animalSexual: false,
  extremeViolence: false,
  violentExtremism: false,
  selfHarm: false,
};
const SAFE_IMAGE: ImageAssessment = {
  rating: "safe",
  confidence: 0.9,
  photographic: false,
  apparentMinor: false,
  minorSexualized: false,
  knownPerson: false,
  animalSexual: false,
  extremeViolence: false,
  violentExtremism: false,
  selfHarm: false,
};

const safety = {
  text: SAFE_TEXT as Partial<TextAssessment> | "error",
  image: SAFE_IMAGE as Partial<ImageAssessment> | "error",
  faces: [] as unknown[] | "error",
  calls: [] as string[],
  reset() {
    this.text = SAFE_TEXT;
    this.image = SAFE_IMAGE;
    this.faces = [];
    this.calls = [];
  },
};

const fakeSafetyLlm: LlmProvider = {
  id: "fake-safety",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const user = req.messages.find((m) => m.role === "user")!;
    const images = typeof user.content === "string" ? 0 : user.content.filter((p) => p.type === "image_url").length;
    const kind = req.model === FACE_DETECT_MODEL ? "faces" : images > 0 ? "vision" : "text";
    safety.calls.push(kind);
    let answer: string;
    if (kind === "faces") {
      if (safety.faces === "error") return yield { type: "error", error: { code: "upstream_error", message: "down", retryable: true } };
      answer = JSON.stringify({ faces: safety.faces });
    }
    else if (kind === "vision") {
      if (safety.image === "error") return yield { type: "error", error: { code: "upstream_error", message: "down", retryable: true } };
      answer = JSON.stringify({ images: Array.from({ length: images }, () => ({ ...SAFE_IMAGE, ...(safety.image as object) })) });
    } else {
      if (safety.text === "error") return yield { type: "error", error: { code: "upstream_error", message: "down", retryable: true } };
      answer = JSON.stringify({ ...SAFE_TEXT, ...safety.text });
    }
    yield { type: "text", delta: answer };
    yield { type: "done", id: "s", finishReason: "stop" };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string, opts: { mature?: boolean; plan?: boolean } = {}): Promise<{ user: string; ws: string }> {
  const user = `${tag}${Date.now().toString(36)}${++seq}`;
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  if (opts.plan !== false) {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
      .bind(`sub_${user}`, ws, now + 30 * DAY, now)
      .run();
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
    expect((await stub.purchase(5000, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  }
  if (opts.mature) await env.DB.prepare("UPDATE user_prefs SET mature_content = 1 WHERE user_id = ?").bind(user).run();
  return { user, ws };
}

async function balance(ws: string): Promise<{ available: number; held: number }> {
  const b = await env.CREDITS.get(env.CREDITS.idFromName(ws)).balance();
  return { available: b.plan + b.purchased, held: b.held };
}

async function quote(user: string, body: unknown): Promise<any> {
  const res = await api(user, "/api/runs/quote", { method: "POST", json: body });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** Quick Create / Home video: Auto, text only, the cheapest settings. */
const video = (prompt: string, extra: Record<string, unknown> = {}) => ({ promptSpec: { kind: "video", model: "auto", prompt, seconds: 5, resolution: "480p", ratio: "9:16", ...extra } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runAndWait(user: string, quoteId: string): Promise<{ run: any; job: any; runId: string }> {
  const res = await api(user, "/api/runs", { method: "POST", json: { quoteId } });
  expect(res.status, await res.clone().text()).toBe(201);
  const { runId } = (await res.json()) as { runId: string };
  const run = await waitFor("run end", async () => {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<any>();
    return r && ["succeeded", "partial", "failed", "canceled"].includes(r.status) ? r : null;
  });
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<any>();
  return { run, job, runId };
}

async function events(ws: string): Promise<any[]> {
  return (await env.DB.prepare("SELECT * FROM safety_events WHERE workspace_id = ? ORDER BY created_at").bind(ws).all()).results;
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
  setGatewayFetchForTests(fakeFetch);
  setFramesContainerForTests(fakeContainer);
  setSafetyLlmForTests(() => fakeSafetyLlm);
});

afterAll(() => {
  setGatewayFetchForTests(null);
  setFramesContainerForTests(null);
  setSafetyLlmForTests(null);
});

beforeEach(async () => {
  safety.reset();
  gateway.creates = 0;
  gateway.bodies = [];
  gateway.paths = [];
  gateway.failVideo = null;
  gateway.holdImages = false;
  gateway.noPoster = true;
  frames.calls = [];
  frames.down = false;
  introspector = await introspectWorkflow(env.GENERATE);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.forceEventTimeout({ name: "wait-1-1" });
    await m.forceEventTimeout({ name: "wait-1-2" });
    await m.forceEventTimeout({ name: "wait-1-3" });
  });
});

afterEach(async () => {
  await introspector.dispose();
});

// ---------------------------------------------------------------------------



const PLAIN = "a paper boat drifting down a rainy street";

async function outputs(runId: string): Promise<any[]> {
  return (await env.DB.prepare("SELECT a.* FROM assets a WHERE json_extract(a.meta, '$.runId') = ? AND a.kind = 'video'").bind(runId).all<any>()).results;
}

describe("video outputs without a provider poster", () => {
  it("frame times: 0.5 s in and the midpoint", () => {
    expect(outputFrameTimes(5)).toEqual([0.5, 2.5]);
    expect(outputFrameTimes(10)).toEqual([0.5, 5]);
    expect(outputFrameTimes(0.6)).toEqual([0.3]);
    expect(outputFrameTimes(undefined)).toEqual([0.5, 2.5]);
  });

  it("takes stills from the stored clip for the poster, the vision check and the rating (any video model)", async () => {
    const { user } = await member("vf");
    const q = await quote(user, video(PLAIN, { model: "Seedance 2.0 Mini" }));
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    expect(frames.calls.map((c) => c.times)).toEqual([[0.5], [2.5]]);
    const [asset] = await outputs(runId);
    const meta = JSON.parse(asset.meta);
    expect(meta.thumbKey).toMatch(/\/gen\/job_[^/]+\/0\.frame-500\.png$/);
    expect(meta.posterSource).toBe("frames");
    expect(meta.reviewPending).toBeUndefined();
    expect(await env.MEDIA.head(meta.thumbKey)).not.toBeNull();
    expect(asset).toMatchObject({ rating: "safe", mature: 0 });
    // Both stills went to the vision classifier.
    expect(safety.calls).toContain("vision");
    // The poster variant of the private media route redirects to the still.
    const res = await api(user, `/api/media/private/${asset.id}?variant=poster`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("0.frame-500.png");
  });

  it("the rating follows the stills: a suggestive clip is mature for visibility", async () => {
    const { user } = await member("vfr");
    safety.image = { rating: "suggestive", confidence: 0.8 };
    const q = await quote(user, video(PLAIN, { model: "Seedance 2.0 Mini" }));
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    expect((await outputs(runId))[0]).toMatchObject({ rating: "suggestive", mature: 1 });
  });

  it("a hard limit seen on an extracted still blocks: no asset, objects deleted, hold released", async () => {
    const { user, ws } = await member("vfh", { mature: true });
    const before = await balance(ws);
    safety.image = { rating: "explicit", confidence: 0.9, apparentMinor: true, minorSexualized: true };
    const q = await quote(user, video(PLAIN, { model: "Seedance 2.0 Mini" }));
    const { run, runId, job } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("failed");
    expect(job).toMatchObject({ status: "failed", error_code: "safety_blocked", refunded: 1 });
    expect(await outputs(runId)).toEqual([]);
    const left = await env.MEDIA.list({ prefix: `ws/${ws}/gen/${job.id}/` });
    expect(left.objects).toEqual([]);
    expect(await balance(ws)).toEqual(before);
    const ev = await events(ws);
    expect(ev.some((e) => e.stage === "post" && e.verdict === "block" && e.hard === 1)).toBe(true);
  });

  it("container down, non-mature run: the clip is kept for its owner, unrated and review-pending until the re-queue rates it", async () => {
    const { user } = await member("vfd");
    frames.down = true;
    const q = await quote(user, video(PLAIN, { model: "Seedance 2.0 Mini" }));
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    const [asset] = await outputs(runId);
    const meta = JSON.parse(asset.meta);
    expect(asset).toMatchObject({ rating: null, mature: 0, status: "ready" });
    expect(meta).toMatchObject({ reviewPending: true, processing: "pending" });
    expect(meta.thumbKey).toBeUndefined();
    // Its owner still opens it.
    expect((await api(user, `/api/media/private/${asset.id}`, { redirect: "manual" })).status).toBe(302);
    // The cron re-queue (media.process) makes the poster; the rating then clears the review hold.
    const thumbKey = `ws/${asset.workspace_id}/gen/${meta.jobId}/thumb.jpg`;
    await env.MEDIA.put(thumbKey, uniquePng("later"), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("UPDATE assets SET meta = json_set(meta, '$.thumbKey', ?, '$.processing', 'done') WHERE id = ?").bind(thumbKey, asset.id).run();
    safety.image = { rating: "safe", confidence: 0.9 };
    expect(await rateAsset(env, asset.id)).toMatchObject({ rating: "safe", blocked: false });
    const after = await env.DB.prepare("SELECT rating, mature, meta FROM assets WHERE id = ?").bind(asset.id).first<any>();
    expect(after).toMatchObject({ rating: "safe", mature: 0 });
    expect(JSON.parse(after.meta).reviewPending).toBeUndefined();
  });

  it("container down, mature run: no public visibility (mature) and the rating stays unknown", async () => {
    const { user } = await member("vfm", { mature: true });
    frames.down = true;
    const q = await quote(user, video("an nsfw scene between two consenting adults in a hotel room"));
    expect(q.items.map((i: any) => i.step)).toEqual(["keyframe", "animate"]);
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    const [asset] = await outputs(runId);
    expect(asset).toMatchObject({ rating: null, mature: 1 });
    expect(JSON.parse(asset.meta)).toMatchObject({ reviewPending: true, processing: "pending" });
  });

  it("a provider poster is used as before (no container call)", async () => {
    const { user } = await member("vfp");
    gateway.noPoster = false;
    const q = await quote(user, video(PLAIN, { model: "Seedance 2.0 Mini" }));
    const { runId } = await runAndWait(user, q.quoteId);
    expect(frames.calls).toEqual([]);
    const meta = JSON.parse((await outputs(runId))[0].meta);
    expect(meta.thumbKey).toMatch(/poster\.png$/);
    expect(meta.posterSource).toBeUndefined();
  });
});
