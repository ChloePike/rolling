/**
 * D-014 global WebSocket: `/api/ws` (UserHub) is the gateway, multiplexed by
 * channel. Subscribe/unsubscribe with membership checks, patch round trip,
 * fan-out to two users, resubscribe catch-up from the event ring, and state
 * kept in hibernation attachments.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { projectRoom } from "../src/lib/access";

const BASE = "https://example.com";

interface Envelope {
  type: string;
  id: string;
  payload: any;
  channel?: "user" | "project";
  projectId?: string;
  seq?: number;
}

let seq = 0;
const user = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;
const wsOf = (userId: string) => `ws_dev_${userId}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function createProject(userId: string): Promise<string> {
  const res = await api(userId, "/api/projects", { method: "POST", json: { title: "Gateway" } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

interface Gateway {
  ws: WebSocket;
  hello: Envelope;
  all: Envelope[];
  next: (pred?: (e: Envelope) => boolean) => Promise<Envelope>;
  request: (type: string, payload: unknown) => Promise<Envelope>;
  none: (pred: (e: Envelope) => boolean, ms?: number) => Promise<void>;
}

async function gateway(userId: string): Promise<Gateway> {
  const res = await api(userId, "/api/ws", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const all: Envelope[] = [];
  const queue: Envelope[] = [];
  let wake: (() => void) | null = null;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Envelope;
    all.push(msg);
    queue.push(msg);
    wake?.();
  });
  ws.accept();
  const next = async (pred: (e: Envelope) => boolean = () => true) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = queue.findIndex(pred);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(queue.map((q) => q.type))}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
  };
  let n = 0;
  const request = async (type: string, payload: unknown) => {
    const id = `c${++n}`;
    ws.send(JSON.stringify({ type, id, payload }));
    return next((e) => e.id === id);
  };
  const none = async (pred: (e: Envelope) => boolean, ms = 200) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue.filter(pred)).toEqual([]);
  };
  const hello = await next((e) => e.type === "hello");
  return { ws, hello, all, next, request, none };
}

const addNode = (tempId: string, title = "Prompt") => ({ op: "addNode", tempId, kind: "text", title, params: { text: "hi" } });

describe("gateway subscribe/unsubscribe", () => {
  it("checks workspace membership per subscription and keeps the connection open on errors", async () => {
    const alice = user("gwa");
    const projectId = await createProject(alice);
    const a = await gateway(alice);
    expect(a.hello).toMatchObject({ channel: "user", payload: { userId: alice } });

    const sub = await a.request("subscribe", { channel: "project", projectId });
    expect(sub).toMatchObject({ type: "subscribed", channel: "project", projectId, payload: { projectId, revision: 0, canEdit: true } });
    expect(sub.payload.snapshot).toMatchObject({ projectId, revision: 0 });

    const bob = user("gwb");
    const b = await gateway(bob);
    const denied = await b.request("subscribe", { channel: "project", projectId });
    expect(denied).toMatchObject({ type: "error", projectId, payload: { projectId, code: "NOT_FOUND" } });
    const notSub = await b.request("patch", { projectId, baseRevision: 0, ops: [addNode("x")] });
    expect(notSub.payload).toMatchObject({ code: "NOT_SUBSCRIBED" });
    // Still connected.
    expect((await b.request("ping", null)).type).toBe("pong");

    // A repeated subscribe on the same socket (a second tab joining through the shared hub)
    // gets its own `subscribed` reply, matched by that request's id.
    const again = await a.request("subscribe", { channel: "project", projectId });
    expect(again).toMatchObject({ type: "subscribed", projectId, payload: { projectId, revision: 0 } });
    expect(again.id).not.toBe(sub.id);

    const bad = await a.request("subscribe", { channel: "project" });
    expect(bad.payload).toMatchObject({ code: "BAD_MESSAGE" });

    const un = await a.request("unsubscribe", { projectId });
    expect(un).toMatchObject({ type: "unsubscribed", payload: { projectId } });
    const subs = await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(projectId)), (_i, state) =>
      state.storage.sql.exec("SELECT user_id FROM hub_subscribers").toArray(),
    );
    expect(subs).toEqual([]);
    a.ws.close();
    b.ws.close();
  });
});

describe("gateway patch round trip and fan-out", () => {
  it("acks the sender, fans graph.patched out to the user's other sockets and to another member", async () => {
    const alice = user("gwp");
    const bob = user("gwq");
    const projectId = await createProject(alice);
    await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'viewer')").bind(wsOf(alice), bob).run();
    const a1 = await gateway(alice);
    const a2 = await gateway(alice);
    const b = await gateway(bob);
    for (const g of [a1, a2, b]) expect((await g.request("subscribe", { channel: "project", projectId })).type).toBe("subscribed");

    const ack = await a1.request("patch", { projectId, baseRevision: 0, ops: [addNode("p")] });
    expect(ack).toMatchObject({ type: "ack", channel: "project", projectId, payload: { revision: 1 } });
    const nodeId = ack.payload.idMap.p as string;
    for (const g of [a2, b]) {
      const ev = await g.next((e) => e.type === "graph.patched");
      expect(ev).toMatchObject({ channel: "project", projectId, payload: { revision: 1, userId: alice } });
      expect(ev.seq).toBeGreaterThan(0);
    }
    await a1.none((e) => e.type === "graph.patched");

    // Viewers can read but not write.
    const refused = await b.request("patch", { projectId, baseRevision: 1, ops: [addNode("q")] });
    expect(refused).toMatchObject({ type: "error", payload: { projectId, code: "FORBIDDEN" } });
    const stale = await a1.request("patch", { projectId, baseRevision: 0, ops: [addNode("r")] });
    expect(stale.type).toBe("conflict");
    expect(stale.payload.snapshot).toMatchObject({ revision: 1 });

    // Undo through the gateway; server events from trusted code reach every subscriber.
    const undo = await a1.request("undo", { projectId });
    expect(undo).toMatchObject({ type: "ack", payload: { revision: 2 } });
    await b.next((e) => e.type === "graph.patched" && e.payload.kind === "undo");
    await projectRoom(env, projectId).broadcast("job.done", { jobId: "job_x", nodeId });
    for (const g of [a1, a2, b]) expect(await g.next((e) => e.type === "job.done")).toMatchObject({ projectId, payload: { jobId: "job_x" } });

    // User channel: to every socket of that user only.
    const hub = env.USER_HUB.get(env.USER_HUB.idFromName(alice));
    expect(await hub.broadcast("credits.changed", { balance: 5 })).toBe(2);
    for (const g of [a1, a2]) expect(await g.next((e) => e.type === "credits.changed")).toMatchObject({ channel: "user", payload: { balance: 5 } });
    await b.none((e) => e.type === "credits.changed");

    // Snapshot and timeline through the gateway.
    const snap = await b.request("snapshot", { projectId });
    expect(snap).toMatchObject({ type: "snapshot", projectId, payload: { revision: 2 } });
    const canvasId = snap.payload.canvases[0].id as string;
    const tl = await a1.request("timeline.patch", { canvasId, baseRevision: 0, ops: [] });
    expect(["ack", "error"]).toContain(tl.type);
    expect(tl.projectId).toBe(projectId);
    for (const g of [a1, a2, b]) g.ws.close();
  });
});

describe("gateway resubscribe catch-up", () => {
  it("replays the gap from the ring by seq or revision, else sends a fresh snapshot", async () => {
    const alice = user("gwc");
    const projectId = await createProject(alice);
    const a = await gateway(alice);
    const first = await a.request("subscribe", { channel: "project", projectId });
    expect((await a.request("patch", { projectId, baseRevision: 0, ops: [addNode("a")] })).type).toBe("ack");
    const lastSeq = (await a.request("subscribe", { channel: "project", projectId, lastSeq: first.payload.seq })).payload.seq as number;
    expect(await a.request("unsubscribe", { projectId })).toMatchObject({ type: "unsubscribed" });

    // Missed while away: two patches (REST) and a version event.
    for (const [base, t] of [[1, "b"], [2, "c"]] as const) {
      const r = await api(alice, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: base, ops: [addNode(t)] } });
      expect(r.status).toBe(200);
    }
    await projectRoom(env, projectId).broadcast("proposal.created", { threadId: "thr_x" });

    const bySeq = await a.request("subscribe", { channel: "project", projectId, lastSeq });
    expect(bySeq.payload.snapshot).toBeUndefined();
    expect(bySeq.payload.events.map((e: any) => [e.type, e.payload.revision ?? null])).toEqual([
      ["graph.patched", 2],
      ["graph.patched", 3],
      ["proposal.created", null],
    ]);
    expect(bySeq.payload).toMatchObject({ revision: 3, seq: lastSeq + 3 });

    const byRevision = await a.request("subscribe", { channel: "project", projectId, lastRevision: 1 });
    expect(byRevision.payload.events.map((e: any) => e.type)).toEqual(["graph.patched", "graph.patched", "proposal.created"]);

    // Ring no longer covers the gap: snapshot.
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(projectId)), (_i, state) => {
      state.storage.sql.exec("DELETE FROM event_ring WHERE seq <= ?", lastSeq + 1);
    });
    const tooOld = await a.request("subscribe", { channel: "project", projectId, lastSeq });
    expect(tooOld.payload.events).toBeUndefined();
    expect(tooOld.payload.snapshot).toMatchObject({ revision: 3 });
    a.ws.close();
  });
});

describe("gateway hibernation", () => {
  it("keeps subscriptions in socket attachments and drops hubs whose sockets are gone", async () => {
    const alice = user("gwh");
    const projectId = await createProject(alice);
    const a = await gateway(alice);
    await a.request("subscribe", { channel: "project", projectId });
    const hub = env.USER_HUB.get(env.USER_HUB.idFromName(alice));
    const attachments = await runInDurableObject(hub, (_i, state) => state.getWebSockets().map((w) => w.deserializeAttachment()));
    expect(attachments).toEqual([expect.objectContaining({ userId: alice, connId: a.hello.payload.connId, subs: { [projectId]: expect.objectContaining({ canEdit: true }) } })]);

    // A woken hub (fresh RPC) delivers from the attachments alone.
    expect(await hub.deliver({ projectId, type: "job.queued", payload: { jobId: "j1", nodeId: "n1" }, seq: 99 })).toEqual({ subscribed: true });
    expect(await a.next((e) => e.type === "job.queued")).toMatchObject({ channel: "project", projectId, seq: 99 });

    // A hub with no subscribed socket answers subscribed: false and the room drops it on the next event.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await hub.deliver({ projectId, type: "job.queued", payload: {} })).toEqual({ subscribed: false });
    const room = env.PROJECT.get(env.PROJECT.idFromName(projectId));
    await runInDurableObject(room, (_i, state) => state.storage.sql.exec("INSERT OR IGNORE INTO hub_subscribers (user_id, subscribed_at) VALUES (?, 0)", alice));
    await projectRoom(env, projectId).broadcast("job.queued", { jobId: "j2", nodeId: "n1" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await runInDurableObject(room, (_i, state) => state.storage.sql.exec("SELECT COUNT(*) AS c FROM hub_subscribers").one().c)).toBe(0);
  });
});

describe("gateway: replies after the socket closed", () => {
  it("does not send() to a closed socket (unsubscribe racing a closing tab) and keeps the hub working", async () => {
    const alice = user("gwc");
    const projectId = await createProject(alice);
    const a = await gateway(alice);
    expect((await a.request("subscribe", { channel: "project", projectId })).type).toBe("subscribed");
    // Unsubscribe and close at once: the hub answers after its await, when the socket is gone.
    a.ws.send(JSON.stringify({ type: "unsubscribe", id: "u1", payload: { projectId } }));
    a.ws.close();
    await new Promise((r) => setTimeout(r, 200));

    // The guard itself: a closed socket is skipped, a socket whose send throws does not throw out.
    const hub = env.USER_HUB.get(env.USER_HUB.idFromName(alice));
    const result = await runInDurableObject(hub, (instance) => {
      const send = (instance as unknown as { send(ws: unknown, m: string): boolean }).send.bind(instance);
      let calls = 0;
      const closed = { readyState: WebSocket.CLOSED, send: () => calls++ };
      const throwing = { readyState: WebSocket.OPEN, send: () => { throw new TypeError("Can't call WebSocket send() after close()."); } };
      return { closed: send(closed, "x"), throwing: send(throwing, "x"), calls };
    });
    expect(result).toEqual({ closed: false, throwing: false, calls: 0 });

    // A new connection of the same user works normally.
    const b = await gateway(alice);
    expect((await b.request("subscribe", { channel: "project", projectId })).type).toBe("subscribed");
    expect((await b.request("unsubscribe", { projectId })).type).toBe("unsubscribed");
    b.ws.close();
  });
});
