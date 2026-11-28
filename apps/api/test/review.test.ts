/**
 * D-024 result review in the run pipeline (workers pool, fake gateway, fake
 * safety and review LLMs): the verdict is stored on the job, the assets and the
 * version; a bad verdict offers "Retry with fix"; Auto mode retries once per
 * node within the turn's budget and keeps the better version current; the
 * best of several takes is preselected; the review's gateway cost is recorded
 * and never charged.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { type ChatEvent, type ChatRequest, type LlmProvider } from "@rolling/core";
import { DEFAULT_PREFS } from "@rolling/core/auth/prefs";
import type { ImageAssessment, TextAssessment } from "@rolling/core/safety";
import { buildContext } from "../src/auth/context";
import { loadAccount, personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { setReviewLlmForTests } from "../src/runs/review";
import { quoteRun, startRun } from "../src/runs/service";
import { setSafetyLlmForTests } from "../src/safety/service";

const BASE = "https://example.com";
const DAY = 86_400_000;
const MODEL = "bytedance/seedream-5.0-flash";
const MULTI = "x-ai/grok-imagine-image";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const REVIEW_COST = 0.0009;
const RENDER_COST = 0.018;

let gen = 0;
const creates: Record<string, unknown>[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "cdn.fake") return new Response(new Uint8Array([...PNG, ...new TextEncoder().encode(url.pathname)]), { headers: { "content-type": "image/png" } });
  if (req.method === "POST" && url.pathname.startsWith("/v1/images/")) {
    const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
    creates.push(body);
    return json({ id: `gen_${++gen}_${typeof body.n === "number" ? body.n : 1}`, status: "queued" }, 202);
  }
  const m = /^\/v1\/generations\/(gen_\d+_(\d+))$/.exec(url.pathname);
  if (m) {
    const n = Number(m[2]);
    return json({ data: { id: m[1], kind: "image", status: "done", usage: { cost: RENDER_COST * n }, outputs: Array.from({ length: n }, (_, i) => ({ url: `https://cdn.fake/${m[1]}-${i}.png` })) } });
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
const SAFE_IMAGE: ImageAssessment = { rating: "safe", confidence: 0.9, photographic: false, apparentMinor: false, minorSexualized: false, knownPerson: false, animalSexual: false, extremeViolence: false, violentExtremism: false, selfHarm: false };
const fakeSafetyLlm: LlmProvider = {
  id: "fake-safety",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const user = req.messages.find((m) => m.role === "user")!;
    const images = typeof user.content === "string" ? 0 : user.content.filter((p) => p.type === "image_url").length;
    yield { type: "text", delta: images > 0 ? JSON.stringify({ images: Array.from({ length: images }, () => SAFE_IMAGE) }) : JSON.stringify(SAFE_TEXT) };
    yield { type: "done", id: "s", finishReason: "stop" };
  },
};

const FIX_PROMPT = "A chef plating pasta, relaxed hands with five fingers each";
const GOOD = { scores: { anatomy: 5, text: 5, adherence: 5, continuity: null, framing: 5, artifacts: 5 }, issues: [], fix: null };
const BAD = {
  scores: { anatomy: 2, text: 5, adherence: 4, continuity: null, framing: 5, artifacts: 4 },
  issues: [{ dimension: "anatomy", severity: "major", note: "Left hand has six fingers" }],
  fix: { prompt: FIX_PROMPT, negativePrompt: "extra fingers", note: "Asks for natural hands" },
};
const WORSE = { scores: { anatomy: 1, text: 2, adherence: 3, continuity: null, framing: 5, artifacts: 3 }, issues: [{ dimension: "anatomy", severity: "major", note: "Both hands melted" }], fix: null };

const reviewer = {
  calls: [] as ChatRequest[],
  /** Verdicts by prompt: the first matching key wins; takes repeat the list. */
  verdicts: (prompt: string, takes: number): unknown[] => Array.from({ length: takes }, () => (prompt.includes("relaxed hands") ? GOOD : BAD)),
};
const fakeReviewLlm: LlmProvider = {
  id: "fake-review",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    reviewer.calls.push(req);
    const parts = req.messages[1]!.content as { type: string; text?: string }[];
    const brief = JSON.parse(parts[0]!.text!.slice("Brief: ".length, parts[0]!.text!.indexOf("\n"))) as { prompt: string };
    const takes = parts.filter((p) => p.type === "text" && p.text!.startsWith("Take ")).length;
    yield { type: "text", delta: JSON.stringify({ takes: reviewer.verdicts(brief.prompt, takes) }) };
    yield { type: "usage", usage: { promptTokens: 3000, completionTokens: 300, totalTokens: 3300, cachedTokens: 0, costUsd: REVIEW_COST } };
    yield { type: "done", id: "r", finishReason: "stop" };
  },
};

let seq = 0;
function api(userId: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string): Promise<{ user: string; ws: string }> {
  const user = `${tag}${Date.now().toString(36)}${++seq}`;
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, now + 30 * DAY, now)
    .run();
  const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
  expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
  return { user, ws };
}

async function canvas(user: string, ws: string, params: Record<string, unknown>): Promise<{ projectId: string; nodeId: string }> {
  const res = await api(user, "/api/projects", { method: "POST", json: { title: "Review test" } });
  expect(res.status).toBe(201);
  const projectId = ((await res.json()) as { project: { id: string } }).project.id;
  const r = (await projectRoom(env, projectId).applyPatch({ userId: user, workspaceId: ws, canEdit: true }, { baseRevision: 0, ops: [{ op: "addNode", tempId: "a", kind: "image", title: "Shot 3", params }] })) as any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { projectId, nodeId: r.idMap.a };
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

const runEnded = (runId: string) =>
  waitFor("run end", async () => {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<any>();
    return r && ["succeeded", "partial", "failed", "canceled"].includes(r.status) ? r : null;
  });

/** Quotes and starts a node run as the user; `auto` starts it the way Auto mode does (server options). */
async function runNode(user: string, ws: string, projectId: string, nodeId: string, auto?: { budgetLeft: number; turnId?: string; turnBudget?: number }): Promise<string> {
  if (!auto) {
    const q = await api(user, "/api/runs/quote", { method: "POST", json: { projectId, scope: "node", nodeIds: [nodeId] } });
    expect(q.status, await q.clone().text()).toBe(200);
    const { quoteId } = (await q.json()) as { quoteId: string };
    const s = await api(user, "/api/runs", { method: "POST", json: { quoteId } });
    expect(s.status, await s.clone().text()).toBe(201);
    return ((await s.json()) as { runId: string }).runId;
  }
  const { memberships, prefs } = await loadAccount(env as Env, user);
  const auth = buildContext(user, null, null, memberships, prefs ?? DEFAULT_PREFS, ws);
  const caller = { userId: user, workspaceId: ws, canEdit: true };
  const q = await quoteRun(env as Env, auth, { projectId, scope: "node", nodeIds: [nodeId], caller, matureAllowed: false, surface: "agent" });
  return (await startRun(env as Env, auth, q.quoteId!, {}, { auto })).runId;
}

async function versions(user: string, ws: string, projectId: string, nodeId: string) {
  const r = (await projectRoom(env, projectId).listVersions({ userId: user, workspaceId: ws, canEdit: true }, nodeId)) as any;
  return r as { versions: { id: string; n: number; jobId: string; assetId: string; active: boolean; output: any }[]; activeVersionId: string };
}

async function nodeParams(user: string, ws: string, projectId: string, nodeId: string) {
  const g = (await projectRoom(env, projectId).getGraph({ userId: user, workspaceId: ws, canEdit: true })) as any;
  return { params: g.state.nodes.find((n: any) => n.id === nodeId).params as Record<string, unknown>, reviews: g.reviews as Record<string, any> };
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
  setGatewayFetchForTests(fakeFetch);
  setSafetyLlmForTests(() => fakeSafetyLlm);
  setReviewLlmForTests(() => fakeReviewLlm);
});

afterAll(() => {
  setGatewayFetchForTests(null);
  setSafetyLlmForTests(null);
  setReviewLlmForTests(null);
});

beforeEach(async () => {
  reviewer.calls = [];
  reviewer.verdicts = (prompt, takes) => Array.from({ length: takes }, () => (prompt.includes("relaxed hands") ? GOOD : BAD));
  creates.length = 0;
  introspector = await introspectWorkflow(env.GENERATE);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    for (let i = 1; i <= 3; i++) await m.forceEventTimeout({ name: `wait-1-${i}` });
  });
});

afterEach(async () => {
  await introspector.dispose();
});

const PARAMS = { prompt: "A chef plating pasta", model: MODEL, mode: "t2i", ratio: "1:1", negativePrompt: "blur" };

describe("Result review (D-024)", () => {
  it("stores the verdict on the job, the asset and the version, offers Retry with fix, and charges only the render", async () => {
    const { user, ws } = await member("rv");
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    const credits = env.CREDITS.get(env.CREDITS.idFromName(ws));
    const before = await credits.balance();
    const runId = await runNode(user, ws, projectId, nodeId);
    expect((await runEnded(runId)).status).toBe("succeeded");

    const job = await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    const review = JSON.parse(job.review);
    expect(review).toMatchObject({ v: 1, grade: "poor", best: 0, costUsd: REVIEW_COST, action: { kind: "offer", reason: "manual" }, fix: { prompt: FIX_PROMPT } });
    expect(review.issues[0]).toEqual({ dimension: "anatomy", severity: "major", note: "Left hand has six fingers" });
    expect(job.review_cost_usd).toBe(REVIEW_COST);
    const asset = await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(job.asset_id).first<{ meta: string }>();
    expect(JSON.parse(asset!.meta).review).toMatchObject({ grade: "poor", best: true });

    const v = await versions(user, ws, projectId, nodeId);
    expect(v.versions).toHaveLength(1);
    expect(v.versions[0]!.output.review).toMatchObject({ grade: "poor", action: { kind: "offer" } });
    const g = await nodeParams(user, ws, projectId, nodeId);
    expect(g.reviews[nodeId]).toMatchObject({ grade: "poor", offer: true, autoRetried: false, fix: { prompt: FIX_PROMPT } });
    // No retry without the user.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE retry_of = ?").bind(runId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(g.params.prompt).toBe(PARAMS.prompt);

    // Cost: the ledger moved by the render's price only; the review's gateway cost is recorded, not charged.
    const after = await credits.balance();
    expect(before.plan + before.purchased - (after.plan + after.purchased)).toBe(job.cost_actual);
    expect(job.cost_actual).toBe(Math.ceil((RENDER_COST * 3) / 0.01));
    // One review call, on the cheapest vision model, with the stored picture inline.
    expect(reviewer.calls).toHaveLength(1);
    const parts = reviewer.calls[0]!.messages[1]!.content as { type: string; imageUrl?: string }[];
    expect(parts.filter((p) => p.type === "image_url").every((p) => p.imageUrl!.startsWith("data:image/"))).toBe(true);
    expect(reviewer.calls[0]!.model).toMatch(/^deepseek\/deepseek-v4\.1-flash/);
  }, 60_000);

  it("skips the review when the preference is off", async () => {
    const { user, ws } = await member("rvoff");
    expect((await api(user, "/api/me/prefs", { method: "PATCH", json: { reviewResults: false } })).status).toBe(200);
    expect(((await (await api(user, "/api/me")).json()) as any).prefs.reviewResults).toBe(false);
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    const runId = await runNode(user, ws, projectId, nodeId);
    expect((await runEnded(runId)).status).toBe("succeeded");
    const job = await env.DB.prepare("SELECT review FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    expect(job.review).toBeNull();
    expect(reviewer.calls).toHaveLength(0);
    expect((await versions(user, ws, projectId, nodeId)).versions[0]!.output.review).toBeUndefined();
  }, 60_000);

  it("Auto mode retries once within the budget with the fix and keeps the better version current", async () => {
    const { user, ws } = await member("rvauto");
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    const runId = await runNode(user, ws, projectId, nodeId, { budgetLeft: 300 });
    expect((await runEnded(runId)).status).toBe("succeeded");
    const retry = await waitFor("retry run", () => env.DB.prepare("SELECT * FROM runs WHERE retry_of = ?").bind(runId).first<any>());
    expect(JSON.parse(retry.options).reviewRetryOf.jobId).toBeTruthy();
    expect((await runEnded(retry.id)).status).toBe("succeeded");

    const v = await waitFor("two versions", async () => {
      const x = await versions(user, ws, projectId, nodeId);
      return x.versions.length === 2 ? x : null;
    });
    const active = v.versions.find((x) => x.active)!;
    expect(active.n).toBe(2);
    expect(active.output.review).toMatchObject({ grade: "good", retryOf: { jobId: expect.any(String) } });
    expect(v.versions.find((x) => x.n === 1)!.output.review.action).toMatchObject({ kind: "auto" });
    const g = await nodeParams(user, ws, projectId, nodeId);
    expect(g.params).toMatchObject({ prompt: FIX_PROMPT, negativePrompt: "blur, extra fingers" });
    const first = await env.DB.prepare("SELECT review FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    expect(JSON.parse(first.review).action).toEqual({ kind: "auto", runId: retry.id });
    const row = await env.DB.prepare("SELECT * FROM review_retries WHERE budget_key = ?").bind(runId).first<any>();
    expect(row).toMatchObject({ node_id: nodeId, retry_run_id: retry.id, credits: retry.credits_quoted });
    // Once per node: the retry's own run never retries again.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE retry_of = ?").bind(retry.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect(reviewer.calls).toHaveLength(2);
  }, 90_000);

  it("keeps the original current when the retry is worse, and puts its params back", async () => {
    reviewer.verdicts = (prompt, takes) => Array.from({ length: takes }, () => (prompt.includes("relaxed hands") ? WORSE : BAD));
    const { user, ws } = await member("rvworse");
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    const runId = await runNode(user, ws, projectId, nodeId, { budgetLeft: 300 });
    await runEnded(runId);
    const retry = await waitFor("retry run", () => env.DB.prepare("SELECT * FROM runs WHERE retry_of = ?").bind(runId).first<any>());
    await runEnded(retry.id);
    const v = await waitFor("original current again", async () => {
      const x = await versions(user, ws, projectId, nodeId);
      return x.versions.length === 2 && x.versions.find((y) => y.active)?.n === 1 ? x : null;
    });
    expect(v.versions).toHaveLength(2);
    const g = await nodeParams(user, ws, projectId, nodeId);
    expect(g.params.prompt).toBe(PARAMS.prompt);
    expect(g.params.negativePrompt).toBe("blur");
  }, 90_000);

  it("Auto mode over budget offers the fix instead of retrying", async () => {
    const { user, ws } = await member("rvbudget");
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    const runId = await runNode(user, ws, projectId, nodeId, { budgetLeft: 2 });
    expect((await runEnded(runId)).status).toBe("succeeded");
    const job = await env.DB.prepare("SELECT review FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    expect(JSON.parse(job.review).action).toEqual({ kind: "offer", reason: "budget" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE retry_of = ?").bind(runId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM review_retries WHERE budget_key = ?").bind(runId).first<{ n: number }>()).toEqual({ n: 0 });
  }, 60_000);

  it("Auto mode counts the turn's other runs against its budget", async () => {
    const { user, ws } = await member("rvturn");
    const { projectId, nodeId } = await canvas(user, ws, PARAMS);
    // The snapshot says 300 left, but the turn's budget is 10 and this run already took 6: a 6-credit retry does not fit.
    const turnId = `turn_${user}`;
    const runId = await runNode(user, ws, projectId, nodeId, { budgetLeft: 300, turnId, turnBudget: 10 });
    expect((await runEnded(runId)).status).toBe("succeeded");
    const job = await env.DB.prepare("SELECT review FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    expect(JSON.parse(job.review).action).toEqual({ kind: "offer", reason: "budget" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE retry_of = ?").bind(runId).first<{ n: number }>()).toEqual({ n: 0 });
  }, 60_000);

  it("ranks the takes of a multi-take run and preselects the best", async () => {
    reviewer.verdicts = (_prompt, takes) => Array.from({ length: takes }, (_, i) => (i === 2 ? GOOD : BAD));
    const { user, ws } = await member("rvtakes");
    const { projectId, nodeId } = await canvas(user, ws, { ...PARAMS, model: MULTI, count: 3 });
    const runId = await runNode(user, ws, projectId, nodeId);
    expect((await runEnded(runId)).status).toBe("succeeded");
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<any>();
    const review = JSON.parse(job.review);
    expect(review.takes).toHaveLength(3);
    expect(review.best).toBe(2);
    expect(review.action).toEqual({ kind: "none" });
    const v = await versions(user, ws, projectId, nodeId);
    const out = v.versions[0]!.output as { assetIds: string[] };
    expect(v.versions[0]!.assetId).toBe(out.assetIds[2]);
    expect(job.asset_id).toBe(out.assetIds[2]);
  }, 60_000);

  it("sends an image shot's character sheet pictures as references for continuity, not its other edit inputs (D-032)", async () => {
    const { user, ws } = await member("rvchar");
    const picture = async (meta: Record<string, unknown>, tag: string) => {
      const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
      const key = `ws/${ws}/generated/${id}.png`;
      await env.MEDIA.put(key, new Uint8Array([...PNG, ...new TextEncoder().encode(tag)]), { httpMetadata: { contentType: "image/png" } });
      await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'generated', ?, ?, ?, ?, ?, 'ready', 0)")
        .bind(id, ws, tag, key, JSON.stringify(meta), user, Date.now())
        .run();
      return id;
    };
    const sheet = await picture({ characterSheet: { characterId: "chr_test", version: 1, view: "front", realFace: false } }, "sheet");
    const plain = await picture({}, "plain");
    const res = await api(user, "/api/projects", { method: "POST", json: { title: "Character review" } });
    const projectId = ((await res.json()) as { project: { id: string } }).project.id;
    const r = (await projectRoom(env, projectId).applyPatch(
      { userId: user, workspaceId: ws, canEdit: true },
      {
        baseRevision: 0,
        ops: [
          { op: "addNode", tempId: "node_plain", kind: "asset", title: "Cafe photo", params: { assetId: plain, media: "image" } },
          { op: "addNode", tempId: "node_sheet", kind: "asset", title: "Maya (front)", params: { assetId: sheet, media: "image", source: "character", characterId: "chr_test", view: "front" } },
          { op: "addNode", tempId: "node_shot", kind: "image", title: "Cafe shot", params: { ...PARAMS, mode: "edit" } },
          { op: "connect", from: { node: "node_plain", port: "out" }, to: { node: "node_shot", port: "refs" } },
          { op: "connect", from: { node: "node_sheet", port: "out" }, to: { node: "node_shot", port: "refs" } },
        ],
      },
    )) as any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const runId = await runNode(user, ws, projectId, "node_shot");
    expect((await runEnded(runId)).status).toBe("succeeded");
    expect(reviewer.calls).toHaveLength(1);
    const parts = reviewer.calls[0]!.messages[1]!.content as { type: string; text?: string }[];
    const refs = parts.filter((p) => p.type === "text" && p.text!.startsWith("Reference picture"));
    expect(refs).toHaveLength(1);
    // One reference picture before the take's own picture.
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
  }, 60_000);
});
