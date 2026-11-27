/**
 * D-005 mature text-to-video chain (workers pool, fake gateway + fake safety
 * LLM): no text-to-video model takes mature runs, so a mature-allowed caller's
 * explicit text-only video runs as keyframe (mature text-to-image) → spicy
 * image-to-video, held once, settled per step.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { ChatEvent, ChatRequest, LlmProvider } from "@rolling/core";
import { FACE_DETECT_MODEL, type ImageAssessment, type TextAssessment } from "@rolling/core/safety";
import { personalWorkspaceId } from "../src/auth/workspace";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { setSafetyLlmForTests } from "../src/safety/service";

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
  setSafetyLlmForTests(() => fakeSafetyLlm);
});

afterAll(() => {
  setGatewayFetchForTests(null);
  setSafetyLlmForTests(null);
});

beforeEach(async () => {
  safety.reset();
  gateway.creates = 0;
  gateway.bodies = [];
  gateway.paths = [];
  gateway.failVideo = null;
  gateway.holdImages = false;
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


const EXPLICIT = "an nsfw scene between two consenting adults in a hotel room";

async function items(runId: string): Promise<any[]> {
  return (await env.DB.prepare("SELECT i.ref, i.status, i.credits, i.spec, j.status AS job_status, j.cost_actual, j.refunded, j.asset_id FROM run_items i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.run_id = ? ORDER BY i.ord").bind(runId).all<any>()).results;
}

async function runView(user: string, runId: string): Promise<any> {
  const res = await api(user, `/api/runs/${runId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: any }).run;
}

describe("mature text-to-video chain (D-005)", () => {
  it("quotes keyframe + animation as one price, holds once, runs keyframe → spicy i2v with moderation low on both, settles each step", async () => {
    const { user, ws } = await member("mc", { mature: true });
    const before = await balance(ws);
    const q = await quote(user, video(EXPLICIT));
    expect(q.quoteId).toMatch(/^q/);
    expect(q.items.map((i: any) => [i.ref, i.kind, i.action, i.step, i.model])).toEqual([
      ["keyframe", "image", "run", "keyframe", "lumina/z-image-spicy"],
      ["spec", "video", "run", "animate", "lumina/wan2.2-i2v-spicy"],
    ]);
    expect(q.items[1].dependsOn).toEqual(["keyframe"]);
    expect(q.total).toBe(q.items[0].credits + q.items[1].credits);
    expect(q.items.every((i: any) => i.credits > 0)).toBe(true);

    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    // Keyframe first (mature text-to-image at the video ratio), then the video from it.
    expect(gateway.paths).toEqual(["/v1/images/generations", "/v1/videos"]);
    expect(gateway.bodies[0]).toMatchObject({ model: "lumina/z-image-spicy", moderation: "low", size: "768x1344" });
    expect(gateway.bodies[0].prompt).toContain(EXPLICIT);
    expect(gateway.bodies[1]).toMatchObject({ model: "lumina/wan2.2-i2v-spicy", moderation: "low", seconds: 5, resolution: "480p", prompt: EXPLICIT });

    // Each step settled on its own (the single hold for both is checked in the cancel test).
    const rows = await items(runId);
    // The first frame is the keyframe's stored output.
    const kfJob = await env.DB.prepare("SELECT id FROM jobs WHERE run_id = ? AND item_ref = 'keyframe'").bind(runId).first<{ id: string }>();
    expect(gateway.bodies[1].input_reference.image_url).toContain(`/gen/${kfJob!.id}/`);
    expect(rows.map((r) => [r.ref, r.status, r.job_status])).toEqual([
      ["keyframe", "succeeded", "succeeded"],
      ["spec", "succeeded", "succeeded"],
    ]);
    const spent = rows.reduce((s, r) => s + r.cost_actual, 0);
    expect(run.credits_spent).toBe(spent);
    const after = await balance(ws);
    expect(after.held).toBe(0);
    expect(before.available - after.available).toBe(spent);
    // The keyframe was checked as a picture (its own output, then as the video's first frame).
    expect(safety.calls.filter((c) => c === "vision").length).toBeGreaterThanOrEqual(2);
    expect((await events(ws)).filter((e) => e.verdict === "block")).toEqual([]);

    // One generation with steps; the summary is the video.
    const view = await runView(user, runId);
    expect(view.items.map((i: any) => i.step)).toEqual(["keyframe", "animate"]);
    expect(view.params).toContain("480p");
    expect(view.params).not.toContain("1K");
  });

  it("holds both steps at start: the animation's hold exists while the keyframe runs, and a cancel releases both", async () => {
    const { user, ws } = await member("mcc", { mature: true });
    gateway.holdImages = true;
    const q = await quote(user, video(EXPLICIT));
    const res = await api(user, "/api/runs", { method: "POST", json: { quoteId: q.quoteId } });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    expect((await balance(ws)).held).toBe(q.total);
    const anim = await env.DB.prepare("SELECT status, job_id FROM run_items WHERE run_id = ? AND ref = 'spec'").bind(runId).first<any>();
    expect(anim.status).toBe("pending");
    expect(anim.job_id).toMatch(/^job_/);
    const c = await api(user, `/api/runs/${runId}/cancel`, { method: "POST", json: {} });
    expect(c.status).toBe(200);
    expect(((await c.json()) as any).refunded).toBe(q.total);
    expect((await balance(ws)).held).toBe(0);
    const r = await env.DB.prepare("SELECT credits_refunded FROM runs WHERE id = ?").bind(runId).first<any>();
    expect(r.credits_refunded).toBe(q.total);
    expect(gateway.paths).not.toContain("/v1/videos");
  });

  it("a failure in the animation refunds the animation only; the keyframe stays a result the user can see", async () => {
    const { user, ws } = await member("mcf", { mature: true });
    const before = await balance(ws);
    gateway.failVideo = { code: "content_rejected", message: "The provider rejected the content." };
    const q = await quote(user, video(EXPLICIT));
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("partial");
    const [kf, anim] = await items(runId);
    expect(kf).toMatchObject({ ref: "keyframe", status: "succeeded", job_status: "succeeded", refunded: 0 });
    expect(kf.asset_id).toMatch(/^ast/);
    expect(anim).toMatchObject({ ref: "spec", status: "failed", job_status: "failed", refunded: 1 });
    expect(run.credits_refunded).toBe(q.items[1].credits);
    const after = await balance(ws);
    expect(after.held).toBe(0);
    expect(before.available - after.available).toBe(kf.cost_actual);
    const asset = await env.DB.prepare("SELECT kind, source, mature FROM assets WHERE id = ?").bind(kf.asset_id).first<any>();
    expect(asset).toMatchObject({ kind: "image", source: "generated" });
    // A retry quotes the animation alone, from the keyframe it already made.
    const retry = await api(user, `/api/runs/${runId}/retry`, { method: "POST", json: {} });
    expect(retry.status).toBe(200);
    const rq = (await retry.json()) as any;
    expect(rq.items.map((i: any) => [i.ref, i.action])).toEqual([["spec", "run"]]);
  });

  it("hard limits still block: rules at quote, and the vision check on the keyframe output (the animation is released, never sent)", async () => {
    const { user, ws } = await member("mch", { mature: true });
    const blocked = await quote(user, video("explicit sex with a 15 year old girl"));
    expect(blocked.quoteId).toBeNull();
    expect(blocked.items.every((i: any) => i.action === "blocked")).toBe(true);
    expect(blocked.items.some((i: any) => i.code === "SAFETY_BLOCKED")).toBe(true);
    expect(gateway.creates).toBe(0);

    const before = await balance(ws);
    const q = await quote(user, video(EXPLICIT));
    safety.image = { rating: "explicit", confidence: 0.9, apparentMinor: true, minorSexualized: true };
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("failed");
    const [kf, anim] = await items(runId);
    expect(kf).toMatchObject({ status: "failed", refunded: 1 });
    expect(anim).toMatchObject({ status: "skipped", refunded: 1 });
    expect(gateway.paths).toEqual(["/v1/images/generations"]);
    expect(await balance(ws)).toEqual(before);
    expect(run.credits_refunded).toBe(q.total);
    const ev = await events(ws);
    expect(ev.some((e) => e.stage === "post" && e.verdict === "block" && e.hard === 1)).toBe(true);
  });

  it("an explicit prompt only the classifier sees is chained at quote (never fails after the hold); a plain prompt keeps one ordinary item", async () => {
    const { user } = await member("mcq", { mature: true });
    safety.text = { sexualLevel: "explicit" };
    const q = await quote(user, video("two adults, an adult category the rules can't see"));
    expect(q.items.map((i: any) => i.step)).toEqual(["keyframe", "animate"]);
    const { run } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    expect(gateway.bodies.map((b) => b.moderation)).toEqual(["low", "low"]);

    safety.reset();
    gateway.paths = [];
    const plain = await quote(user, video("a cat on a sunny porch"));
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0].step).toBeUndefined();
    expect(plain.items[0].model).not.toMatch(/spicy/);
  });

  it("callers without mature access are unchanged (MATURE_REQUIRED, one item)", async () => {
    const { user } = await member("mcn");
    const q = await quote(user, video(EXPLICIT));
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "MATURE_REQUIRED", matureAccess: "preference_off" });
  });
});

describe("mature public-library references (D-005)", () => {
  /** Picture-to-video from a library item (no ratio: the picture sets it). */
  const i2v = (asset: string) => ({ promptSpec: { kind: "video", model: "auto", prompt: "two dancers holding hands", seconds: 5, resolution: "480p", inputs: { firstFrameAssetId: asset } } });
  /** A mature public-library picture (asset + item), its object in the private bucket only. */
  async function matureLibraryPicture(tag: string): Promise<string> {
    const id = `ast_mpl_${tag}_${++seq}`;
    const key = `public/pose/pw_pose_${id}/front.png`;
    await env.MEDIA.put(key, uniquePng(id), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare(
      "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, license, created_at, status, mature) VALUES (?, NULL, 'image', 'public', 'Couple pose', ?, '{}', 'first-party', ?, 'ready', 1)",
    )
      .bind(id, key, Date.now())
      .run();
    return id;
  }

  it("a mature-allowed caller's run with a mature library item is a mature run (moderation low) and gets the vision check", async () => {
    const { user, ws } = await member("mpl", { mature: true });
    const asset = await matureLibraryPicture("ok");
    const q = await quote(user, i2v(asset));
    expect(q.items, JSON.stringify(q.items)).toHaveLength(1);
    expect(q.items[0], JSON.stringify(q.items)).toMatchObject({ action: "run" });
    expect(q.items[0].model).toMatch(/spicy/);
    const { run, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    expect(gateway.bodies[0]).toMatchObject({ moderation: "low" });
    // The reference went to the vision check (hard limits) before the provider call.
    expect(safety.calls).toContain("vision");
    const [item] = await items(runId);
    expect(JSON.parse(item.spec)).toMatchObject({ mature: true });
    expect((await events(ws)).every((e) => e.verdict !== "block")).toBe(true);
  });

  it("hard limits on the reference block the run before the provider and refund it", async () => {
    const { user, ws } = await member("mplh", { mature: true });
    const asset = await matureLibraryPicture("hard");
    const before = await balance(ws);
    const q = await quote(user, i2v(asset));
    safety.image = { rating: "explicit", confidence: 0.9, apparentMinor: true, minorSexualized: true };
    const { run } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("failed");
    expect(gateway.creates).toBe(0);
    expect(await balance(ws)).toEqual(before);
  });

  it("callers without mature access cannot use a mature library item (not available, nothing held)", async () => {
    const off = await member("mplo");
    const asset = await matureLibraryPicture("off");
    const q = await quote(off.user, i2v(asset));
    expect(q.quoteId).toBeNull();
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "missing_input" });
    expect(gateway.creates).toBe(0);
  });
});
