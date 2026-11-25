/**
 * Agent allowance (D-012) in the workers pool: each turn holds its estimate in
 * the CreditAccount DO, settles its actual LLM cost (usage.cost, else tokens ×
 * price), mirrors it to D1 and pushes `agent.allowance`; exhaustion is a 429
 * with the reset date; stale holds are released by the alarm. DeepSeek public
 * LLMs are unmetered (D-012 amendment): cost recorded, no hold, per-user abuse
 * limit of 300 turns per rolling hour.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { ScriptedLlm, type ScriptedReply } from "@rolling/agent/testkit";
import { addMonths, AGENT_HOLD_TTL_MS } from "@rolling/core/credits";
import { AGENT_ALLOWANCE_USD, agentAllowancePeriod } from "@rolling/core";
import { personalWorkspaceId } from "../src/auth/workspace";
import { setAgentLlmForTests } from "../src/do/AgentSession";
import { syncModels } from "../src/models/sync";

const BASE = "https://example.com";
const DAY = 86_400_000;
let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function body<T = any>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function member(tag: string, plan: "starter" | "plus" | "pro" = "starter", periodStart: number | null = null) {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, current_period_start) VALUES (?, ?, ?, 'month', 'active', ?, 0, ?, ?)")
    .bind(`sub_${user}`, ws, plan, now + 30 * DAY, now, periodStart)
    .run();
  const id = (await body(await api(user, "/api/agent/threads", { json: { surface: "home" } }), 201)).thread.id as string;
  return { user, ws, thread: id };
}

const credits = (ws: string) => env.CREDITS.get(env.CREDITS.idFromName(ws));
const send = (m: { user: string; thread: string }, json: Record<string, unknown>) => api(m.user, `/api/agent/threads/${m.thread}/messages`, { json });
const useLlm = (steps: ScriptedReply[]) => {
  const llm = new ScriptedLlm(steps);
  setAgentLlmForTests(llm);
  return llm;
};

/** Spends `usd` of the period through the ledger, as a finished turn would. */
async function spend(ws: string, usd: number, periodStart: number, resetsAt: number) {
  const stub = credits(ws);
  const turnId = `evt_pre${++seq}`;
  const h = await stub.agentHold({ turnId, userId: "u", llm: "test-preload", estimateUsd: 0.001, allowanceUsd: 100, periodStart, resetsAt, idemKey: `${turnId}:h` });
  expect(h.ok).toBe(true);
  expect((await stub.agentSettle({ turnId, actualUsd: usd, idemKey: `${turnId}:s` })).ok).toBe(true);
}

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => new Response(JSON.stringify(listing), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
});

afterAll(() => setAgentLlmForTests(null));

describe("GET /api/agent/allowance", () => {
  it("returns the plan allowance, reset date and turns left per public LLM", async () => {
    const m = await member("view", "plus");
    const view = await body(await api(m.user, "/api/agent/allowance"), 200);
    const period = agentAllowancePeriod(Date.now(), null);
    expect(view).toMatchObject({ plan: "plus", allowanceUsd: AGENT_ALLOWANCE_USD.plus, usedUsd: 0, resetsAt: period.resetsAt });
    const byId = Object.fromEntries(view.models.map((x: any) => [x.id, x]));
    expect(view.models.every((x: any) => !x.id.includes("/"))).toBe(true);
    expect(byId["deepseek-v4.1-flash"]).toEqual({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", unlimited: true });
    expect(byId["deepseek-v4.1-flash-1017"]).toMatchObject({ unlimited: true });
    expect(byId["claude-haiku-5.5"]).toMatchObject({ unlimited: false });
    expect(byId["claude-opus-5.5"]).toMatchObject({ estTurnUsd: 0.064, turnsLeft: 54 });
    expect(byId["gpt-6-astra"]).toMatchObject({ estTurnUsd: 0.16, turnsLeft: 21 });
  });

  it("is members only", async () => {
    const res = await api(newUser("noplan"), "/api/agent/allowance");
    expect(res.status).toBe(402);
  });
});

describe("turn cost", () => {
  it("settles usage.cost of every call, mirrors it to D1 and pushes agent.allowance", async () => {
    const m = await member("cost");
    const res = await api(m.user, "/api/ws", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const sock = res.webSocket!;
    const events: any[] = [];
    sock.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    sock.accept();

    useLlm([
      { toolCalls: [{ name: "models.capabilities", args: { kind: "video" } }], usage: { promptTokens: 9000, completionTokens: 40, costUsd: 0.0012 } },
      { text: "Here you go.", usage: { promptTokens: 9500, completionTokens: 300, costUsd: 0.0021 } },
    ]);
    const turn = await body(await send(m, { text: "ideas for a coffee ad", llm: "claude-haiku-5.5" }), 200);
    const row = await env.DB.prepare("SELECT * FROM agent_usage WHERE turn_id = ?").bind(turn.turnId).first<any>();
    expect(row).toMatchObject({ workspace_id: m.ws, llm: "claude-haiku-5.5", status: "settled", tokens_in: 18500, tokens_out: 340 });
    expect(row.cost_usd).toBeCloseTo(0.0033, 9);
    const view = await body(await api(m.user, "/api/agent/allowance"), 200);
    expect(view.usedUsd).toBeCloseTo(0.0033, 9);

    await new Promise((r) => setTimeout(r, 50));
    const pushed = events.find((e) => e.type === "agent.allowance");
    expect(pushed?.payload).toMatchObject({ plan: "starter", allowanceUsd: 1.2, resetsAt: view.resetsAt });
    expect(pushed.payload.usedUsd).toBeCloseTo(0.0033, 9);
    sock.close();

    // The next Haiku turn is estimated from this workspace's history.
    const haiku = view.models.find((x: any) => x.id === "claude-haiku-5.5");
    expect(haiku.estTurnUsd).toBeCloseTo(0.0033, 9);
  });

  it("falls back to tokens × the gateway model price when cost is missing", async () => {
    const m = await member("fallback");
    useLlm([{ text: "Sure.", usage: { promptTokens: 10_000, completionTokens: 1_000 } }]);
    const turn = await body(await send(m, { text: "hello", llm: "claude-opus-5.5" }), 200);
    const row = await env.DB.prepare("SELECT cost_usd, llm FROM agent_usage WHERE turn_id = ?").bind(turn.turnId).first<any>();
    // Opus: $4/M prompt, $20/M completion.
    expect(row.llm).toBe("claude-opus-5.5");
    expect(row.cost_usd).toBeCloseTo(0.04 + 0.02, 9);
  });

  it("releases the hold of a turn that cost nothing (cancel or failure before a response)", async () => {
    const m = await member("release");
    useLlm([{ throws: { code: "bad", message: "no", retryable: false } }]);
    const turn = await body(await send(m, { text: "hello", llm: "claude-haiku-5.5" }), 200);
    expect(turn.reason).toBe("error");
    const row = await env.DB.prepare("SELECT status, cost_usd FROM agent_usage WHERE turn_id = ?").bind(turn.turnId).first<any>();
    expect(row).toEqual({ status: "released", cost_usd: 0 });
    expect((await body(await api(m.user, "/api/agent/allowance"), 200)).usedUsd).toBe(0);
  });
});

describe("exhaustion", () => {
  it("returns 429 AGENT_ALLOWANCE_EXHAUSTED with the reset date when the estimate does not fit", async () => {
    const m = await member("exhaust");
    const period = agentAllowancePeriod(Date.now(), null);
    await spend(m.ws, 1.17, period.start, period.resetsAt);
    const llm = useLlm([{ text: "never" }]);
    const err = await body(await send(m, { text: "hello", llm: "claude-opus-5.5" }), 429);
    expect(err.error).toMatchObject({ code: "AGENT_ALLOWANCE_EXHAUSTED", data: { allowanceUsd: 1.2, usedUsd: 1.17, resetsAt: period.resetsAt, model: "claude-opus-5.5" } });
    expect(llm.requests).toHaveLength(0);
    // Haiku still fits; DeepSeek never draws on the allowance.
    useLlm([{ text: "ok", usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.0001 } }]);
    await body(await send(m, { text: "hello", llm: "claude-haiku-5.5" }), 200);
    const view = await body(await api(m.user, "/api/agent/allowance"), 200);
    expect(view.models.find((x: any) => x.id === "claude-opus-5.5").turnsLeft).toBe(0);
    expect(view.models.find((x: any) => x.id === "claude-haiku-5.5").turnsLeft).toBeGreaterThan(0);
    expect(view.models.find((x: any) => x.id === "deepseek-v4.1-flash")).toMatchObject({ unlimited: true });
  });

  it("resets on the subscription's billing period start", async () => {
    const anchor = Date.now() - 40 * DAY;
    const m = await member("reset", "starter", anchor);
    const now = Date.now();
    const current = agentAllowancePeriod(now, anchor);
    expect(current.start).toBe(addMonths(anchor, 1));
    // Last period was fully used; this one is untouched.
    await spend(m.ws, 1.2, anchor, current.start);
    const view = await body(await api(m.user, "/api/agent/allowance"), 200);
    expect(view).toMatchObject({ usedUsd: 0, resetsAt: current.resetsAt });
    await spend(m.ws, 1.2, current.start, current.resetsAt);
    useLlm([{ text: "never" }]);
    const err = await body(await send(m, { text: "hello", llm: "claude-haiku-5.5" }), 429);
    expect(err.error.data.resetsAt).toBe(current.resetsAt);
  });
});

describe("unmetered DeepSeek (D-012 amendment)", () => {
  it("records the cost without a hold and keeps working when the allowance is used up", async () => {
    const m = await member("unmetered");
    const period = agentAllowancePeriod(Date.now(), null);
    await spend(m.ws, 1.2, period.start, period.resetsAt);
    useLlm([{ text: "ok", usage: { promptTokens: 9000, completionTokens: 200, costUsd: 0.0011 } }]);
    const turn = await body(await send(m, { text: "hello" }), 200);
    const row = await env.DB.prepare("SELECT llm, status, cost_usd FROM agent_usage WHERE turn_id = ?").bind(turn.turnId).first<any>();
    expect(row).toMatchObject({ llm: "deepseek-v4.1-flash", status: "unmetered" });
    expect(row.cost_usd).toBeCloseTo(0.0011, 9);
    const held = await runInDurableObject(credits(m.ws), (_i, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM agent_holds WHERE turn_id = ?", turn.turnId).one().n);
    expect(held).toBe(0);
    const view = await body(await api(m.user, "/api/agent/allowance"), 200);
    expect(view.usedUsd).toBeCloseTo(1.2, 9);
  });

  it("returns 429 RATE_LIMITED with retryAfter past 300 turns in a rolling hour", async () => {
    const m = await member("abuse");
    const hub = env.USER_HUB.get(env.USER_HUB.idFromName(m.user));
    const now = Date.now();
    await runInDurableObject(hub, (_i, state) => state.storage.put("agent_turns", Array.from({ length: 300 }, (_, i) => now - 30 * 60_000 + i)));
    const llm = useLlm([{ text: "never" }]);
    const err = await body(await send(m, { text: "hello" }), 429);
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.error.data.retryAfter).toBeGreaterThan(29 * 60);
    expect(err.error.data.retryAfter).toBeLessThanOrEqual(30 * 60 + 1);
    expect(llm.requests).toHaveLength(0);
    // Metered models are not affected by the abuse limit.
    useLlm([{ text: "ok", usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.0001 } }]);
    await body(await send(m, { text: "hello", llm: "claude-haiku-5.5" }), 200);
  });
});

describe("CreditAccount agent holds", () => {
  it("auto-releases holds older than 10 minutes on the alarm", async () => {
    const ws = `ws_alarm${++seq}`;
    const stub = credits(ws);
    const period = agentAllowancePeriod(Date.now(), null);
    const h = await stub.agentHold({ turnId: "evt_crash", userId: "u", llm: "claude-opus-5.5", estimateUsd: 1.0, allowanceUsd: 1.2, periodStart: period.start, resetsAt: period.resetsAt, idemKey: "crash:h" });
    expect(h, JSON.stringify(h)).toMatchObject({ ok: true });
    const blocked = await stub.agentHold({ turnId: "evt_next", userId: "u", llm: "claude-opus-5.5", estimateUsd: 0.5, allowanceUsd: 1.2, periodStart: period.start, resetsAt: period.resetsAt, idemKey: "next:h" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "AGENT_ALLOWANCE_EXHAUSTED" } });
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE agent_holds SET created_at = created_at - ? WHERE turn_id = 'evt_crash'", AGENT_HOLD_TTL_MS);
    });
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now()));
    await new Promise((r) => setTimeout(r, 50));
    // The alarm may already have fired on its own; run it now if it has not.
    await runDurableObjectAlarm(stub);
    const usage = await stub.agentUsage({ allowanceUsd: 1.2, periodStart: period.start, resetsAt: period.resetsAt });
    expect(usage).toMatchObject({ usedUsd: 0, heldUsd: 0 });
    const again = await stub.agentHold({ turnId: "evt_next", userId: "u", llm: "claude-opus-5.5", estimateUsd: 0.5, allowanceUsd: 1.2, periodStart: period.start, resetsAt: period.resetsAt, idemKey: "next:h2" });
    expect(again.ok).toBe(true);
  });
});
