/**
 * Agent (M6) in the workers pool: AgentSession turns with a scripted LLM,
 * proposals, apply as the user through ProjectRoom, discard, stale, cancel
 * and NO_PLAN. The agent allowance (D-012) is in agent-allowance.test.ts.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { ScriptedLlm, type ScriptedReply } from "@rolling/agent/testkit";
import { planCutTo, edlDuration, type Edl } from "@rolling/core/timeline";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { setAgentLlmForTests } from "../src/do/AgentSession";
import { syncModels } from "../src/models/sync";

const BASE = "https://example.com";
const DAY = 86_400_000;

let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function body<T = any>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function member(tag: string, plan: "starter" | "plus" | "pro" = "plus"): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, plan, now + 30 * DAY, now)
    .run();
  return { user, ws };
}

function useLlm(steps: ScriptedReply[]): ScriptedLlm {
  const llm = new ScriptedLlm(steps);
  setAgentLlmForTests(llm);
  return llm;
}

async function thread(user: string, json: Record<string, unknown>): Promise<string> {
  return (await body<{ thread: { id: string } }>(await api(user, "/api/agent/threads", { json }), 201)).thread.id;
}

async function openSocket(path: string, user: string) {
  const res = await api(user, path, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const events: { type: string; payload: any }[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
  ws.accept();
  return { ws, events };
}

const PLAN = {
  seconds: 15,
  options: [
    { title: "Riverside", ratio: "9:16", shots: [{ title: "Hook", seconds: 5, visual: "Cap pops, bubbles", model: "bytedance/seedance-2.5" }, { title: "Sip", seconds: 5, visual: "First sip", model: "bytedance/seedance-2.5" }, { title: "Logo", seconds: 5, visual: "Bottle and logo", model: "bytedance/seedance-2.5" }] },
    { title: "Kitchen", ratio: "9:16", shots: [{ title: "Fridge", seconds: 7, visual: "Fridge opens", model: "bytedance/seedance-2.0-mini" }, { title: "Pour", seconds: 8, visual: "Pour over ice", model: "bytedance/seedance-2.0-mini" }] },
  ],
};

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => new Response(JSON.stringify(listing), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
});

afterAll(() => setAgentLlmForTests(null));

describe("agent access", () => {
  it("non-members get NO_PLAN (D-007)", async () => {
    const user = newUser("noplan");
    const res = await api(user, "/api/agent/threads", { json: { surface: "home", skill: "tv-ad" } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.code).toBe("NO_PLAN");
  });

  it("rejects unknown agent LLMs and other workspaces' threads", async () => {
    const a = await member("owner");
    const b = await member("other");
    const id = await thread(a.user, { surface: "home" });
    expect((await api(a.user, `/api/agent/threads/${id}/messages`, { json: { text: "x", llm: "gpt-9" } })).status).toBe(400);
    expect((await api(b.user, `/api/agent/threads/${id}`)).status).toBe(404);
  });
});

describe("home plan → Build on canvas", () => {
  it("streams the turn, stores a plan and builds a project with no spend", async () => {
    const { user, ws } = await member("home");
    const id = await thread(user, { surface: "home", skill: "tv-ad" });
    const sock = await openSocket(`/api/agent/threads/${id}/ws`, user);
    const llm = useLlm([
      { toolCalls: [{ name: "models.capabilities", args: { kind: "video" } }] },
      { text: "Two options. Building is free; running costs the estimate.", toolCalls: [{ name: "propose.plan", args: PLAN }] },
    ]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "15-second vertical ad for a sparkling water" } }), 200);
    expect(turn.reason).toBe("proposal");
    expect(turn.llm).toBe("deepseek-v4.1-flash");
    expect(llm.requests[0]!.model).toMatch(/^deepseek\/deepseek-v4\.1-flash/);
    const proposal = turn.proposal;
    expect(proposal.kind).toBe("plan");
    expect(proposal.body.options).toHaveLength(2);
    expect(proposal.body.options[0].estimate.credits).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 50));
    const types = sock.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["hello", "agent.tool", "agent.delta", "proposal.created", "agent.done"]));
    sock.ws.close();

    const view = await body(await api(user, `/api/agent/threads/${id}`), 200);
    expect(view.thread.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(view.thread.messages[1].proposalId).toBe(proposal.id);

    const applied = await body(await api(user, `/api/agent/proposals/${proposal.id}/apply`, { json: { optionIndex: 0 } }), 200);
    expect(applied.projectId).toMatch(/^prj_/);
    expect(applied.revision).toBe(1);
    const project = await body(await api(user, `/api/projects/${applied.projectId}`), 200);
    const kinds = project.snapshot.nodes.map((n: any) => n.kind).sort();
    expect(kinds).toEqual(["image", "image", "image", "script", "video", "video", "video"]);
    expect(project.snapshot.edges).toHaveLength(6);
    // No spend: no runs, no ledger lines.
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM runs WHERE workspace_id = ?").bind(ws).first<{ c: number }>())!.c).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM ledger_lines WHERE workspace_id = ?").bind(ws).first<{ c: number }>())!.c).toBe(0);
    // The thread follows the new project; applying twice is refused.
    const after = await body(await api(user, `/api/agent/threads/${id}`), 200);
    expect(after.thread).toMatchObject({ projectId: applied.projectId, surface: "canvas" });
    expect(after.thread.proposals[0].status).toBe("applied");
    expect((await api(user, `/api/agent/proposals/${proposal.id}/apply`, { json: {} })).status).toBe(409);
  });
});

async function projectWithShots(user: string): Promise<{ projectId: string; ids: Record<string, string>; revision: number }> {
  const created = await body(await api(user, "/api/projects", { json: { title: "Agent canvas" } }), 201);
  const projectId = created.project.id as string;
  const patch = await body(
    await api(user, `/api/projects/${projectId}/patch`, {
      json: {
        baseRevision: 0,
        ops: [1, 2, 3].map((n) => ({ op: "addNode", tempId: `s${n}`, kind: "video", title: `Shot ${n}`, params: { prompt: `Shot ${n}`, model: "bytedance/seedance-2.5", mode: "t2v", seconds: 5, resolution: "720p", ratio: "9:16" } })),
      },
    }),
    200,
  );
  return { projectId, ids: patch.idMap, revision: patch.revision };
}

describe("canvas graph patch", () => {
  it("applies exactly the proposed ops as the user; discard and stale work", async () => {
    const { user } = await member("canvas");
    const { projectId, ids, revision } = await projectWithShots(user);
    const id = await thread(user, { surface: "canvas", projectId, skill: "tv-ad" });
    const ops = [{ op: "updateNode", nodeId: ids.s2, params: { prompt: "Shot 2, warm golden light" } }];
    useLlm([
      { toolCalls: [{ name: "canvas.get", args: { projectId } }] },
      { text: "Warmer light on shot 2; running it again costs credits.", toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision, ops, summary: "Warmer shot 2" } }] },
    ]);
    const room = await openSocket(`/api/projects/${projectId}/ws`, user);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "make shot 2 warmer", selection: [ids.s2] } }), 200);
    expect(turn.proposal.kind).toBe("graphPatch");
    expect(turn.proposal.body.ops).toEqual(ops);
    expect(turn.proposal.estimate.items[0]).toMatchObject({ model: "bytedance/seedance-2.5", seconds: 5, resolution: "720p" });

    const applied = await body(await api(user, `/api/agent/proposals/${turn.proposal.id}/apply`, { json: {} }), 200);
    expect(applied.revision).toBe(revision + 1);
    await new Promise((r) => setTimeout(r, 50));
    const patched = room.events.find((e) => e.type === "graph.patched");
    expect(patched?.payload.ops).toEqual(ops);
    expect(room.events.some((e) => e.type === "proposal.created")).toBe(true);
    room.ws.close();

    // A second proposal goes stale when the user removes its node first.
    useLlm([{ toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision + 1, ops: [{ op: "updateNode", nodeId: ids.s3, params: { seconds: 8 } }], summary: "Longer shot 3" } }] }]);
    const t2 = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "make shot 3 longer" } }), 200);
    await body(await api(user, `/api/projects/${projectId}/patch`, { json: { baseRevision: revision + 1, ops: [{ op: "removeNode", nodeId: ids.s3 }] } }), 200);
    const stale = await body(await api(user, `/api/agent/proposals/${t2.proposal.id}/apply`, { json: {} }), 409);
    expect(stale.error.data.status).toBe("stale");

    // Discard.
    useLlm([{ toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision + 2, ops: [{ op: "updateNode", nodeId: ids.s1, params: { seconds: 6 } }], summary: "x" } }] }]);
    const t3 = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "shot 1 to 6 seconds" } }), 200);
    await body(await api(user, `/api/agent/proposals/${t3.proposal.id}/discard`, { method: "POST" }), 200);
    expect((await api(user, `/api/agent/proposals/${t3.proposal.id}/apply`, { json: {} })).status).toBe(409);
  });
});

describe("eager rebase (ProjectRoom → AgentSession.onRevision)", () => {
  it("rebases pending proposals after commits and marks them stale without waiting for apply", async () => {
    const { user } = await member("rebase");
    const { projectId, ids, revision } = await projectWithShots(user);
    const id = await thread(user, { surface: "canvas", projectId });
    useLlm([{ toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision, ops: [{ op: "updateNode", nodeId: ids.s3, params: { seconds: 8 } }], summary: "Longer shot 3" } }] }]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "make shot 3 longer" } }), 200);
    const room = env.PROJECT.get(env.PROJECT.idFromName(projectId));
    const registered = () => runInDurableObject(room, (_i, state) => state.storage.sql.exec("SELECT thread_id FROM agent_threads").toArray().map((r) => r.thread_id));
    expect(await registered()).toEqual([id]);
    const proposal = async () => (await body(await api(user, `/api/agent/threads/${id}`), 200)).thread.proposals.find((p: any) => p.id === turn.proposal.id);

    // An unrelated edit: the proposal follows the new revision.
    await body(await api(user, `/api/projects/${projectId}/patch`, { json: { baseRevision: revision, ops: [{ op: "updateNode", nodeId: ids.s1, params: { seconds: 6 } }] } }), 200);
    await projectRoom(env, projectId).notifyThreads();
    expect(await proposal()).toMatchObject({ status: "proposed", baseRevision: revision + 1 });
    expect(await registered()).toEqual([id]);

    // Its node is removed: stale right away (coalesced timer), and the room drops the thread.
    await body(await api(user, `/api/projects/${projectId}/patch`, { json: { baseRevision: revision + 1, ops: [{ op: "removeNode", nodeId: ids.s3 }] } }), 200);
    await new Promise((r) => setTimeout(r, 700));
    expect((await proposal()).status).toBe("stale");
    expect(await registered()).toEqual([]);
  });
});

describe("editor timeline patch", () => {
  it("proposes and applies cut to 10s", async () => {
    const { user } = await member("editor");
    const { projectId } = await projectWithShots(user);
    const canvasId = `cnv_${projectId.slice(4)}`;
    const tl = await body(await api(user, `/api/canvases/${canvasId}/timeline`), 200);
    const timeline = (tl.timeline ?? tl) as { revision: number; edl: Edl };
    expect(edlDuration(timeline.edl)).toBe(15);
    const id = await thread(user, { surface: "editor", projectId });
    const ops = planCutTo(timeline.edl, 10)!.ops;
    useLlm([
      { toolCalls: [{ name: "timeline.get", args: { canvasId } }] },
      { text: "Trims the last shot. Free.", toolCalls: [{ name: "propose.timelinePatch", args: { canvasId, baseRevision: timeline.revision, ops, summary: "Cut to 10 s" } }] },
    ]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "cut to 10s" } }), 200);
    expect(turn.proposal.body).toMatchObject({ kind: "timelinePatch", durationBefore: 15, durationAfter: 10 });
    expect(turn.proposal.estimate.credits).toBe(0);
    const applied = await body(await api(user, `/api/agent/proposals/${turn.proposal.id}/apply`, { json: {} }), 200);
    expect(applied.revision).toBe(timeline.revision + 1);
    const after = await body(await api(user, `/api/canvases/${canvasId}/timeline`), 200);
    expect(edlDuration((after.timeline ?? after).edl)).toBe(10);
  });
});

describe("cancel", () => {
  it("stops a running turn: partial text stays, no proposal", async () => {
    const { user } = await member("cancel");
    const id = await thread(user, { surface: "home", skill: "tv-ad" });
    useLlm([{ text: "Partial", delayMs: 3_000, toolCalls: [{ name: "propose.plan", args: PLAN }] }]);
    const pending = api(user, `/api/agent/threads/${id}/messages`, { json: { text: "15 second ad" } });
    await new Promise((r) => setTimeout(r, 100));
    // A second message while running is refused.
    expect((await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "again" } })).status).toBe(409);
    const c = await body(await api(user, `/api/agent/threads/${id}/cancel`, { json: {} }), 200);
    expect(c.canceled).toBe(true);
    const turn = await body(await pending, 200);
    expect(turn).toMatchObject({ reason: "canceled", proposal: null, text: "Partial" });
  });
});
