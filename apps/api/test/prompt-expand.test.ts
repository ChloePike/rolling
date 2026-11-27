/**
 * D-020 "Enhance prompt" (Hyperouter `prompt_expand`) in the run pipeline
 * (workers pool, fake gateway, fake safety LLM): the quote and the hold include
 * the rewrite's most, the settle is on `usage.cost`, `expanded_prompt` is
 * stored and checked, and `403 feature_not_enabled` resubmits without the
 * expansion and flags the environment.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { Catalog, creditsFor, creditsForUsd, promptExpansionMaxUsd, type ChatEvent, type ChatRequest, type LlmProvider } from "@rolling/core";
import type { TextAssessment, ImageAssessment } from "@rolling/core/safety";
import { personalWorkspaceId } from "../src/auth/workspace";
import { syncModels } from "../src/models/sync";
import { resetFeatureMemoForTests } from "../src/models/features";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { setSafetyLlmForTests } from "../src/safety/service";

const BASE = "https://example.com";
const DAY = 86_400_000;
const MODEL = "bytedance/seedream-5.0-flash";
const WRITER = "deepseek/deepseek-v4.1-flash-us";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const catalog = Catalog.fromListing(listing).catalog;
const chat = catalog.list({ kind: "chat", includeHidden: true, includeMatureOnly: true });

const gateway = {
  creates: [] as { body: any; key: string | null }[],
  seq: 0,
  /** Answer `403 feature_not_enabled` to any create with `prompt_expand`. */
  featureOff: false,
  /** `expanded_prompt` of finished images (null = nothing expanded). */
  expanded: "A red bicycle leaning on a brick wall at golden hour, shallow depth of field" as string | null,
  cost: 0.0215,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "cdn.fake") return new Response(new Uint8Array([...PNG, ...new TextEncoder().encode(`${url.pathname}:${crypto.randomUUID()}`)]), { headers: { "content-type": "image/png" } });
  if (url.pathname === "/v1/chat/completions") {
    return new Response(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/images/")) {
    const body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
    gateway.creates.push({ body, key: req.headers.get("idempotency-key") });
    if (gateway.featureOff && body?.prompt_expand) {
      return json({ error: { message: "Prompt expansion is not enabled for this account.", type: "permission_error", code: "feature_not_enabled", param: "prompt_expand" } }, 403);
    }
    return json({ id: `gen_${++gateway.seq}`, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) {
    const last = gateway.creates.at(-1)?.body as { prompt_expand?: boolean } | undefined;
    const expanded = last?.prompt_expand ? gateway.expanded : null;
    return json({ data: { id: gen[1], kind: "image", status: "done", usage: { cost: gateway.cost }, outputs: [{ url: `https://cdn.fake/${gen[1]}.png` }], expanded_prompt: expanded } });
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
const texts: string[] = [];
const fakeSafetyLlm: LlmProvider = {
  id: "fake-safety",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const user = req.messages.find((m) => m.role === "user")!;
    const images = typeof user.content === "string" ? 0 : user.content.filter((p) => p.type === "image_url").length;
    if (images === 0) texts.push(typeof user.content === "string" ? user.content : JSON.stringify(user.content));
    const answer = images > 0 ? JSON.stringify({ images: Array.from({ length: images }, () => SAFE_IMAGE) }) : JSON.stringify(SAFE_TEXT);
    yield { type: "text", delta: answer };
    yield { type: "done", id: "s", finishReason: "stop" };
  },
};

let seq = 0;
function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string, opts: { mature?: boolean; enhance?: boolean } = {}): Promise<{ user: string; ws: string }> {
  const user = `${tag}${Date.now().toString(36)}${++seq}`;
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, now + 30 * DAY, now)
    .run();
  const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
  expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
  expect((await stub.purchase(5000, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  if (opts.mature) await env.DB.prepare("UPDATE user_prefs SET mature_content = 1 WHERE user_id = ?").bind(user).run();
  if (opts.enhance === false) expect((await api(user, "/api/me/prefs", { method: "PATCH", json: { enhancePrompt: false } })).status).toBe(200);
  return { user, ws };
}

const image = (prompt: string, extra: Record<string, unknown> = {}) => ({ promptSpec: { kind: "image", model: MODEL, prompt, ...extra } });

async function quote(user: string, body: unknown): Promise<any> {
  const res = await api(user, "/api/runs/quote", { method: "POST", json: body });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
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
  gateway.creates = [];
  gateway.featureOff = false;
  gateway.expanded = "A red bicycle leaning on a brick wall at golden hour, shallow depth of field";
  gateway.cost = 0.0215;
  texts.length = 0;
  await env.DB.exec("DELETE FROM gateway_features");
  resetFeatureMemoForTests();
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

const PROMPT = "a red bicycle";

describe("Enhance prompt (D-020)", () => {
  it("quotes and holds the rewrite's most with the render; settles on usage.cost; stores the enhanced prompt", async () => {
    const { user, ws } = await member("pe");
    const off = await quote(user, image(PROMPT, { promptExpand: false }));
    const q = await quote(user, image(PROMPT));
    expect(q.items[0]).toMatchObject({ action: "run", model: MODEL, promptExpand: true });
    expect(off.items[0].promptExpand).toBeUndefined();
    const flash = catalog.get(MODEL)!;
    const maxUsd = promptExpansionMaxUsd(chat, WRITER, { promptChars: PROMPT.length });
    const stored = await env.DB.prepare("SELECT items FROM quotes WHERE id = ?").bind(q.quoteId).first<{ items: string }>();
    const item = JSON.parse(stored!.items)[0];
    expect(item.priceRequest.promptExpandUsd).toBe(maxUsd);
    expect(item.spec.promptExpand).toEqual({ writer: WRITER, maxUsd, locale: "en" });
    expect(q.items[0].credits).toBe(creditsFor(flash, item.priceRequest));
    expect(q.items[0].credits).toBe(creditsForUsd(0.018 + maxUsd));
    expect(off.items[0].credits).toBe(creditsForUsd(0.018));

    const before = await env.CREDITS.get(env.CREDITS.idFromName(ws)).balance();
    const { run, job, runId } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    // The hold was the quoted price with the expansion; the settle is the gateway's cost, which includes it.
    expect(job.cost_quote).toBe(q.items[0].credits);
    expect(job.cost_actual).toBe(creditsForUsd(gateway.cost));
    const after = await env.CREDITS.get(env.CREDITS.idFromName(ws)).balance();
    expect(before.plan + before.purchased - (after.plan + after.purchased)).toBe(creditsForUsd(gateway.cost));
    expect(after.held).toBe(0);

    const body = gateway.creates[0]!.body;
    expect(body).toMatchObject({ model: MODEL, prompt: PROMPT, prompt_expand: true, prompt_expand_model: WRITER, locale: "en" });
    expect(body).not.toHaveProperty("prompt_extend");

    expect(job.expanded_prompt).toBe(gateway.expanded);
    const asset = await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(job.asset_id).first<{ meta: string }>();
    expect(JSON.parse(asset!.meta).expandedPrompt).toBe(gateway.expanded);
    const view = (await (await api(user, `/api/runs/${runId}`)).json()) as any;
    expect(JSON.stringify(view)).toContain(gateway.expanded!);
    // The rewrite went through the text checks too.
    expect(texts.some((t) => t.includes("golden hour"))).toBe(true);
  });

  it("follows the preference when the run does not say; per-run on overrides it", async () => {
    const { user } = await member("pp", { enhance: false });
    expect((await quote(user, image(PROMPT))).items[0].promptExpand).toBeUndefined();
    expect((await quote(user, image(PROMPT, { promptExpand: true }))).items[0].promptExpand).toBe(true);
    const me = (await (await api(user, "/api/me")).json()) as any;
    expect(me.prefs.enhancePrompt).toBe(false);
  });

  it("403 feature_not_enabled: resubmits without expansion under the same hold, flags the environment, later quotes skip it", async () => {
    gateway.featureOff = true;
    const { user } = await member("pf");
    const q = await quote(user, image(PROMPT));
    const { run, job } = await runAndWait(user, q.quoteId);
    expect(run.status).toBe("succeeded");
    expect(gateway.creates).toHaveLength(2);
    expect(gateway.creates[0]!.body.prompt_expand).toBe(true);
    expect(gateway.creates[1]!.body).not.toHaveProperty("prompt_expand");
    expect(gateway.creates[1]!.body).not.toHaveProperty("prompt_expand_model");
    expect(gateway.creates[1]!.key).toBe(`${gateway.creates[0]!.key}.nx`);
    expect(job.cost_quote).toBe(q.items[0].credits);
    expect(job.cost_actual).toBe(creditsForUsd(gateway.cost));
    expect(job.expanded_prompt).toBeNull();
    const flag = await env.DB.prepare("SELECT enabled FROM gateway_features WHERE feature = 'prompt_expand'").first<{ enabled: number }>();
    expect(flag?.enabled).toBe(0);

    const next = await quote(user, image(PROMPT, { promptExpand: true }));
    expect(next.items[0].promptExpand).toBeUndefined();
    const models = (await (await api(user, "/api/models?kind=image")).json()) as { models: any[] };
    expect(models.models.find((m) => m.id === MODEL)?.promptExpand).toBe("unavailable");
  });

  it("the model sync clears an off flag after a day so a run tries again", async () => {
    await env.DB.prepare("INSERT INTO gateway_features (feature, enabled, reason, checked_at) VALUES ('prompt_expand', 0, 'test', ?)").bind(Date.now() - 2 * DAY).run();
    await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
    expect(await env.DB.prepare("SELECT * FROM gateway_features").first()).toBeNull();
    const { user } = await member("pr");
    const models = (await (await api(user, "/api/models?kind=image")).json()) as { models: any[] };
    expect(models.models.find((m) => m.id === MODEL)?.promptExpand).toBe("available");
  });

  it("a hard limit in expanded_prompt blocks the run and releases the hold, even for a mature-allowed caller", async () => {
    for (const mature of [false, true]) {
      gateway.creates = [];
      gateway.expanded = "a man having sex with a dog";
      const { user, ws } = await member(mature ? "phm" : "ph", { mature });
      const before = await env.CREDITS.get(env.CREDITS.idFromName(ws)).balance();
      const q = await quote(user, image(PROMPT));
      expect(q.items[0].promptExpand).toBe(true);
      const { run, job } = await runAndWait(user, q.quoteId);
      expect(run.status).toBe("failed");
      expect(job.error_code).toBe("safety_blocked");
      expect(job.asset_id).toBeNull();
      const after = await env.CREDITS.get(env.CREDITS.idFromName(ws)).balance();
      expect(after.plan + after.purchased).toBe(before.plan + before.purchased);
      const ev = await env.DB.prepare("SELECT codes FROM safety_events WHERE workspace_id = ?").bind(ws).all<{ codes: string }>();
      expect(ev.results.map((e) => JSON.parse(e.codes))).toEqual([["ANIMAL_SEXUAL"]]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE workspace_id = ?").bind(ws).first<{ n: number }>()).toMatchObject({ n: 0 });
    }
  });
});
