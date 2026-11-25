import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { projectRoom } from "../src/lib/access";
import { refusedSocket } from "./ws-helpers";

const BASE = "https://example.com";

interface Envelope {
  type: string;
  id: string;
  payload: any;
}

let seq = 0;
function user(tag: string): string {
  seq++;
  return `${tag}${Date.now().toString(36)}${seq}`;
}

function wsOf(userId: string): string {
  return `ws_dev_${userId}`;
}

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function createProject(userId: string, title = "Sparkling water ad"): Promise<string> {
  const res = await api(userId, "/api/projects", { method: "POST", json: { title } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

interface Socket {
  ws: WebSocket;
  next: (type?: string) => Promise<Envelope>;
  send: (type: string, payload: unknown, id?: string) => string;
}

async function connect(projectId: string, userId: string): Promise<Socket> {
  const res = await api(userId, `/api/projects/${projectId}/ws`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const queue: Envelope[] = [];
  const waiters: ((e: Envelope) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Envelope;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  ws.accept();
  const nextAny = () =>
    new Promise<Envelope>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      waiters.push((e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  const next = async (type?: string) => {
    for (;;) {
      const m = await nextAny();
      if (!type || m.type === type) return m;
    }
  };
  let n = 0;
  const send = (type: string, payload: unknown, id = `m${++n}`) => {
    ws.send(JSON.stringify({ type, id, payload }));
    return id;
  };
  const s = { ws, next, send };
  expect((await next()).type).toBe("hello");
  return s;
}

const plan = [
  { op: "addNode", tempId: "script", kind: "script", title: "Script", params: { rows: [{ n: "01", visual: "Bottle on a rock", seconds: 4, line: "“Pop it open.”" }] } },
  { op: "addNode", tempId: "prompt", kind: "text", title: "Prompt", params: { text: "a bottle on a rock" } },
  { op: "addNode", tempId: "key", kind: "image", title: "Keyframe", params: { model: "bytedance/seedream-5.0-lite" } },
  { op: "addNode", tempId: "shot", kind: "video", title: "Shot 1", params: { prompt: "slow push-in", seconds: 4 } },
  { op: "connect", from: { node: "prompt", port: "out" }, to: { node: "key", port: "prompt" } },
  { op: "connect", from: { node: "key", port: "out" }, to: { node: "shot", port: "frame" } },
  { op: "group", nodeIds: ["key", "shot"], title: "Scene 1" },
];

async function seed(userId: string) {
  const projectId = await createProject(userId);
  const res = await api(userId, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: 0, ops: plan } });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { revision: number; idMap: Record<string, string>; ops: any[] };
  return { projectId, ids: body.idMap as Record<"script" | "prompt" | "key" | "shot", string>, revision: body.revision, ops: body.ops };
}

describe("ProjectRoom over WebSocket", () => {
  it("keeps two sockets in sync and restores everything on reconnect", async () => {
    const alice = user("alice");
    const projectId = await createProject(alice);
    const a = await connect(projectId, alice);
    const b = await connect(projectId, alice);
    const snap = await a.next("snapshot");
    expect(snap.payload).toMatchObject({ projectId, revision: 0, nodes: [], edges: [], canvases: [{ id: expect.stringMatching(/^cnv_/) }] });
    await b.next("snapshot");

    const id = a.send("patch", { baseRevision: 0, ops: plan });
    const ack = await a.next("ack");
    expect(ack).toMatchObject({ id, payload: { revision: 1 } });
    const patched = await b.next("graph.patched");
    expect(patched.payload.revision).toBe(1);
    // Ops are normalized: final node ids, edge ids and group ids, plus layout positions.
    const adds = patched.payload.ops.filter((o: any) => o.op === "addNode");
    expect(adds.every((o: any) => /^node_/.test(o.tempId) && typeof o.position.x === "number")).toBe(true);
    const key = adds.find((o: any) => o.title === "Keyframe");
    const shot = adds.find((o: any) => o.title === "Shot 1");
    expect(key.position.x).toBeLessThan(shot.position.x);
    expect(patched.payload.ops.filter((o: any) => o.op === "connect").every((o: any) => /^edge_/.test(o.edgeId))).toBe(true);

    // A client-chosen id with the right prefix is kept; reusing it is refused.
    b.send("patch", { baseRevision: 1, ops: [{ op: "moveNode", nodeId: key.tempId, position: { x: 10, y: 20 } }, { op: "addNode", tempId: "node_CLIENT1", kind: "text", title: "Note", params: {} }] });
    expect((await b.next("ack")).payload.revision).toBe(2);
    expect((await a.next("graph.patched")).payload.ops[1]).toMatchObject({ tempId: "node_CLIENT1" });
    b.send("patch", { baseRevision: 2, ops: [{ op: "addNode", tempId: "node_CLIENT1", kind: "text", title: "Dup", params: {} }] });
    expect((await b.next("error")).payload).toMatchObject({ code: "DUPLICATE_ID" });

    a.ws.close();
    b.ws.close();
    const c = await connect(projectId, alice);
    const restored = (await c.next("snapshot")).payload;
    expect(restored.revision).toBe(2);
    expect(restored.nodes).toHaveLength(5);
    expect(restored.edges).toHaveLength(2);
    expect(restored.groups).toMatchObject([{ title: "Scene 1" }]);
    expect(restored.nodes.find((n: any) => n.id === key.tempId)).toMatchObject({ x: 10, y: 20, group_id: restored.groups[0].id });
    c.ws.close();
  });

  it("refuses invalid connections with a reason and stale revisions with a conflict", async () => {
    const alice = user("alice");
    const { projectId, ids } = await seed(alice);
    const a = await connect(projectId, alice);
    await a.next("snapshot");

    a.send("patch", { baseRevision: 1, ops: [{ op: "addNode", tempId: "voice", kind: "audio", title: "Voice", params: {} }, { op: "connect", from: { node: "voice", port: "out" }, to: { node: ids.key, port: "refs" } }] });
    const refused = await a.next("error");
    expect(refused.payload).toMatchObject({ code: "PORT_TYPE_MISMATCH", message: "Image nodes don’t take audio input.", data: { code: "PORT_TYPE_MISMATCH", opIndex: 1 } });

    a.send("patch", { baseRevision: 1, ops: [{ op: "connect", from: { node: ids.shot, port: "out" }, to: { node: ids.key, port: "refs" } }] });
    expect((await a.next("error")).payload).toMatchObject({ code: "PORT_TYPE_MISMATCH" });
    a.send("patch", { baseRevision: 1, ops: [{ op: "bogus" }] });
    expect((await a.next("error")).payload).toMatchObject({ code: "INVALID_OP" });

    a.send("patch", { baseRevision: 0, ops: [{ op: "moveNode", nodeId: ids.key, position: { x: 1, y: 1 } }] });
    const conflict = await a.next("conflict");
    expect(conflict.payload.snapshot).toMatchObject({ revision: 1 });
    expect(conflict.payload.snapshot.nodes).toHaveLength(4);

    // REST: same rules.
    const stale = await api(alice, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: 0, ops: [] } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "CONFLICT", data: { snapshot: { revision: 1 } } } });
    const bad = await api(alice, `/api/projects/${projectId}/patch`, {
      method: "POST",
      json: { baseRevision: 1, ops: [{ op: "connect", from: { node: ids.shot, port: "out" }, to: { node: ids.shot, port: "frame" } }] },
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: { code: "VALIDATION_FAILED", data: { refusal: { code: "SELF_CONNECTION" } } } });

    a.send("ping", null, "p1");
    expect(await a.next("pong")).toMatchObject({ id: "p1" });
    a.send("nope", null);
    expect((await a.next("error")).payload).toMatchObject({ code: "UNKNOWN_TYPE" });
    a.ws.send("not json");
    expect((await a.next("error")).payload).toMatchObject({ code: "BAD_MESSAGE" });
    a.ws.close();
  });

  it("undoes and redoes the caller's own patches", async () => {
    const alice = user("alice");
    const { projectId, ids } = await seed(alice);
    const a = await connect(projectId, alice);
    const b = await connect(projectId, alice);
    await a.next("snapshot");
    await b.next("snapshot");

    a.send("patch", { baseRevision: 1, ops: [{ op: "removeNode", nodeId: ids.key }] });
    await a.next("ack");
    await b.next("graph.patched");

    a.send("undo", {});
    const undo = await a.next("ack");
    expect(undo.payload.revision).toBe(3);
    expect(undo.payload.ops.some((o: any) => o.op === "addNode" && o.tempId === ids.key)).toBe(true);
    expect((await b.next("graph.patched")).payload).toMatchObject({ revision: 3, kind: "undo" });

    let snap = (await (await api(alice, `/api/projects/${projectId}`)).json()) as any;
    expect(snap.snapshot.nodes.map((n: any) => n.id)).toContain(ids.key);
    expect(snap.snapshot.edges).toHaveLength(2);
    expect(snap.snapshot.groups[0]).toBeDefined();
    expect(snap.snapshot.nodes.filter((n: any) => n.group_id === snap.snapshot.groups[0].id)).toHaveLength(2);

    const redo = await api(alice, `/api/projects/${projectId}/redo`, { method: "POST" });
    expect(redo.status).toBe(200);
    snap = (await (await api(alice, `/api/projects/${projectId}`)).json()) as any;
    expect(snap.snapshot.nodes.map((n: any) => n.id)).not.toContain(ids.key);
    expect(snap.snapshot.revision).toBe(4);

    expect((await api(alice, `/api/projects/${projectId}/redo`, { method: "POST" })).status).toBe(409);
    // Undo walks back: the redone removal, then the plan.
    for (let i = 0; i < 2; i++) expect((await api(alice, `/api/projects/${projectId}/undo`, { method: "POST" })).status).toBe(200);
    snap = (await (await api(alice, `/api/projects/${projectId}`)).json()) as any;
    expect(snap.snapshot.nodes).toEqual([]);
    expect(await (await api(alice, `/api/projects/${projectId}/undo`, { method: "POST" })).json()).toMatchObject({ error: { data: { reason: "NOTHING_TO_UNDO" } } });
    a.ws.close();
    b.ws.close();
  });

  it("refuses sockets without a session or membership", async () => {
    const alice = user("alice");
    const projectId = await createProject(alice);
    const anon = await api(null, `/api/projects/${projectId}/ws`, { headers: { Upgrade: "websocket" } });
    expect(await refusedSocket(anon)).toMatchObject({ closeCode: 4401, error: { code: "UNAUTHENTICATED" } });
    const bob = await api(user("bob"), `/api/projects/${projectId}/ws`, { headers: { Upgrade: "websocket" } });
    expect(await refusedSocket(bob)).toMatchObject({ closeCode: 4404, error: { code: "NOT_FOUND" } });
    const plain = await api(alice, `/api/projects/${projectId}/ws`);
    expect(plain.status).toBe(426);
  });
});

describe("node versions and staleness", () => {
  it("records versions, marks downstream stale when an input changes, switches the active version", async () => {
    const alice = user("alice");
    const { projectId, ids } = await seed(alice);
    const room = projectRoom(env, projectId);
    const caller = { userId: alice, workspaceId: wsOf(alice), canEdit: true };
    const a = await connect(projectId, alice);
    await a.next("snapshot");

    const keyDigest = await room.inputDigest(caller, ids.key);
    if (!keyDigest.ok) throw new Error("no digest");
    const v1 = await room.addVersion({ nodeId: ids.key, assetId: "ast_K1", inputDigest: keyDigest.digest, model: "m", jobId: "job_1" });
    expect(v1).toMatchObject({ ok: true, version: { n: 1, active: true, stale: false } });
    const broadcast = await a.next("node.version");
    expect(broadcast.payload).toMatchObject({ nodeId: ids.key, version: { n: 1, total: 1, assetId: "ast_K1" }, statuses: { [ids.key]: "done" } });

    const shotDigest = await room.inputDigest(caller, ids.shot);
    if (!shotDigest.ok) throw new Error("no digest");
    await room.addVersion({ nodeId: ids.shot, assetId: "ast_S1", inputDigest: shotDigest.digest });
    await a.next("node.version");

    // Upstream prompt edit: both generated nodes become "Input changed".
    a.send("patch", { baseRevision: 1, ops: [{ op: "updateNode", nodeId: ids.prompt, params: { text: "a bottle on a mossy rock" } }] });
    const ack = await a.next("ack");
    expect(ack.payload.statuses).toEqual({ [ids.key]: "outdated", [ids.shot]: "outdated" });

    // Moving a node changes nothing.
    a.send("patch", { baseRevision: 2, ops: [{ op: "moveNode", nodeId: ids.key, position: { x: 500, y: 0 } }] });
    expect((await a.next("ack")).payload.statuses).toEqual({});

    const fresh = await room.inputDigest(caller, ids.key);
    if (!fresh.ok) throw new Error("no digest");
    await room.addVersion({ nodeId: ids.key, assetId: "ast_K2", inputDigest: fresh.digest });
    const v2 = await a.next("node.version");
    expect(v2.payload.version).toMatchObject({ n: 2, total: 2, stale: false });

    const list = await api(alice, `/api/nodes/${ids.key}/versions?projectId=${projectId}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as any;
    expect(body.versions.map((v: any) => [v.n, v.active, v.stale])).toEqual([
      [2, true, false],
      [1, false, true],
    ]);

    const v1Id = body.versions[1].id;
    const setActive = await api(alice, `/api/nodes/${ids.key}/active`, { method: "POST", json: { projectId, versionId: v1Id } });
    expect(setActive.status).toBe(200);
    expect(await setActive.json()).toMatchObject({ version: { n: 1, active: true, stale: true }, statuses: { [ids.key]: "outdated" } });
    expect((await a.next("node.version")).payload).toMatchObject({ nodeId: ids.key, version: { n: 1, active: true } });

    const snap = (await room.getSnapshot(caller)) as any;
    expect(snap.nodes.find((n: any) => n.id === ids.key)).toMatchObject({ status: "outdated", version_n: 1, version_total: 2, asset_id: "ast_K1", version_rating: null });

    // D-005 rating column: from the postCheck, else output.rating; in versions, node.version and snapshots.
    const rated = await room.addVersion({ nodeId: ids.shot, assetId: "ast_S2", inputDigest: "dg_r", rating: "explicit" });
    expect(rated).toMatchObject({ ok: true, version: { rating: "explicit" } });
    expect((await a.next("node.version")).payload.version).toMatchObject({ n: 2, rating: "explicit" });
    const fromOutput = await room.addVersion({ nodeId: ids.shot, assetId: "ast_S3", inputDigest: "dg_r2", output: { rating: "safe" } });
    expect(fromOutput).toMatchObject({ ok: true, version: { rating: "safe" } });
    await a.next("node.version");
    const bogus = await room.addVersion({ nodeId: ids.shot, assetId: "ast_S4", inputDigest: "dg_r3", rating: "spicy" });
    expect(bogus).toMatchObject({ ok: true, version: { rating: null } });
    await a.next("node.version");
    const shotVersions = (await (await api(alice, `/api/nodes/${ids.shot}/versions?projectId=${projectId}`)).json()) as any;
    expect(shotVersions.versions.map((v: any) => v.rating)).toEqual([null, "safe", "explicit", null]);
    const snap2 = (await room.getSnapshot(caller)) as any;
    expect(snap2.nodes.find((n: any) => n.id === ids.shot)).toMatchObject({ version_n: 4, version_rating: null });
    const back = shotVersions.versions.find((v: any) => v.n === 2).id;
    await api(alice, `/api/nodes/${ids.shot}/active`, { method: "POST", json: { projectId, versionId: back } });
    await a.next("node.version");
    const snap3 = (await room.getSnapshot(caller)) as any;
    expect(snap3.nodes.find((n: any) => n.id === ids.shot)).toMatchObject({ version_n: 2, version_rating: "explicit" });

    // Run plans for the generation pipeline.
    const planned = await room.planRun(caller, { scope: "upTo", nodeIds: [ids.shot] });
    if (!planned.ok) throw new Error("plan failed");
    expect(planned.items.map((i) => [i.title, i.action])).toEqual([
      ["Prompt", "none"],
      ["Keyframe", "run"],
      ["Shot 1", "run"],
    ]);
    expect(planned.items[2]!.dependsOn).toEqual([ids.key]);

    expect(await room.markFailed({ nodeId: ids.shot, jobId: "job_2", refunded: 120, reason: "provider_error" })).toEqual({ ok: true });
    expect((await a.next("job.failed")).payload).toMatchObject({ nodeId: ids.shot, refunded: 120 });
    expect(await room.resetNode({ nodeId: ids.shot, reason: "canceled" })).toEqual({ ok: true, status: "outdated" });
    expect((await a.next("node.version")).payload).toMatchObject({ nodeId: ids.shot, status: "outdated", reason: "canceled" });
    expect(await room.markQueued({ nodeId: ids.key, jobId: "job_3" })).toEqual({ ok: true });
    expect((await a.next("job.queued")).payload).toMatchObject({ nodeId: ids.key, jobId: "job_3" });
    a.ws.close();
  });

  it("persists bypass and collapsed flags and plans around a bypassed node", async () => {
    const alice = user("alice");
    const { projectId, ids, revision } = await seed(alice);
    const res = await api(alice, `/api/projects/${projectId}/patch`, {
      method: "POST",
      json: { baseRevision: revision, ops: [{ op: "setBypass", nodeId: ids.key, bypass: true }, { op: "setCollapsed", nodeId: ids.prompt, collapsed: true }] },
    });
    expect(res.status).toBe(200);
    const caller = { userId: alice, workspaceId: wsOf(alice), canEdit: true };
    const room = projectRoom(env, projectId);
    const snap = (await room.getSnapshot(caller)) as any;
    expect(snap.nodes.find((n: any) => n.id === ids.key).bypass).toBe(1);
    expect(snap.nodes.find((n: any) => n.id === ids.prompt).collapsed).toBe(1);
    const planned = await room.planRun(caller, { scope: "all" });
    if (!planned.ok) throw new Error("plan failed");
    expect(planned.items.find((i) => i.nodeId === ids.key)!.action).toBe("bypassed");
    expect(planned.items.find((i) => i.nodeId === ids.shot)).toMatchObject({ action: "blocked", reason: "BYPASS_TYPE_MISMATCH" });
    // Undo restores the flags.
    expect((await api(alice, `/api/projects/${projectId}/undo`, { method: "POST" })).status).toBe(200);
    const after = (await room.getSnapshot(caller)) as any;
    expect(after.nodes.find((n: any) => n.id === ids.key).bypass).toBe(0);

    // Reroute points persist on the edge and survive a reconnect.
    const edgeId = after.edges[0].id;
    const rr = await api(alice, `/api/projects/${projectId}/patch`, {
      method: "POST",
      json: { baseRevision: after.revision, ops: [{ op: "addReroute", edgeId, index: 0, position: { x: 40, y: 50 } }, { op: "addReroute", edgeId, index: 1, position: { x: 60, y: 70 } }] },
    });
    expect(rr.status, await rr.clone().text()).toBe(200);
    const withReroutes = (await room.getSnapshot(caller)) as any;
    expect(JSON.parse(withReroutes.edges.find((e: any) => e.id === edgeId).reroutes)).toEqual([{ x: 40, y: 50 }, { x: 60, y: 70 }]);
    const tooFar = await api(alice, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: withReroutes.revision, ops: [{ op: "removeReroute", edgeId, index: 5 }] } });
    expect(await tooFar.json()).toMatchObject({ error: { data: { refusal: { code: "REROUTE_NOT_FOUND" } } } });
    expect((await api(alice, `/api/projects/${projectId}/undo`, { method: "POST" })).status).toBe(200);
    expect(((await room.getSnapshot(caller)) as any).edges.find((e: any) => e.id === edgeId).reroutes).toBeNull();
  });
});

describe("projects REST and the D1 index", () => {
  it("lists recent projects, renames, updates the index after commits, deletes", async () => {
    const alice = user("alice");
    const p1 = await createProject(alice, "First");
    const { projectId: p2 } = await seed(alice);

    const room = projectRoom(env, p2);
    await room.flushIndex();
    const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(p2).first<any>();
    expect(row).toMatchObject({ node_count: 4, workspace_id: wsOf(alice) });

    const list = (await (await api(alice, "/api/projects?first=1")).json()) as any;
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(p2);
    const page2 = (await (await api(alice, `/api/projects?first=1&after=${encodeURIComponent(list.nextCursor)}`)).json()) as any;
    expect(page2.items.map((p: any) => p.id)).toEqual([p1]);

    const gql = await api(alice, "/api/graphql", { method: "POST", json: { query: "{ projects(first: 10) { edges { node { id title nodeCount } } pageInfo { hasNextPage } } }" } });
    const gqlBody = (await gql.json()) as any;
    expect(gqlBody.data.projects.edges.map((e: any) => e.node.id)).toEqual([p2, p1]);

    const renamed = await api(alice, `/api/projects/${p1}`, { method: "PATCH", json: { title: "Renamed" } });
    expect(await renamed.json()).toMatchObject({ project: { title: "Renamed" } });

    const del = await api(alice, `/api/projects/${p1}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await api(alice, `/api/projects/${p1}`)).status).toBe(404);
  });

  it("scopes projects to their workspace", async () => {
    const alice = user("alice");
    const bob = user("bob");
    const { projectId, ids } = await seed(alice);
    expect((await api(bob, `/api/projects/${projectId}`)).status).toBe(404);
    expect((await api(bob, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: 1, ops: [] } })).status).toBe(404);
    expect((await api(bob, `/api/nodes/${ids.key}/versions?projectId=${projectId}`)).status).toBe(404);
    expect((await api(bob, `/api/projects/${projectId}/share`, { method: "POST", json: {} })).status).toBe(404);
    const list = (await (await api(bob, "/api/projects")).json()) as any;
    expect(list.items.map((p: any) => p.id)).not.toContain(projectId);
    expect((await api(null, "/api/projects")).status).toBe(401);
    // The DO re-checks the workspace on every call.
    const denied = await projectRoom(env, projectId).getSnapshot({ userId: bob, workspaceId: wsOf(bob), canEdit: true });
    expect(denied).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // A viewer in the workspace can read but not edit.
    await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'viewer')").bind(wsOf(alice), bob).run();
    const asViewer = { "x-workspace-id": wsOf(alice) };
    expect((await api(bob, `/api/projects/${projectId}`, { headers: asViewer })).status).toBe(200);
    expect((await api(bob, `/api/projects/${projectId}/patch`, { method: "POST", headers: asViewer, json: { baseRevision: 1, ops: [] } })).status).toBe(403);
  });

  it("assembles the timeline from the script and applies timeline ops", async () => {
    const alice = user("alice");
    const { projectId, ids } = await seed(alice);
    const canvasId = `cnv_${projectId.slice(4)}`;
    const tl = (await (await api(alice, `/api/canvases/${canvasId}/timeline`)).json()) as any;
    expect(tl.revision).toBe(0);
    const video = tl.edl.tracks.find((t: any) => t.kind === "video");
    expect(video.clips).toMatchObject([{ id: "v1", nodeId: ids.shot, in: 0, out: 4, start: 0 }]);
    expect(tl.edl.tracks.find((t: any) => t.kind === "caption").clips).toMatchObject([{ text: "Pop it open." }]);

    const a = await connect(projectId, alice);
    await a.next("snapshot");
    const trim = await api(alice, `/api/canvases/${canvasId}/timeline/patch`, { method: "POST", json: { baseRevision: 0, ops: [{ op: "trim", clipId: "v1", out: 3 }] } });
    expect(trim.status).toBe(200);
    expect(await trim.json()).toMatchObject({ revision: 1 });
    expect((await a.next("timeline.patched")).payload).toMatchObject({ canvasId, revision: 1, ops: [{ op: "trim", clipId: "v1", out: 3 }] });

    a.send("timeline.patch", { canvasId, baseRevision: 0, ops: [{ op: "trim", clipId: "v1", out: 2 }] });
    expect((await a.next("conflict")).payload.timeline).toMatchObject({ revision: 1 });
    a.send("timeline.patch", { canvasId, baseRevision: 1, ops: [{ op: "split", clipId: "v1", at: 0.05 }] });
    expect((await a.next("error")).payload).toMatchObject({ code: "TIMELINE_INVALID" });

    const re = (await (await api(alice, `/api/canvases/${canvasId}/timeline/reassemble`, { method: "POST" })).json()) as any;
    expect(re.revision).toBe(2);
    expect(re.edl.tracks.find((t: any) => t.kind === "video").clips[0]).toMatchObject({ nodeId: ids.shot, out: 3 });
    expect((await api(user("bob"), `/api/canvases/${canvasId}/timeline`)).status).toBe(404);
    a.ws.close();
  });
});
