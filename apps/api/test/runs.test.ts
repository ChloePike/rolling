/**
 * Generation pipeline (M4) end to end in the workers pool: quote → run → holds →
 * GenerateWorkflow (fake Hyperouter over fetch) → store → commit / refund.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { hyperouter } from "@rolling/core";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";

const BASE = "https://example.com";
const DAY = 86_400_000;
const WEBHOOK_SECRET = `whsec_${btoa("rolling-test-webhook-secret-32bytes!")}`;

// ---------------------------------------------------------------------------
// Fake Hyperouter
// ---------------------------------------------------------------------------

interface FakeJob {
  id: string;
  kind: "image" | "video";
  model: string;
  key: string;
  body: Record<string, unknown>;
  polls: number;
  /** Polls answered `running` before the job finishes. */
  runningPolls: number;
  fail: { code: string; message: string } | null;
  /** Finishes only when the test says so (webhook test). */
  hold: boolean;
  done: boolean;
  costUsd: number;
}

interface CreateRule {
  /** Matches the gateway model id. */
  model?: string;
  fail?: { code: string; message: string };
  /** Answer the create with this HTTP status once (then succeed). */
  httpError?: { status: number; code: string; shouldRetry?: boolean };
  hold?: boolean;
  runningPolls?: number;
  costUsd?: number;
}

const fake = {
  jobs: [] as FakeJob[],
  byKey: new Map<string, FakeJob>(),
  calls: [] as { method: string; url: string; key: string | null; at: number }[],
  rules: [] as CreateRule[],
  chatAnswer: null as string | null,
  chatCalls: 0,
  reset() {
    this.jobs = [];
    this.byKey.clear();
    this.calls = [];
    this.rules = [];
    this.chatAnswer = null;
    this.chatCalls = 0;
  },
  job(id: string) {
    return this.jobs.find((j) => j.id === id)!;
  },
};

let fakeSeq = 0;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function finished(j: FakeJob): boolean {
  if (j.hold && !j.done) return false;
  j.polls++;
  return j.polls > j.runningPolls;
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const key = req.headers.get("idempotency-key");
  fake.calls.push({ method: req.method, url: url.pathname + url.search, key, at: Date.now() });

  if (url.hostname === "cdn.fake") {
    return url.pathname.endsWith(".mp4") ? new Response(MP4, { headers: { "content-type": "video/mp4" } }) : new Response(PNG, { headers: { "content-type": "image/png" } });
  }
  if (url.pathname === "/v1/chat/completions") {
    fake.chatCalls++;
    const text = fake.chatAnswer ?? "{}";
    const chunk = { id: "c1", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits" || url.pathname === "/v1/videos")) {
    const body = (await req.json()) as Record<string, unknown>;
    const existing = key ? fake.byKey.get(key) : undefined;
    if (existing) return json({ id: existing.id, status: "queued" }, 202);
    const rule = fake.rules.find((r) => !r.model || r.model === body.model);
    if (rule?.httpError) {
      const e = rule.httpError;
      delete rule.httpError;
      return json({ error: { message: "busy", type: "server_error", code: e.code } }, e.status, e.shouldRetry === undefined ? {} : { "x-should-retry": String(e.shouldRetry) });
    }
    const kind = url.pathname === "/v1/videos" ? "video" : "image";
    const job: FakeJob = {
      id: `${kind === "video" ? "vid" : "gen"}_${++fakeSeq}`,
      kind,
      model: String(body.model),
      key: key ?? "",
      body,
      polls: 0,
      runningPolls: rule?.runningPolls ?? 0,
      fail: rule?.fail ?? null,
      hold: rule?.hold ?? false,
      done: false,
      costUsd: rule?.costUsd ?? (kind === "video" ? 0.1 : 0.01),
    };
    fake.jobs.push(job);
    if (key) fake.byKey.set(key, job);
    return kind === "video" ? json({ id: job.id, object: "video", status: "queued" }) : json({ id: job.id, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) {
    const j = fake.job(gen[1]!);
    if (!finished(j)) return json({ data: { id: j.id, kind: "image", status: "running" } });
    if (j.fail) return json({ data: { id: j.id, kind: "image", status: "failed", error: j.fail } });
    return json({ data: { id: j.id, kind: "image", status: "done", usage: { cost: j.costUsd }, outputs: [{ url: `https://cdn.fake/${j.id}.png` }] } });
  }
  const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname);
  if (content) {
    const variant = url.searchParams.get("variant");
    return new Response(null, { status: 302, headers: { location: `https://cdn.fake/${content[1]}${variant === "thumbnail" ? ".png" : ".mp4"}` } });
  }
  const vid = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname);
  if (vid) {
    const j = fake.job(vid[1]!);
    if (!finished(j)) return json({ id: j.id, status: "in_progress", progress: 40 });
    if (j.fail) return json({ id: j.id, status: "failed", error: j.fail });
    return json({ id: j.id, status: "completed", progress: 100, usage: { cost: j.costUsd } });
  }
  return json({ error: { message: `fake: no route ${req.method} ${url.pathname}`, code: "not_found" } }, 404);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function credits(ws: string) {
  return env.CREDITS.get(env.CREDITS.idFromName(ws));
}

async function available(ws: string): Promise<number> {
  const b = await credits(ws).balance();
  return b.plan + b.purchased;
}

/** A member with `plan` and its monthly credits (plus a top-up). */
async function member(tag: string, plan: "starter" | "plus" | "pro" = "plus", topUp = 5000): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, plan, now + 30 * DAY, now)
    .run();
  const stub = credits(ws);
  const g = await stub.grant({ planId: plan, interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`);
  expect(g.ok).toBe(true);
  if (topUp > 0) expect((await stub.purchase(topUp, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  return { user, ws };
}

interface NodeSpec {
  kind: "text" | "script" | "image" | "video" | "asset";
  title: string;
  params: Record<string, unknown>;
}

/** Creates a project with nodes and edges; returns node ids by title. */
async function project(user: string, ws: string, nodes: NodeSpec[], edges: [string, string, string][]): Promise<{ id: string; ids: Record<string, string> }> {
  const res = await api(user, "/api/projects", { method: "POST", json: { title: "Runs test" } });
  expect(res.status, await res.clone().text()).toBe(201);
  const id = ((await res.json()) as { project: { id: string } }).project.id;
  const room = projectRoom(env, id);
  const caller = { userId: user, workspaceId: ws, canEdit: true };
  const ops: unknown[] = nodes.map((n, i) => ({ op: "addNode", tempId: `t${i}`, kind: n.kind, title: n.title, params: n.params, position: { x: i * 300, y: 0 } }));
  const r = (await room.applyPatch(caller, { baseRevision: 0, ops })) as any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const ids: Record<string, string> = {};
  nodes.forEach((n, i) => (ids[n.title] = r.idMap[`t${i}`]));
  if (edges.length) {
    const c = (await room.applyPatch(caller, {
      baseRevision: r.revision,
      ops: edges.map(([from, to, port]) => ({ op: "connect", from: { node: ids[from], port: "out" }, to: { node: ids[to], port } })),
    })) as any;
    expect(c.ok, JSON.stringify(c)).toBe(true);
  }
  return { id, ids };
}

/** A ready image asset in R2 + D1 (an upload). */
async function imageAsset(ws: string, user: string): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const key = `ws/${ws}/uploads/${id}.png`;
  await env.MEDIA.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'mine', 'photo', ?, '{}', ?, ?, 'ready', 0)",
  )
    .bind(id, ws, key, user, Date.now())
    .run();
  return id;
}

/** Gives a node a valid active version (as if generated earlier with its current inputs). */
async function validVersion(projectId: string, user: string, ws: string, nodeId: string): Promise<string> {
  const room = projectRoom(env, projectId);
  const caller = { userId: user, workspaceId: ws, canEdit: true };
  const asset = await imageAsset(ws, user);
  const d = (await room.inputDigest(caller, nodeId)) as any;
  const v = (await room.addVersion({ nodeId, assetId: asset, inputDigest: d.digest, model: "bytedance/seedream-5.0-lite" })) as any;
  expect(v.ok).toBe(true);
  return asset;
}

async function quote(user: string, body: unknown): Promise<any> {
  const res = await api(user, "/api/runs/quote", { method: "POST", json: body });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function start(user: string, quoteId: string, options?: unknown): Promise<Response> {
  return api(user, "/api/runs", { method: "POST", json: { quoteId, ...(options ? { options } : {}) } });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runRow(runId: string): Promise<any> {
  return env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
}

async function finalRun(runId: string): Promise<any> {
  return waitFor(`run ${runId} to finish`, async () => {
    const r = await runRow(runId);
    return r && ["succeeded", "partial", "failed", "canceled"].includes(r.status) ? r : null;
  });
}

async function jobsOf(runId: string): Promise<any[]> {
  return (await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at").bind(runId).all()).results;
}

async function signedWebhook(id: string, type: string, dataId: string): Promise<Response> {
  const body = JSON.stringify({ id: `evt_${id}`, object: "event", type, data: { id: dataId } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hyperouter.signWebhook(WEBHOOK_SECRET, id, ts, body);
  return api(null, "/api/hooks/hyperouter", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig },
  });
}

// ---------------------------------------------------------------------------

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => json(listing)) as unknown as typeof fetch,
  });
  (env as { HYPEROUTER_WEBHOOK_SECRET?: string }).HYPEROUTER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  setGatewayFetchForTests(fakeFetch);
});

afterAll(() => setGatewayFetchForTests(null));

beforeEach(async () => {
  fake.reset();
  introspector = await introspectWorkflow(env.GENERATE);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    // Polling path by default: the first event wait times out at once.
    await m.forceEventTimeout({ name: "wait-1-1" });
    await m.forceEventTimeout({ name: "wait-2-1" });
  });
});

afterEach(async () => {
  await introspector.dispose();
});

const KEYFRAME = { model: "Seedream 5.0 Lite", prompt: "A bottle on a rock", ratio: "9:16", resolution: "2K" };
const SHOT = { model: "Seedance 2.0 Mini", prompt: "Slow push-in", ratio: "9:16", resolution: "480p", length: 5 };

describe("runs: run all", () => {
  it("reuses valid versions, blocks a missing input, runs keyframes before their videos and charges only what ran", async () => {
    const { user, ws } = await member("runall");
    const { id, ids } = await project(
      user,
      ws,
      [
        { kind: "script", title: "Script", params: { text: "Sparkling water, morning river." } },
        { kind: "image", title: "Keyframe A", params: KEYFRAME },
        { kind: "image", title: "Keyframe B", params: { ...KEYFRAME, prompt: "Cap close-up" } },
        { kind: "video", title: "Shot A", params: SHOT },
        { kind: "video", title: "Shot B", params: { ...SHOT, prompt: "Cap pop" } },
        { kind: "asset", title: "Missing photo", params: { media: "image" } },
        { kind: "video", title: "Shot C", params: { ...SHOT, prompt: "Pour" } },
      ],
      [
        ["Script", "Keyframe A", "prompt"],
        ["Keyframe A", "Shot A", "frame"],
        ["Keyframe B", "Shot B", "frame"],
        ["Missing photo", "Shot C", "frame"],
      ],
    );
    const keyframeAsset = await validVersion(id, user, ws, ids["Keyframe A"]!);

    const q = await quote(user, { projectId: id, scope: "all" });
    const row = (title: string) => q.items.find((i: any) => i.nodeId === ids[title]);
    expect(row("Script")).toMatchObject({ action: "none", credits: 0 });
    expect(row("Keyframe A")).toMatchObject({ action: "reuse", credits: 0, modelName: "Seedream 5.0 Lite" });
    expect(row("Keyframe B")).toMatchObject({ action: "run", model: "bytedance/seedream-5.0-lite" });
    expect(row("Shot A")).toMatchObject({ action: "run", model: "bytedance/seedance-2.0-mini" });
    expect(row("Shot B")).toMatchObject({ action: "run", dependsOn: [ids["Keyframe B"]] });
    expect(row("Shot C")).toMatchObject({ action: "blocked", code: "missing_input" });
    expect(row("Keyframe B").credits).toBeGreaterThan(0);
    expect(q.total).toBe(row("Keyframe B").credits + row("Shot A").credits + row("Shot B").credits);
    const before = await available(ws);
    expect(q.balanceAfter).toBe(before - q.total);
    expect(q).toMatchObject({ confirmThreshold: 300, needsConfirm: q.total >= 300 });

    const res = await start(user, q.quoteId);
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    // Idempotent per quote.
    expect(((await (await start(user, q.quoteId)).json()) as { runId: string }).runId).toBe(runId);

    const run = await finalRun(runId);
    expect(run.status).toBe("succeeded");
    const jobs = await jobsOf(runId);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === "succeeded" && j.refunded === 0)).toBe(true);

    // Shot B was submitted after Keyframe B finished, with its stored output as the first frame.
    const imageJob = fake.jobs.find((j) => j.kind === "image")!;
    const shotB = fake.jobs.find((j) => j.kind === "video" && j.body.prompt === "Cap pop")!;
    expect(String(shotB.body.first_frame)).toMatch(/^http:\/\/localhost:8787\/media\/ws\/.+\/gen\/job_.+\/0\.png\?/);
    const shotA = fake.jobs.find((j) => j.kind === "video" && j.body.prompt === "Slow push-in")!;
    expect(String(shotA.body.first_frame)).toContain(keyframeAsset);
    const imageDone = fake.calls.findIndex((c) => c.url === `/v1/generations/${imageJob.id}`);
    const shotBCreate = fake.calls.findIndex((c) => c.method === "POST" && c.key === jobs.find((j) => j.node_id === ids["Shot B"]).id);
    expect(shotBCreate).toBeGreaterThan(imageDone);
    // 9:16 at 2K for a size-based image model; idempotency key = job id.
    expect(imageJob.body).toMatchObject({ model: "bytedance/seedream-5.0-lite", size: "1536x2752", moderation: "auto" });
    expect(jobs.map((j) => j.id).sort()).toEqual(fake.jobs.map((j) => j.key).sort());

    // Charged the provider cost converted by creditsFor, never more than the hold.
    const spent = jobs.reduce((s, j) => s + j.cost_actual, 0);
    expect(run.credits_spent).toBe(spent);
    expect(spent).toBeLessThanOrEqual(q.total);
    expect(await available(ws)).toBe(before - spent);

    // New versions on the canvas; outputs copied to R2.
    const graph = (await projectRoom(env, id).getGraph({ userId: user, workspaceId: ws, canEdit: true })) as any;
    expect(graph.assets[ids["Shot B"]!]).toBeTruthy();
    const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(graph.assets[ids["Shot B"]!]).first<any>();
    expect(asset).toMatchObject({ kind: "video", source: "generated", status: "ready", project_id: id });
    expect(await env.MEDIA.head(asset.r2_key)).not.toBeNull();
    expect(JSON.parse(asset.meta).thumbKey).toMatch(/poster\.png$/);

    // Activity lists it with cost.
    const list = (await (await api(user, "/api/runs")).json()) as any;
    expect(list.runs[0]).toMatchObject({ id: runId, status: "done", credits: spent, refunded: 0, projectId: id });
    expect(list.runs[0].items).toHaveLength(3);
  });
});

describe("runs: failures and refunds", () => {
  it("refunds a forced failure (staging option) without calling the provider", async () => {
    const { user, ws } = await member("force");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: KEYFRAME }], []);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    const before = await available(ws);
    const res = await start(user, q.quoteId, { forceFailure: true });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const run = await finalRun(runId);
    expect(run).toMatchObject({ status: "failed", credits_spent: 0, credits_refunded: q.total });
    const [job] = await jobsOf(runId);
    expect(job).toMatchObject({ status: "failed", refunded: 1, error_code: "forced_failure", cost_quote: q.total });
    expect(fake.jobs).toHaveLength(0);
    expect(await available(ws)).toBe(before);
    const list = (await (await api(user, "/api/runs?status=failed")).json()) as any;
    expect(list.runs[0]).toMatchObject({ id: runId, status: "failed", refunded: q.total, credits: 0 });
    expect(list.runs[0].items[0]).toMatchObject({ errorCode: "forced_failure", refunded: q.total });
  });

  it("refunds a provider failure and skips dependents without charging them", async () => {
    const { user, ws } = await member("provfail");
    const { id, ids } = await project(
      user,
      ws,
      [
        { kind: "image", title: "Key", params: KEYFRAME },
        { kind: "video", title: "Shot", params: SHOT },
      ],
      [["Key", "Shot", "frame"]],
    );
    fake.rules.push({ model: "bytedance/seedream-5.0-lite", fail: { code: "content_rejected", message: "The provider rejected the content." } });
    const q = await quote(user, { projectId: id, scope: "all" });
    const before = await available(ws);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    const run = await finalRun(runId);
    expect(run.status).toBe("failed");
    const items = (await env.DB.prepare("SELECT ref, status, error_code FROM run_items WHERE run_id = ? ORDER BY ord").bind(runId).all()).results;
    expect(items).toEqual([
      { ref: ids.Key, status: "failed", error_code: "content_rejected" },
      { ref: ids.Shot, status: "skipped", error_code: "upstream_failed" },
    ]);
    expect(await jobsOf(runId)).toHaveLength(1);
    expect(fake.jobs.filter((j) => j.kind === "video")).toHaveLength(0);
    expect(await available(ws)).toBe(before);
  });

  it("retries an Auto run once on the next fallback model under the same hold", async () => {
    const { user, ws } = await member("autoretry");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: { model: "Auto", prompt: "A red apple" } }], []);
    fake.chatAnswer = JSON.stringify({ modelId: "bytedance/seedream-5.0-lite" });
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    expect(q.items[0]).toMatchObject({ action: "run", model: "bytedance/seedream-5.0-lite", autoVia: "classifier" });
    fake.rules.push({ model: "bytedance/seedream-5.0-lite", fail: { code: "upstream_error", message: "Upstream failed." } });
    const before = await available(ws);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    const run = await finalRun(runId);
    expect(run.status).toBe("succeeded");
    const [job] = await jobsOf(runId);
    expect(fake.jobs).toHaveLength(2);
    expect(fake.jobs[0]!.key).toBe(job.id);
    expect(fake.jobs[1]!.key).toBe(`${job.id}.r2`);
    expect(fake.jobs[1]!.model).not.toBe("bytedance/seedream-5.0-lite");
    expect(job).toMatchObject({ status: "succeeded", attempt: 2, model: fake.jobs[1]!.model });
    expect(job.cost_actual).toBeLessThanOrEqual(job.cost_quote);
    expect(await available(ws)).toBe(before - job.cost_actual);
  });

  it("re-submits with the same idempotency key after a retryable gateway error", async () => {
    const { user, ws } = await member("idem");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: KEYFRAME }], []);
    fake.rules.push({ model: "bytedance/seedream-5.0-lite", httpError: { status: 503, code: "upstream_error", shouldRetry: true } });
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    const [job] = await jobsOf(runId);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.url.startsWith("/v1/images"));
    expect(creates.length).toBe(2);
    expect(creates.every((c) => c.key === job.id)).toBe(true);
    expect(fake.jobs).toHaveLength(1);
  });

  it("cancels a run and releases its holds", async () => {
    const { user, ws } = await member("cancel");
    const { id, ids } = await project(user, ws, [{ kind: "video", title: "Shot", params: { ...SHOT, prompt: "Long" } }], []);
    fake.rules.push({ hold: true });
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Shot] });
    const before = await available(ws);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    await waitFor("submit", async () => fake.jobs.length === 1);
    expect(await available(ws)).toBe(before - q.total);
    const res = await api(user, `/api/runs/${runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, refunded: q.total, canceled: 1 });
    expect((await runRow(runId)).status).toBe("canceled");
    expect(await available(ws)).toBe(before);
  });
});

describe("runs: membership, plan caps, quotes", () => {
  it("returns NO_PLAN for non-members (D-007) while letting them quote", async () => {
    const user = newUser("noplan");
    expect((await api(user, "/api/projects")).status).toBe(200);
    const ws = personalWorkspaceId(user);
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: KEYFRAME }], []);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    expect(q.items[0]).toMatchObject({ action: "run" });
    const res = await start(user, q.quoteId);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: "NO_PLAN" } });
  });

  it("refuses a resolution above the plan cap with the lowest plan (D-006)", async () => {
    const { user, ws } = await member("cap", "starter");
    const { id, ids } = await project(user, ws, [{ kind: "video", title: "Shot", params: { ...SHOT, model: "Seedance 2.5", resolution: "1080p" } }], []);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Shot] });
    expect(q).toMatchObject({ quoteId: null, total: 0 });
    expect(q.items[0]).toMatchObject({ action: "blocked", code: "resolution_locked", lowestPlan: "plus", credits: 0 });
  });

  it("refuses a run larger than the balance with INSUFFICIENT_CREDITS", async () => {
    const { user, ws } = await member("poor", "starter", 0);
    const { id, ids } = await project(user, ws, [{ kind: "video", title: "Shot", params: { ...SHOT, model: "Seedance 2.5", resolution: "720p", length: 15 } }], []);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Shot] });
    expect(q.total).toBeGreaterThan(await available(ws));
    const res = await start(user, q.quoteId);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: "INSUFFICIENT_CREDITS", data: { needed: q.total } } });
  });

  it("quotes a tool-page prompt spec", async () => {
    const { user, ws } = await member("spec");
    const asset = await imageAsset(ws, user);
    const q = await quote(user, { promptSpec: { kind: "video", model: "Seedance 2.0 Mini", prompt: "Make it move", seconds: 5, resolution: "480p", inputs: { firstFrameAssetId: asset } } });
    expect(q.items[0]).toMatchObject({ ref: "spec", nodeId: null, action: "run", model: "bytedance/seedance-2.0-mini" });
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    expect(fake.jobs[0]!.body).toMatchObject({ first_frame: expect.stringContaining(asset) });
  });
});

describe("runs: webhooks", () => {
  it("finishes a job from the webhook, ignores duplicates and refuses bad signatures", async () => {
    const { user, ws } = await member("hook");
    const { id, ids } = await project(user, ws, [{ kind: "video", title: "Shot", params: SHOT }], []);
    fake.rules.push({ hold: true });
    await introspector.dispose();
    introspector = await introspectWorkflow(env.GENERATE);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Shot] });
    const t0 = Date.now();
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    const fj = await waitFor("submit", async () => fake.jobs[0]);
    await waitFor("external id", async () => (await jobsOf(runId))[0]?.external_id === fj.id);
    fj.done = true;

    const bad = await api(null, "/api/hooks/hyperouter", {
      method: "POST",
      body: JSON.stringify({ type: "video.completed", data: { id: fj.id } }),
      headers: { "webhook-id": "msg_bad", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" },
    });
    expect(bad.status).toBe(401);

    const ok = await signedWebhook("msg_1", "video.completed", fj.id);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect({ body: await ok.json(), job: (await jobsOf(runId))[0] }).toMatchObject({ body: { ok: true } });
    const dup = await signedWebhook("msg_1", "video.completed", fj.id);
    expect(await dup.json()).toEqual({ ok: true, duplicate: true });

    const run = await finalRun(runId);
    expect(run.status).toBe("succeeded");
    // Done before the first 10 s wait ran out: the event, not polling, finished it.
    expect(Date.now() - t0).toBeLessThan(9_500);
    const polls = fake.calls.filter((c) => c.method === "GET" && c.url === `/v1/videos/${fj.id}`);
    expect(polls.length).toBeLessThanOrEqual(2);
  });
});

describe("runs: live events", () => {
  async function socket(user: string, path: string): Promise<{ messages: { type: string; payload: any }[]; close: () => void }> {
    const res = await api(user, path, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: { type: string; payload: any }[] = [];
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
    ws.accept();
    return { messages, close: () => ws.close() };
  }

  it("pushes job.progress, node.version, job.done and credits.changed to the project and user sockets", async () => {
    const { user, ws } = await member("live");
    const { id, ids } = await project(user, ws, [{ kind: "video", title: "Shot", params: SHOT }], []);
    fake.rules.push({ runningPolls: 1 });
    await introspector.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "wait-1-2" });
    });
    const room = await socket(user, `/api/projects/${id}/ws`);
    const hub = await socket(user, "/api/ws");
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Shot] });
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    const [job] = await jobsOf(runId);
    await waitFor("done event", async () => room.messages.some((m) => m.type === "job.done"));
    await waitFor("settle push", async () => room.messages.filter((m) => m.type === "credits.changed").length >= 2);
    const types = room.messages.map((m) => m.type);
    expect(types).toContain("job.progress");
    expect(types).toContain("node.version");
    const progress = room.messages.filter((m) => m.type === "job.progress" && m.payload.jobId === job.id).map((m) => m.payload.progress);
    expect(progress).toContain(0.4);
    const credit = room.messages.filter((m) => m.type === "credits.changed").map((m) => m.payload);
    expect(credit.length).toBeGreaterThanOrEqual(2);
    expect(credit.at(-1)).toMatchObject({ workspaceId: ws, balance: await available(ws), held: 0 });
    await waitFor("hub credits", async () => hub.messages.some((m) => m.type === "credits.changed"));
    expect(hub.messages.some((m) => m.type === "activity.updated")).toBe(true);
    room.close();
    hub.close();
  });

  it("sends job.failed with the refunded credits the node shows", async () => {
    const { user, ws } = await member("livefail");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: KEYFRAME }], []);
    const room = await socket(user, `/api/projects/${id}/ws`);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    const { runId } = (await (await start(user, q.quoteId, { forceFailure: [ids.Key] })).json()) as { runId: string };
    await finalRun(runId);
    const failed = await waitFor("job.failed", async () => room.messages.find((m) => m.type === "job.failed"));
    expect(failed.payload).toMatchObject({ nodeId: ids.Key, refunded: q.total, reason: expect.stringContaining("Forced failure") });
    const snap = (await projectRoom(env, id).getSnapshot({ userId: user, workspaceId: ws, canEdit: true })) as any;
    expect(snap.nodes.find((n: any) => n.id === ids.Key).status).toBe("failed");
    room.close();
  });
});

describe("runs: GraphQL", () => {
  it("lists runs with cost and refunds for Activity", async () => {
    const { user, ws } = await member("gql");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: KEYFRAME }], []);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    const { runId } = (await (await start(user, q.quoteId, { forceFailure: true })).json()) as { runId: string };
    await finalRun(runId);
    const res = await api(user, "/api/graphql", {
      method: "POST",
      json: { query: "{ runs(filter: { status: \"failed\" }, first: 5) { nodes { id status credits refunded items { status errorCode } } stats { refundedThisMonth } pageInfo { hasNextPage } } }" },
    });
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.runs.nodes[0]).toMatchObject({ id: runId, status: "failed", credits: 0, refunded: q.total, items: [{ status: "failed", errorCode: "forced_failure" }] });
    expect(body.data.runs.stats.refundedThisMonth).toBe(q.total);
  });
});

/** A ready media asset (an upload) with optional meta (durationSec, thumbKey). */
async function mediaAsset(ws: string, user: string, kind: "image" | "video" | "audio", meta: Record<string, unknown> = {}): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
  const key = `ws/${ws}/uploads/${id}.${ext}`;
  await env.MEDIA.put(key, kind === "image" ? PNG : MP4, { httpMetadata: { contentType: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg" } });
  await env.DB.prepare(
    "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, ?, 'mine', ?, ?, ?, ?, ?, 'ready', 0)",
  )
    .bind(id, ws, kind, `${kind} upload`, key, JSON.stringify(meta), user, Date.now())
    .run();
  return id;
}

async function runView(user: string, runId: string): Promise<any> {
  const res = await api(user, `/api/runs/${runId}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { run: any }).run;
}

describe("runs: tool specs (remix, avatar, character)", () => {
  it("avatar: a lip-sync run on lumina/wan2.7-i2v-spicy with the photo as first frame and the voice track as audio_url", async () => {
    const { user, ws } = await member("avatar");
    const photo = await imageAsset(ws, user);
    const voice = await mediaAsset(ws, user, "audio", { durationSec: 6.4 });
    const q = await quote(user, { promptSpec: { kind: "avatar", resolution: "720p", inputs: { photoAssetId: photo, audioAssetId: voice } } });
    expect(q.items).toEqual([expect.objectContaining({ ref: "avatar", action: "run", model: "lumina/wan2.7-i2v-spicy" })]);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    expect(fake.jobs[0]!.body).toMatchObject({ model: "lumina/wan2.7-i2v-spicy", seconds: 7, audio: true, audio_url: expect.stringContaining(voice) });
    expect(JSON.stringify(fake.jobs[0]!.body)).toContain(photo);
    const view = await runView(user, runId);
    expect(view).toMatchObject({ id: runId, tool: "avatar", status: "done", request: { promptSpec: { kind: "avatar", inputs: { photoAssetId: photo, audioAssetId: voice } } } });

    // Without an uploaded voice track nothing runs.
    const none = await quote(user, { promptSpec: { kind: "avatar", inputs: { photoAssetId: photo } } });
    expect(none).toMatchObject({ quoteId: null, items: [{ action: "blocked", code: "missing_input", reason: "Upload a voice track." }] });
  });

  it("remix: one refs-mode video per shot with the reference video and the new looks", async () => {
    const { user, ws } = await member("remix");
    const clip = await mediaAsset(ws, user, "video", { durationSec: 10 });
    const look = await imageAsset(ws, user);
    const q = await quote(user, {
      promptSpec: { kind: "remix", model: "Seedance 2.0 Mini", prompt: "Two friends in streetwear", resolution: "480p", ratio: "16:9", shots: [{ prompt: "They walk in" }, { prompt: "They wave" }], inputs: { videoAssetId: clip, referenceAssetIds: [look] } },
    });
    expect(q.items.map((i: any) => [i.ref, i.action])).toEqual([["shot-1", "run"], ["shot-2", "run"]]);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    expect(fake.jobs).toHaveLength(2);
    for (const j of fake.jobs) {
      expect(j.body).toMatchObject({ model: "bytedance/seedance-2.0-mini", seconds: 5 });
      expect(JSON.stringify(j.body)).toContain(clip);
      expect(JSON.stringify(j.body)).toContain(look);
    }
    const view = await runView(user, runId);
    expect(view).toMatchObject({ name: "Remix", tool: "remix", items: [{ ref: "shot-1", status: "succeeded" }, { ref: "shot-2", status: "succeeded" }] });
  });

  it("character: full body, then the face from it, saved to Characters on success", async () => {
    const { user, ws } = await member("chara");
    const ref = await imageAsset(ws, user);
    const q = await quote(user, { promptSpec: { kind: "character", name: "Mira", prompt: "A cyclist in a yellow jacket", resolution: "2K", inputs: { referenceAssetIds: [ref] } } });
    expect(q.items.map((i: any) => [i.ref, i.action, i.dependsOn])).toEqual([["body", "run", []], ["face", "run", ["body"]]]);
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("succeeded");
    const [body, face] = fake.jobs;
    expect(JSON.stringify(body!.body)).toContain(ref);
    // The face is made from the stored full-body output (after it finished).
    expect(JSON.stringify(face!.body)).toMatch(/\/gen\/job_[^/]+\/0\.png/);
    const view = await waitFor("character saved", async () => {
      const v = await runView(user, runId);
      return v.characterId ? v : null;
    });
    const chars = (await (await api(user, "/api/characters")).json()) as any;
    const saved = chars.items.find((c: any) => c.id === view.characterId);
    expect(saved).toMatchObject({ name: "Mira" });
    expect(saved.versions).toHaveLength(1);
    expect(saved.versions[0].assetIds).toHaveLength(2);
    expect(saved.coverAssetId).toBe(saved.versions[0].assetIds[1]);
  });
});

describe("runs: retry and single read", () => {
  it("GET /api/runs/:id returns the run with its request; unknown and foreign runs are 404", async () => {
    const { user } = await member("one");
    const q = await quote(user, { promptSpec: { kind: "image", model: "Seedream 5.0 Lite", prompt: "A lemon", resolution: "2K" } });
    const { runId } = (await (await start(user, q.quoteId)).json()) as { runId: string };
    await finalRun(runId);
    const view = await runView(user, runId);
    expect(view).toMatchObject({ id: runId, tool: "quick", retryable: false, request: { promptSpec: { kind: "image", prompt: "A lemon", model: "Seedream 5.0 Lite" } } });
    expect((await api(user, "/api/runs/run_nope")).status).toBe(404);
    const other = await member("two");
    expect((await api(other.user, `/api/runs/${runId}`)).status).toBe(404);
    // Nothing failed: nothing to retry.
    const res = await api(user, `/api/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.data.reason).toBe("NOTHING_TO_RETRY");
  });

  it("retries a failed tool run with the same spec: a fresh quote the client confirms, linked to the first run", async () => {
    const { user, ws } = await member("retryspec");
    const photo = await imageAsset(ws, user);
    const voice = await mediaAsset(ws, user, "audio", { durationSec: 3 });
    const spec = { kind: "avatar", prompt: "Hello there", inputs: { photoAssetId: photo, audioAssetId: voice } };
    const q = await quote(user, { promptSpec: spec });
    const { runId } = (await (await start(user, q.quoteId, { forceFailure: true })).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("failed");
    expect(await runView(user, runId)).toMatchObject({ retryable: true });

    const res = await api(user, `/api/runs/${runId}/retry`, { method: "POST" });
    expect(res.status, await res.clone().text()).toBe(200);
    const retry = (await res.json()) as any;
    expect(retry).toMatchObject({ retryOf: runId, total: q.total, items: [{ ref: "avatar", action: "run" }], needsConfirm: q.total >= 300 });
    expect(retry.quoteId).not.toBe(q.quoteId);
    const started = (await (await start(user, retry.quoteId)).json()) as { runId: string };
    expect((await finalRun(started.runId)).status).toBe("succeeded");
    expect(await runView(user, started.runId)).toMatchObject({ retryOf: runId, tool: "avatar", request: { promptSpec: { prompt: "Hello there" } } });
    expect(fake.jobs[0]!.body).toMatchObject({ prompt: "Hello there", model: "lumina/wan2.7-i2v-spicy" });
  });

  it("retries only the failed nodes of a canvas run", async () => {
    const { user, ws } = await member("retrycanvas");
    const { id, ids } = await project(user, ws, [
      { kind: "image", title: "A", params: KEYFRAME },
      { kind: "image", title: "B", params: { ...KEYFRAME, prompt: "Other" } },
    ], []);
    const q = await quote(user, { projectId: id, scope: "all" });
    const { runId } = (await (await start(user, q.quoteId, { forceFailure: [ids.B] })).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("partial");
    const view = await runView(user, runId);
    expect(view).toMatchObject({ status: "partial", retryable: true, request: { scope: "all" } });
    const retry = (await (await api(user, `/api/runs/${runId}/retry`, { method: "POST" })).json()) as any;
    expect(retry.items.filter((i: any) => i.action === "run").map((i: any) => i.nodeId)).toEqual([ids.B]);
    const started = (await (await start(user, retry.quoteId)).json()) as { runId: string };
    expect((await finalRun(started.runId)).status).toBe("succeeded");
    expect(await runView(user, started.runId)).toMatchObject({ retryOf: runId, request: { scope: "selection", nodeIds: [ids.B] } });
  });

  it("a character whose face failed: the retry makes only the face from the earlier body and adds it to the Character", async () => {
    const { user } = await member("retrychar");
    const q = await quote(user, { promptSpec: { kind: "character", name: "Ola", prompt: "A tall baker", resolution: "2K" } });
    const { runId } = (await (await start(user, q.quoteId, { forceFailure: ["face"] })).json()) as { runId: string };
    expect((await finalRun(runId)).status).toBe("partial");
    const first = await waitFor("saved", async () => ((await runView(user, runId)).characterId ? runView(user, runId) : null));
    const bodyAsset = first.items.find((i: any) => i.ref === "body").assetId;
    const retry = (await (await api(user, `/api/runs/${runId}/retry`, { method: "POST" })).json()) as any;
    expect(retry.items.map((i: any) => [i.ref, i.action])).toEqual([["face", "run"]]);
    fake.reset();
    const started = (await (await start(user, retry.quoteId)).json()) as { runId: string };
    expect((await finalRun(started.runId)).status).toBe("succeeded");
    expect(JSON.stringify(fake.jobs[0]!.body)).toMatch(/\/gen\/job_[^/]+\/0\.png/);
    const second = await waitFor("saved", async () => ((await runView(user, started.runId)).characterId ? runView(user, started.runId) : null));
    expect(second.characterId).toBe(first.characterId);
    const chars = (await (await api(user, "/api/characters")).json()) as any;
    const saved = chars.items.find((c: any) => c.id === first.characterId);
    expect(saved.versions.map((v: any) => v.assetIds.length)).toEqual([1, 2]);
    expect(saved.versions[1].assetIds[0]).toBe(bodyAsset);
  });
});
