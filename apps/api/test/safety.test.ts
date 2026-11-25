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
import { rateAsset, setSafetyLlmForTests } from "../src/safety/service";

const BASE = "https://example.com";
const DAY = 86_400_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

function uniquePng(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG, ...new TextEncoder().encode(`${tag}:${crypto.randomUUID()}`)]);
}

// ---------------------------------------------------------------------------
// Fake generation gateway (images only) and fake safety LLM
// ---------------------------------------------------------------------------

const gateway = { creates: 0, seq: 0 };

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
  extremeViolence: false,
  violentExtremism: false,
  selfHarm: false,
};

const safety = {
  text: SAFE_TEXT as Partial<TextAssessment> | "error",
  image: SAFE_IMAGE as Partial<ImageAssessment> | "error",
  calls: [] as string[],
  reset() {
    this.text = SAFE_TEXT;
    this.image = SAFE_IMAGE;
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
    if (kind === "faces") answer = JSON.stringify({ faces: [] });
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

  it("asks for mature content instead of routing an explicit non-mature prompt (MATURE_REQUIRED, NO_PLAN for non-members)", async () => {
    const { user } = await member("sm");
    const q = await quote(user, spec("an nsfw scene between two adults"));
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "MATURE_REQUIRED", reason: "Turn on mature content in Settings to generate this, or change the prompt." });
    const guest = await member("sg", { plan: false });
    const g = await quote(guest.user, spec("an nsfw scene between two adults"));
    expect(g.items[0]).toMatchObject({ action: "blocked", code: "NO_PLAN" });
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
    expect(await rateAsset(env, id)).toEqual({ rating: "explicit", blocked: false });
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

  it("leaves the rating empty when the classifier is down", async () => {
    const { user, ws } = await member("sud");
    const id = await uploaded(ws, user);
    safety.image = "error";
    expect(await rateAsset(env, id)).toEqual({ rating: null, blocked: false });
  });
});
