/**
 * Agent modes (D-021) in the workers pool: Auto applies a patch as an attributed
 * revision and Undo reverts it; `run.start` keeps to the turn budget across calls
 * (quote → hold through CreditAccount, over-budget runs surfaced, not started); Read
 * refuses a propose call server-side.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { ScriptedLlm, type ScriptedReply } from "@rolling/agent/testkit";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { setAgentLlmForTests } from "../src/do/AgentSession";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";

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

const credits = (ws: string) => env.CREDITS.get(env.CREDITS.idFromName(ws));

async function member(tag: string, topUp = 0): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, now + 30 * DAY, now)
    .run();
  const stub = credits(ws);
  expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
  if (topUp > 0) expect((await stub.purchase(topUp, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  return { user, ws };
}

async function projectWithShots(user: string, n = 3): Promise<{ projectId: string; ids: Record<string, string>; revision: number }> {
  const created = await body(await api(user, "/api/projects", { json: { title: "Modes canvas" } }), 201);
  const projectId = created.project.id as string;
  const patch = await body(
    await api(user, `/api/projects/${projectId}/patch`, {
      json: {
        baseRevision: 0,
        ops: Array.from({ length: n }, (_, i) => ({ op: "addNode", tempId: `s${i + 1}`, kind: "video", title: `Shot ${i + 1}`, params: { prompt: `Shot ${i + 1}, a bottle on a rock`, model: "bytedance/seedance-2.5", mode: "t2v", seconds: 5, resolution: "720p", ratio: "9:16" } })),
      },
    }),
    200,
  );
  return { projectId, ids: patch.idMap, revision: patch.revision };
}

async function thread(user: string, projectId: string): Promise<string> {
  return (await body<{ thread: { id: string } }>(await api(user, "/api/agent/threads", { json: { surface: "canvas", projectId } }), 201)).thread.id;
}

const useLlm = (steps: ScriptedReply[]) => setAgentLlmForTests(new ScriptedLlm(steps));

/** Gateway stand-in: every video create is refused (the job fails and is refunded); nothing renders. */
const refuseAll = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  return new Response(JSON.stringify({ error: { message: `test: ${new URL(req.url).pathname}`, type: "invalid_request_error", code: "invalid_request" } }), { status: 400, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => new Response(JSON.stringify(listing), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
});

afterAll(() => {
  setAgentLlmForTests(null);
  setGatewayFetchForTests(null);
});

describe("Auto mode: patches", () => {
  it("applies the patch as an attributed revision and Undo reverts it", async () => {
    const { user } = await member("autopatch");
    const { projectId, ids, revision } = await projectWithShots(user);
    const id = await thread(user, projectId);
    const ops = [{ op: "updateNode", nodeId: ids.s2, params: { prompt: "Shot 2, a bottle on a rock, warm golden light" } }];
    useLlm([{ toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision, ops, summary: "Warmer shot 2" } }] }, { text: "Shot 2 has warmer light now." }]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "make shot 2 warmer", mode: "auto", autoBudget: 0 } }), 200);
    expect(turn.mode).toBe("auto");
    expect(turn.auto.changes).toHaveLength(1);
    const change = turn.auto.changes[0];
    expect(change).toMatchObject({ kind: "graphPatch", revision: revision + 1, status: "applied", summary: "Warmer shot 2" });
    expect(turn.proposal.status).toBe("applied");

    const room = projectRoom(env, projectId);
    const caller = { userId: user, workspaceId: personalWorkspaceId(user), canEdit: true };
    const after = (await room.getGraph(caller)) as any;
    expect(after.state.revision).toBe(revision + 1);
    expect(after.state.nodes.find((n: any) => n.id === ids.s2).params.prompt).toContain("warm golden light");
    // The revision is the agent's, with the turn that made it.
    const log = await runInRoom(projectId, revision + 1);
    expect(log).toMatchObject({ origin: "agent" });
    expect(log.source).toBe(`agent:${id}:${turn.turnId}`);

    // The thread lists the turn's change; Undo reverts it.
    const view = await body(await api(user, `/api/agent/threads/${id}`), 200);
    expect(view.thread.mode).toBe("auto");
    expect(view.thread.auto.at(-1).changes[0].id).toBe(change.id);
    const undone = await body(await api(user, `/api/agent/threads/${id}/auto/undo`, { json: { changeId: change.id } }), 200);
    expect(undone.undone).toEqual([change.id]);
    expect(undone.auto.changes[0].status).toBe("undone");
    const reverted = (await room.getGraph(caller)) as any;
    expect(reverted.state.revision).toBe(revision + 2);
    expect(reverted.state.nodes.find((n: any) => n.id === ids.s2).params.prompt).toBe("Shot 2, a bottle on a rock");
    // A second undo of the same change does nothing.
    expect((await body(await api(user, `/api/agent/threads/${id}/auto/undo`, { json: { changeId: change.id } }), 200)).undone).toEqual([]);
  });

  it("refuses to undo a change the user edited since", async () => {
    const { user } = await member("autoedit");
    const { projectId, ids, revision } = await projectWithShots(user, 1);
    const id = await thread(user, projectId);
    useLlm([{ toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision, ops: [{ op: "updateNode", nodeId: ids.s1, params: { seconds: 8 } }], summary: "Longer shot 1" } }] }, { text: "Shot 1 is 8 seconds." }]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "make shot 1 longer", mode: "auto" } }), 200);
    await body(await api(user, `/api/projects/${projectId}/patch`, { json: { baseRevision: revision + 1, ops: [{ op: "updateNode", nodeId: ids.s1, params: { seconds: 6 } }] } }), 200);
    const res = await body(await api(user, `/api/agent/threads/${id}/auto/undo`, { json: { turnId: turn.turnId } }), 200);
    expect(res.undone).toEqual([]);
    expect(res.failed[0].code).toBe("CONFLICT");
  });
});

/** Reads one patch_log row through the room's storage (attribution check). */
async function runInRoom(projectId: string, revision: number): Promise<{ origin: string; source: string | null }> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = env.PROJECT.get(env.PROJECT.idFromName(projectId));
  return runInDurableObject(stub, async (_obj, state) => state.storage.sql.exec<{ origin: string; source: string | null }>("SELECT origin, source FROM patch_log WHERE revision = ?", revision).one());
}

describe("Auto mode: run.start budget", () => {
  it("starts runs within the budget across calls and surfaces the one over it", async () => {
    setGatewayFetchForTests(refuseAll);
    const introspector = await introspectWorkflow(env.GENERATE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    try {
      const { user, ws } = await member("autorun", 5000);
      const { projectId, ids } = await projectWithShots(user);
      const id = await thread(user, projectId);
      // One shot quotes at the same price; the budget fits two of them.
      const q = await body(await api(user, "/api/runs/quote", { json: { projectId, scope: "node", nodeIds: [ids.s1] } }), 200);
      const price = q.total as number;
      expect(price).toBeGreaterThan(0);
      useLlm([
        { toolCalls: [{ name: "run.start", args: { nodeIds: [ids.s1] } }] },
        { toolCalls: [{ name: "run.start", args: { nodeIds: [ids.s2] } }] },
        { toolCalls: [{ name: "run.start", args: { nodeIds: [ids.s3] } }] },
        { text: "Two shots are running; shot 3 waits for your approval." },
      ]);
      const before = await credits(ws).balance();
      const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "run every shot", mode: "auto", autoBudget: price * 2 } }), 200);
      expect(turn.auto.budget).toBe(price * 2);
      expect(turn.auto.runs.map((r: any) => r.status)).toEqual(["started", "started", "needs_approval"]);
      expect(turn.auto.spent).toBe(price * 2);
      expect(turn.auto.runs[2]).toMatchObject({ credits: price, nodeIds: [ids.s3] });
      // Two runs exist, made by the agent; the third was never started.
      const runs = await env.DB.prepare("SELECT id, surface, credits_quoted FROM runs WHERE workspace_id = ? ORDER BY created_at").bind(ws).all<{ id: string; surface: string; credits_quoted: number }>();
      expect(runs.results.map((r) => r.surface)).toEqual(["agent", "agent"]);
      expect(runs.results.map((r) => r.id).sort()).toEqual([turn.auto.runs[0].runId, turn.auto.runs[1].runId].sort());
      expect(runs.results.map((r) => r.credits_quoted)).toEqual([price, price]);
      // Each run took its hold in CreditAccount before its job started (refunded later: the fake gateway refuses the jobs).
      const jobs = await env.DB.prepare("SELECT COUNT(*) AS c FROM jobs WHERE run_id IN (?, ?)").bind(turn.auto.runs[0].runId, turn.auto.runs[1].runId).first<{ c: number }>();
      expect(jobs!.c).toBe(2);
      const after = await credits(ws).balance();
      // Never more than the budget left the balance or is held.
      expect(after.held + (before.plan + before.purchased - after.plan - after.purchased)).toBeLessThanOrEqual(price * 2);
      // The over-budget run is listed on the thread for approval.
      const view = await body(await api(user, `/api/agent/threads/${id}`), 200);
      expect(view.thread.auto.at(-1).runs[2].status).toBe("needs_approval");
    } finally {
      await introspector.dispose();
      setGatewayFetchForTests(null);
    }
  });

  it("Edit has no run.start: a run call is refused and nothing starts", async () => {
    const { user, ws } = await member("editrun", 5000);
    const { projectId, ids } = await projectWithShots(user, 1);
    const id = await thread(user, projectId);
    useLlm([{ toolCalls: [{ name: "run.start", args: { nodeIds: [ids.s1] } }] }, { text: "Run it from the canvas." }]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "run shot 1" } }), 200);
    expect(turn.mode).toBe("edit");
    expect(turn.auto).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM runs WHERE workspace_id = ?").bind(ws).first<{ c: number }>())!.c).toBe(0);
  });
});

describe("Read mode", () => {
  it("refuses a propose call server-side: no proposal, no revision", async () => {
    const { user } = await member("readonly");
    const { projectId, ids, revision } = await projectWithShots(user, 2);
    const id = await thread(user, projectId);
    useLlm([
      { toolCalls: [{ name: "propose.graphPatch", args: { projectId, baseRevision: revision, ops: [{ op: "removeNode", nodeId: ids.s2 }], summary: "Remove shot 2" } }] },
      { text: "Shot 2 could go; switch to Edit to remove it." },
    ]);
    const turn = await body(await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "remove shot 2", mode: "read" } }), 200);
    expect(turn.mode).toBe("read");
    expect(turn.proposal).toBeNull();
    const view = await body(await api(user, `/api/agent/threads/${id}`), 200);
    expect(view.thread.proposals).toEqual([]);
    const project = await body(await api(user, `/api/projects/${projectId}`), 200);
    expect(project.snapshot.revision).toBe(revision);
    expect(project.snapshot.nodes).toHaveLength(2);
  });

  it("rejects an unknown mode", async () => {
    const { user } = await member("badmode");
    const { projectId } = await projectWithShots(user, 1);
    const id = await thread(user, projectId);
    expect((await api(user, `/api/agent/threads/${id}/messages`, { json: { text: "x", mode: "yolo" } })).status).toBe(400);
  });
});
