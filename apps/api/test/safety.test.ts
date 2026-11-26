/**
 * D-005 hard limits in the pipeline (workers pool): quote rules, pre-check in
 * `prepare`, post-check in `store`, content ratings, the workspace review
 * flag, and the upload rating hook. The safety LLM is a scripted fake; the
 * generation gateway is a fake fetch. Prompts describe categories only.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { ChatEvent, ChatRequest, LlmProvider } from "@rolling/core";
import { FACE_DETECT_MODEL, type ImageAssessment, type TextAssessment } from "@rolling/core/safety";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { agentSafetyGate, faceResultFromMeta, rateAsset, setSafetyLlmForTests } from "../src/safety/service";
import { processAsset } from "../src/queues/mediaProcess";

const BASE = "https://example.com";
const DAY = 86_400_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

function uniquePng(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG, ...new TextEncoder().encode(`${tag}:${crypto.randomUUID()}`)]);
}

// ---------------------------------------------------------------------------
// Fake generation gateway (images only) and fake safety LLM
// ---------------------------------------------------------------------------

const gateway = { creates: 0, seq: 0, bodies: [] as any[] };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  // Unique bytes per output: verdicts are cached by content hash.
  if (url.hostname === "cdn.fake") return new Response(uniquePng(url.pathname), { headers: { "content-type": "image/png" } });
  if (url.pathname === "/v1/chat/completions") {
    // Auto classifier: no answer → deterministic fallback.
    return new Response(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/images/")) {
    gateway.creates++;
    gateway.bodies.push(await req.clone().json().catch(() => null));
    return json({ id: `gen_${++gateway.seq}`, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) return json({ data: { id: gen[1], kind: "image", status: "done", usage: { cost: 0.01 }, outputs: [{ url: `https://cdn.fake/${gen[1]}.png` }] } });
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

const spec = (prompt: string, extra: Record<string, unknown> = {}) => ({ promptSpec: { kind: "image", model: "Seedream 5.0 Lite", prompt, resolution: "2K", ratio: "1:1", ...extra } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runAndWait(user: string, quoteId: string): Promise<{ run: any; job: any }> {
  const res = await api(user, "/api/runs", { method: "POST", json: { quoteId } });
  expect(res.status, await res.clone().text()).toBe(201);
  const { runId } = (await res.json()) as { runId: string };
  const run = await waitFor("run end", async () => {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<any>();
    return r && ["succeeded", "partial", "failed", "canceled"].includes(r.status) ? r : null;
  });
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<any>();
  return { run, job };
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
  introspector = await introspectWorkflow(env.GENERATE);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.forceEventTimeout({ name: "wait-1-1" });
  });
});

afterEach(async () => {
  await introspector.dispose();
});

// ---------------------------------------------------------------------------

describe("safety: quote (deterministic rules, before credits are held)", () => {
  it("refuses an obviously blocked prompt with SAFETY_BLOCKED and a neutral reason, and logs it", async () => {
    const { user, ws } = await member("sq");
    const before = await balance(ws);
    const q = await quote(user, spec("nude schoolgirl"));
    expect(q.quoteId).toBeNull();
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "SAFETY_BLOCKED", reason: "This can’t be generated under our content rules.", credits: 0 });
    expect(JSON.stringify(q)).not.toContain("MINOR");
    expect(await balance(ws)).toEqual(before);
    const ev = await events(ws);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ stage: "quote", verdict: "block", hard: 1 });
    expect(JSON.parse(ev[0].codes)).toEqual(["MINOR_SEXUAL"]);
    expect(ev[0].excerpt.length).toBeLessThanOrEqual(200);
  });

  it.each(["a child playing football in a park", "portrait of a senior CEO", "kids building a sandcastle, golden hour"])("does not block the benign prompt %s", async (prompt) => {
    const { user } = await member("sb");
    const q = await quote(user, spec(prompt));
    expect(q.items[0].action).toBe("run");
    expect(q.quoteId).toMatch(/^q/);
  });

  it("asks for mature content with copy that fits the caller: Settings for a member with the preference off, a paid plan for a non-member", async () => {
    const { user } = await member("sm");
    const q = await quote(user, spec("an nsfw scene between two adults"));
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "MATURE_REQUIRED", matureAccess: "preference_off", reason: "Turn on mature content in Settings to generate this, or change the prompt." });
    const guest = await member("sg", { plan: false });
    const g = await quote(guest.user, spec("an nsfw scene between two adults"));
    expect(g.items[0]).toMatchObject({ action: "blocked", code: "MATURE_REQUIRED", matureAccess: "no_plan", reason: "Mature content needs a paid plan. Join a plan to generate this, or change the prompt." });
    expect(g.items[0].reason).not.toContain("Settings");
    // A non-member with the preference on is still asked for a plan, never to "turn it on".
    const guestOn = await member("sgo", { plan: false, mature: true });
    expect((await quote(guestOn.user, spec("an nsfw scene between two adults"))).items[0]).toMatchObject({ code: "MATURE_REQUIRED", matureAccess: "no_plan" });
  });

  it.each([
    ["Quick Create, explicit model that takes no mature runs", { model: "Seedream 5.0 Lite" }],
    ["Home, Auto", { model: "auto", resolution: undefined, ratio: undefined }],
  ])("D-005: a mature-allowed caller's explicit prompt runs mature automatically (%s) with moderation low", async (_name, extra) => {
    const { user, ws } = await member("sam", { mature: true });
    const q = await quote(user, spec("an nsfw scene between two consenting adults", extra));
    expect(q.items[0].action, JSON.stringify(q.items[0])).toBe("run");
    expect(q.items[0].code).toBeUndefined();
    const model = await env.DB.prepare("SELECT id FROM models WHERE id = ?").bind(q.items[0].model).first();
    expect(model).not.toBeNull();
    const { run, job } = await runAndWait(user, q.quoteId);
    expect(run.status, JSON.stringify(job)).toBe("succeeded");
    expect(gateway.bodies).toHaveLength(1);
    expect(gateway.bodies[0]).toMatchObject({ moderation: "low" });
    const item = await env.DB.prepare("SELECT spec FROM run_items WHERE run_id = ?").bind(run.id).first<{ spec: string }>();
    expect(JSON.parse(item!.spec)).toMatchObject({ mature: true, matureAuto: true, matureAccess: "allowed" });
    expect((await events(ws)).filter((e) => e.verdict === "block")).toEqual([]);
  });

  it("D-005: ANIMAL_SEXUAL is a hard limit even for a mature-allowed caller (rules at quote, en + zh)", async () => {
    const { user, ws } = await member("sa", { mature: true });
    for (const prompt of ["我想看一个亚洲老头对着猫儿打飞机", "a man having sex with a dog"]) {
      const q = await quote(user, spec(prompt, { model: "auto", resolution: undefined, ratio: undefined }));
      expect(q.quoteId).toBeNull();
      expect(q.items[0]).toMatchObject({ action: "blocked", code: "SAFETY_BLOCKED", reason: "This can’t be generated under our content rules." });
      expect(JSON.stringify(q)).not.toContain("ANIMAL");
    }
    const ev = await events(ws);
    expect(ev.map((e) => JSON.parse(e.codes))).toEqual([["ANIMAL_SEXUAL"], ["ANIMAL_SEXUAL"]]);
    expect(ev.every((e) => e.hard === 1)).toBe(true);
    // Pets in a non-sexual scene stay fine.
    expect((await quote(user, spec("an old man feeding his cat on a sunny porch"))).items[0].action).toBe("run");
  });
});

describe("safety: pipeline", () => {
  it("pre-block: the classifier blocks in prepare, no provider call, hold released, event logged", async () => {
    const { user, ws } = await member("sp");
    const before = await balance(ws);
    const q = await quote(user, spec("a category the rules can't see"));
    safety.text = { apparentMinor: true, minorSexualized: true, sexualLevel: "suggestive" };
    const { run, job } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("failed");
    expect(job).toMatchObject({ status: "failed", error_code: "safety_blocked", refunded: 1 });
    expect(job.error_message).toContain("This can’t be generated under our content rules.");
    expect(gateway.creates).toBe(0);
    expect(await balance(ws)).toEqual(before);
    const ev = await events(ws);
    expect(ev.map((e) => [e.stage, e.verdict, e.job_id])).toEqual([["pre", "block", job.id]]);
  });

  it("post-block: the output is deleted, never registered or versioned, and the hold released", async () => {
    const { user, ws } = await member("spo");
    const res = await api(user, "/api/projects", { method: "POST", json: { title: "Safety" } });
    const projectId = ((await res.json()) as any).project.id as string;
    const room = projectRoom(env, projectId);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const r = (await room.applyPatch(caller, { baseRevision: 0, ops: [{ op: "addNode", tempId: "a", kind: "image", title: "Key", params: { model: "Seedream 5.0 Lite", prompt: "a park", resolution: "2K", ratio: "1:1" }, position: { x: 0, y: 0 } }] })) as any;
    const nodeId = r.idMap.a as string;
    const before = await balance(ws);
    const q = await quote(user, { projectId, scope: "node", nodeIds: [nodeId] });
    expect(q.items[0].action).toBe("run");
    safety.image = { rating: "suggestive", apparentMinor: true };
    const { job } = await runAndWait(user, q.quoteId);
    expect(job).toMatchObject({ status: "failed", error_code: "safety_blocked", refunded: 1, asset_id: null });
    expect(gateway.creates).toBe(1);
    expect((await env.MEDIA.list({ prefix: `ws/${ws}/gen/${job.id}` })).objects).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE json_extract(meta, '$.jobId') = ?").bind(job.id).first<any>()).n).toBe(0);
    const graph = (await room.getGraph(caller)) as any;
    expect(graph.assets[nodeId]).toBeUndefined();
    expect(await balance(ws)).toEqual(before);
    expect((await events(ws)).map((e) => e.stage)).toEqual(["post"]);
  });

  it("rates every output; a suggestive output of a non-mature run is mature for visibility and left out of share links", async () => {
    const { user, ws } = await member("sr");
    const res = await api(user, "/api/projects", { method: "POST", json: { title: "Rated" } });
    const projectId = ((await res.json()) as any).project.id as string;
    const room = projectRoom(env, projectId);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const r = (await room.applyPatch(caller, { baseRevision: 0, ops: [{ op: "addNode", tempId: "a", kind: "image", title: "Beach", params: { model: "Seedream 5.0 Lite", prompt: "a swimsuit photo on a beach", resolution: "2K", ratio: "1:1" }, position: { x: 0, y: 0 } }] })) as any;
    const nodeId = r.idMap.a as string;
    const q = await quote(user, { projectId, scope: "node", nodeIds: [nodeId] });
    safety.image = { rating: "suggestive", confidence: 0.75 };
    const { job } = await runAndWait(user, q.quoteId);
    expect(job.status).toBe("succeeded");
    const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(job.asset_id).first<any>();
    expect(asset).toMatchObject({ rating: "suggestive", rating_confidence: 0.75, mature: 1 });
    expect(asset.rating_model).toMatch(/^deepseek\//);
    const graph = (await room.getGraph(caller)) as any;
    expect(graph.assets[nodeId]).toBe(job.asset_id);

    const share = (await (await api(user, `/api/projects/${projectId}/share`, { method: "POST", json: {} })).json()) as any;
    const doc = (await (await api(null, `/api/share/${share.shareId}`)).json()) as any;
    expect(doc.nodes.map((n: any) => n.title)).not.toContain("Beach");
    expect(JSON.stringify(doc)).not.toContain(job.asset_id);
  });

  it("a safe output of a non-mature run is rated safe and stays shareable", async () => {
    const { user } = await member("ss");
    const q = await quote(user, spec("a lighthouse at dusk"));
    const { job } = await runAndWait(user, q.quoteId);
    expect(job.status).toBe("succeeded");
    expect(await env.DB.prepare("SELECT rating, mature FROM assets WHERE id = ?").bind(job.asset_id).first()).toEqual({ rating: "safe", mature: 0 });
  });

  it("fails closed on a mature run when the classifier is down; a non-mature run continues and logs the outage", async () => {
    const m = await member("sfm", { mature: true });
    const mq = await quote(m.user, spec("two adults on a sofa", { model: "lumina/z-image-spicy", mature: true, resolution: undefined, ratio: undefined }));
    expect(mq.items[0].action, JSON.stringify(mq.items[0])).toBe("run");
    safety.text = "error";
    const { job } = await runAndWait(m.user, mq.quoteId);
    expect(job).toMatchObject({ status: "failed", error_code: "safety_unavailable", refunded: 1 });
    expect(gateway.creates).toBe(0);

    const p = await member("sfp");
    // A prompt not seen before (assessments are cached by content hash).
    const pq = await quote(p.user, spec(`a lighthouse at dusk, take ${crypto.randomUUID()}`));
    const done = await runAndWait(p.user, pq.quoteId);
    expect(done.job.status).toBe("succeeded");
    const ev = await events(p.ws);
    expect(ev[0]).toMatchObject({ stage: "pre", verdict: "allow" });
    expect(JSON.parse(ev[0].codes)).toEqual(["SAFETY_UNAVAILABLE"]);
  });

  it("flags a workspace after 3 hard-limit blocks in 24 h and then refuses its mature runs", async () => {
    const { user, ws } = await member("sf", { mature: true });
    const matureSpec = spec("two adults on a sofa", { model: "lumina/z-image-spicy", mature: true, resolution: undefined, ratio: undefined });
    expect((await quote(user, matureSpec)).items[0].action).toBe("run");
    for (let i = 0; i < 3; i++) await quote(user, spec(`nude schoolgirl ${i}`));
    expect(await env.DB.prepare("SELECT safety_flag FROM workspaces WHERE id = ?").bind(ws).first()).toEqual({ safety_flag: 1 });
    const q = await quote(user, matureSpec);
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "SAFETY_REVIEW" });
    // Non-mature runs keep working.
    expect((await quote(user, spec("a lighthouse at dusk"))).items[0].action).toBe("run");
  });

  it("refuses a mature job in prepare once the workspace is flagged (quote taken before the flag)", async () => {
    const { user, ws } = await member("sfp2", { mature: true });
    const q = await quote(user, spec("two adults on a sofa", { model: "lumina/z-image-spicy", mature: true, resolution: undefined, ratio: undefined }));
    await env.DB.prepare("UPDATE workspaces SET safety_flag = 1 WHERE id = ?").bind(ws).run();
    const { job } = await runAndWait(user, q.quoteId);
    expect(job).toMatchObject({ status: "failed", error_code: "safety_review", refunded: 1 });
    expect(gateway.creates).toBe(0);
  });
});

describe("safety: upload rating hook (media.process)", () => {
  async function uploaded(ws: string, user: string): Promise<string> {
    const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const key = `ws/${ws}/uploads/${id}.png`;
    await env.MEDIA.put(key, uniquePng(id), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'mine', 'photo', ?, '{}', ?, ?, 'ready', 0)")
      .bind(id, ws, key, user, Date.now())
      .run();
    return id;
  }

  it("stores the rating and derives the mature flag", async () => {
    const { user, ws } = await member("su");
    const id = await uploaded(ws, user);
    safety.image = { rating: "explicit", confidence: 0.92 };
    expect(await rateAsset(env, id)).toMatchObject({ rating: "explicit", blocked: false });
    expect(await env.DB.prepare("SELECT rating, mature, status FROM assets WHERE id = ?").bind(id).first()).toEqual({ rating: "explicit", mature: 1, status: "ready" });
  });

  it("marks an upload that shows a hard-limit violation as failed and logs it", async () => {
    const { user, ws } = await member("sub");
    const id = await uploaded(ws, user);
    safety.image = { rating: "suggestive", minorSexualized: true, apparentMinor: true };
    expect((await rateAsset(env, id)).blocked).toBe(true);
    expect((await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(id).first<any>()).status).toBe("failed");
    expect((await events(ws)).map((e) => [e.stage, e.verdict])).toEqual([["upload", "block"]]);
  });

  it("rates an upload from the media-process consumer once it is ready (M3 hook)", async () => {
    const { user, ws } = await member("sq");
    const id = await uploaded(ws, user);
    const row = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(id).first<{ r2_key: string }>();
    await env.DB.prepare("UPDATE assets SET status = 'processing' WHERE id = ?").bind(id).run();
    safety.image = { rating: "suggestive", confidence: 0.8 };
    expect(await processAsset(env, { assetId: id, r2Key: row!.r2_key, kind: "image" })).toBe("done");
    expect(await env.DB.prepare("SELECT rating, mature, status FROM assets WHERE id = ?").bind(id).first()).toEqual({ rating: "suggestive", mature: 1, status: "ready" });
  });

  it("leaves the rating empty when the classifier is down", async () => {
    const { user, ws } = await member("sud");
    const id = await uploaded(ws, user);
    safety.image = "error";
    expect(await rateAsset(env, id)).toMatchObject({ rating: null, blocked: false });
  });
});

describe("safety: face detection on upload (UP-4)", () => {
  async function asset(ws: string, user: string, kind: "image" | "video", source = "mine"): Promise<string> {
    const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const key = `ws/${ws}/uploads/${id}.${kind === "image" ? "png" : "mp4"}`;
    let meta = "{}";
    if (kind === "image") await env.MEDIA.put(key, uniquePng(id), { httpMetadata: { contentType: "image/png" } });
    else {
      await env.MEDIA.put(key, new Uint8Array([0, 0, 0, 24]), { httpMetadata: { contentType: "video/mp4" } });
      const thumbKey = `ws/${ws}/uploads/${id}/thumb.png`;
      await env.MEDIA.put(thumbKey, uniquePng(`${id}p`), { httpMetadata: { contentType: "image/png" } });
      meta = JSON.stringify({ thumbKey, durationSec: 3 });
    }
    await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, ?, ?, 'clip', ?, ?, ?, ?, 'ready', 0)")
      .bind(id, ws, kind, source, key, meta, user, Date.now())
      .run();
    return id;
  }
  const metaOf = async (id: string) => JSON.parse((await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(id).first<{ meta: string }>())!.meta);

  it("stores face count, boxes and the apparent-minor flag in asset meta", async () => {
    const { user, ws } = await member("fd");
    const id = await asset(ws, user, "image");
    safety.faces = [{ confidence: 99.2, box: { x: 12, y: 8, width: 40, height: 52 }, age: 34 }];
    const out = await rateAsset(env, id);
    expect(out).toMatchObject({ blocked: false, faces: { status: "done", count: 1 } });
    expect(safety.calls).toContain("faces");
    expect((await metaOf(id)).faces).toMatchObject({
      status: "done",
      count: 1,
      maxConfidence: 99.2,
      boxes: [{ x: 12, y: 8, width: 40, height: 52 }],
      apparentMinor: false,
      model: "lumina/face-detect",
      source: "image",
    });
  });

  it("runs on a video's poster frame", async () => {
    const { user, ws } = await member("fdv");
    const id = await asset(ws, user, "video");
    safety.faces = [{ confidence: 97 }, { confidence: 91 }];
    await rateAsset(env, id);
    const meta = await metaOf(id);
    expect(meta.faces).toMatchObject({ status: "done", count: 2, maxConfidence: 97, apparentMinor: null, source: "poster" });
    expect(meta.durationSec).toBe(3);
  });

  it("a face estimated under 18 on a suggestive upload blocks it (minor rule)", async () => {
    const { user, ws } = await member("fdm");
    const id = await asset(ws, user, "image");
    safety.image = { rating: "suggestive", photographic: true };
    safety.faces = [{ confidence: 98, age_range: { low: 13, high: 17 } }];
    expect((await rateAsset(env, id)).blocked).toBe(true);
    expect((await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(id).first<any>()).status).toBe("failed");
    expect((await metaOf(id)).faces).toMatchObject({ apparentMinor: true });
  });

  it("records an outage as unavailable (never as face-free) and reads back only finished detections", async () => {
    const { user, ws } = await member("fde");
    const id = await asset(ws, user, "image");
    safety.faces = "error";
    expect((await rateAsset(env, id)).faces).toMatchObject({ status: "unavailable" });
    const meta = await metaOf(id);
    expect(meta.faces.status).toBe("unavailable");
    expect(faceResultFromMeta(meta)).toBeNull();
    expect(faceResultFromMeta({ faces: { status: "done", count: 1, maxConfidence: 95, apparentMinor: null } })).toEqual({ faces: 1, maxConfidence: 95, apparentMinor: null });
  });

  it("skips generated media", async () => {
    const { user, ws } = await member("fdg");
    const id = await asset(ws, user, "image", "generated");
    await rateAsset(env, id);
    expect(safety.calls).not.toContain("faces");
    expect((await metaOf(id)).faces).toBeUndefined();
  });
});

describe("safety: agent gate (M6 hook)", () => {
  it("blocks a hard-limit brief and logs it with stage agent; benign briefs pass", async () => {
    const { user, ws } = await member("sa");
    const gate = await agentSafetyGate(env, { userId: user, workspaceId: ws });
    expect((await gate.checkBrief({ text: "a nude schoolgirl", mature: false })).verdict).toBe("block");
    expect((await gate.checkBrief({ text: "portrait of a senior CEO", mature: false })).verdict).toBe("allow");
    expect((await events(ws)).map((e) => [e.stage, e.verdict])).toEqual([["agent", "block"]]);
  });
});

describe("safety: mature-allowed callers (D-005: only hard limits block)", () => {
  it("prepare re-plans a non-mature item as mature when the classifier finds it explicit (moderation low, within the hold)", async () => {
    const { user, ws } = await member("srp", { mature: true });
    const q = await quote(user, spec("two adults, an adult category the rules can't see", { model: "auto", resolution: undefined, ratio: undefined }));
    expect(q.items[0].action).toBe("run");
    safety.text = { sexualLevel: "explicit" };
    safety.image = { rating: "explicit", confidence: 0.9 };
    const { run, job } = await runAndWait(user, q.quoteId);
    expect(run.status, JSON.stringify(job)).toBe("succeeded");
    expect(gateway.bodies[0]).toMatchObject({ moderation: "low" });
    const item = await env.DB.prepare("SELECT spec FROM run_items WHERE run_id = ?").bind(run.id).first<{ spec: string }>();
    expect(JSON.parse(item!.spec)).toMatchObject({ mature: true, matureAuto: true });
    expect(await env.DB.prepare("SELECT mature FROM models WHERE id = ?").bind(job.model).first()).toEqual({ mature: 1 });
    expect(await env.DB.prepare("SELECT rating, mature FROM assets WHERE id = ?").bind(job.asset_id).first()).toEqual({ rating: "explicit", mature: 1 });
    expect((await events(ws)).filter((e) => e.verdict === "block")).toEqual([]);
  });

  it("explicit output of a non-mature run only rates (mature for visibility), it never blocks", async () => {
    const { user } = await member("sro", { mature: true });
    const q = await quote(user, spec("a lighthouse at dusk"));
    safety.image = { rating: "explicit", confidence: 0.8 };
    const { job } = await runAndWait(user, q.quoteId);
    expect(job.status).toBe("succeeded");
    expect(await env.DB.prepare("SELECT rating, mature FROM assets WHERE id = ?").bind(job.asset_id).first()).toEqual({ rating: "explicit", mature: 1 });
  });

  it("the classifier's animalSexual flag blocks in prepare (hard limit), hold released", async () => {
    const { user, ws } = await member("sca", { mature: true });
    const before = await balance(ws);
    const q = await quote(user, spec("an adult category with an animal the rules can't see", { model: "auto", resolution: undefined, ratio: undefined }));
    safety.text = { sexualLevel: "explicit", animalSexual: true };
    const { job } = await runAndWait(user, q.quoteId);
    expect(job).toMatchObject({ status: "failed", error_code: "safety_blocked", refunded: 1 });
    expect(gateway.creates).toBe(0);
    expect(await balance(ws)).toEqual(before);
    expect((await events(ws)).map((e) => JSON.parse(e.codes))).toEqual([["ANIMAL_SEXUAL"]]);
  });

  it("a member with the preference off still gets MATURE_REQUIRED with Settings copy when prepare finds explicit content", async () => {
    const { user } = await member("spf");
    const q = await quote(user, spec("another adult category the rules can't see"));
    safety.text = { sexualLevel: "explicit" };
    const { job } = await runAndWait(user, q.quoteId);
    expect(job, JSON.stringify(job)).toMatchObject({ status: "failed", error_code: "mature_required", refunded: 1 });
    expect(job.error_message).toContain("Turn on mature content in Settings");
  });
});
