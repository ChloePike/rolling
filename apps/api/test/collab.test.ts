/**
 * D-031 collaboration: presence fan-out over the global socket (memory only),
 * comments (CRUD, roles, unread, anchors), mentions (UserHub + email, prefs),
 * the activity feed, client review links (expiry, password, one-time code,
 * comments, approve / request changes, revoke) and the mature guard.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// Multi-step flows (sockets, emails, several DOs): generous per-test time on slow machines.
vi.setConfig({ testTimeout: 60_000 });
import { RecordingEmailProvider } from "@rolling/core/email/recording";
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
let ipSeq = 0;
const freshIp = () => `203.0.113.${(++ipSeq % 250) + 1}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", freshIp());
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function body<T = any>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

/** A dev user with a `users` row (name and email) so names and emails resolve. */
async function person(tag: string, name: string): Promise<{ id: string; email: string }> {
  const id = user(tag);
  const email = `${id}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(id, name, email, now, now).run();
  // Bootstraps the personal workspace and prefs.
  await body(await api(id, "/api/me"), 200);
  return { id, email };
}

async function addMember(workspaceId: string, userId: string, role: "editor" | "viewer") {
  await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?1, ?2, ?3)").bind(workspaceId, userId, role).run();
}

async function seedProject(owner: string): Promise<{ projectId: string; nodeId: string; canvasId: string; revision: number }> {
  const created = await body<{ project: { id: string } }>(await api(owner, "/api/projects", { method: "POST", json: { title: "Launch film" } }), 201);
  const projectId = created.project.id;
  const patched = await body<{ idMap: Record<string, string>; revision: number }>(
    await api(owner, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: 0, ops: [{ op: "addNode", tempId: "v", kind: "video", title: "Shot A", params: { prompt: "slow push-in" } }] } }),
    200,
  );
  return { projectId, nodeId: patched.idMap.v!, canvasId: `cnv_${projectId.slice(4)}`, revision: patched.revision };
}

async function addAsset(workspaceId: string, owner: string, opts: { mature?: boolean; kind?: "video" | "image" } = {}): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const key = `ws/${workspaceId}/gen/${id}.${opts.kind === "image" ? "png" : "mp4"}`;
  await env.MEDIA.put(key, new Uint8Array([0, 0, 0, 24]));
  await env.DB.prepare(
    "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, ?, 'generated', 'clip', ?, '{}', ?, ?, 'ready', ?)",
  )
    .bind(id, workspaceId, opts.kind ?? "video", key, owner, Date.now(), opts.mature ? 1 : 0)
    .run();
  return id;
}

interface Gateway {
  ws: WebSocket;
  next: (pred?: (e: Envelope) => boolean, ms?: number) => Promise<Envelope>;
  request: (type: string, payload: unknown) => Promise<Envelope>;
  send: (type: string, payload: unknown) => void;
  none: (pred: (e: Envelope) => boolean, ms?: number) => Promise<void>;
}

async function gateway(userId: string): Promise<Gateway> {
  const res = await api(userId, "/api/ws", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const queue: Envelope[] = [];
  let wake: (() => void) | null = null;
  ws.addEventListener("message", (event) => {
    queue.push(JSON.parse(event.data as string) as Envelope);
    wake?.();
  });
  ws.accept();
  const next = async (pred: (e: Envelope) => boolean = () => true, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = queue.findIndex(pred);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(queue.map((q) => q.type))}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 25);
      });
    }
  };
  let n = 0;
  const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ type, id: `p${++n}`, payload }));
  const request = async (type: string, payload: unknown) => {
    const id = `c${++n}`;
    ws.send(JSON.stringify({ type, id, payload }));
    return next((e) => e.id === id);
  };
  const none = async (pred: (e: Envelope) => boolean, ms = 250) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue.filter(pred).map((e) => e.type)).toEqual([]);
  };
  await next((e) => e.type === "hello");
  return { ws, next, request, send, none };
}

async function subscribe(g: Gateway, projectId: string) {
  const r = await g.request("subscribe", { channel: "project", projectId });
  expect(r.type, JSON.stringify(r.payload)).toBe("subscribed");
  return r;
}

describe("presence over the global socket", () => {
  it("fans cursors and selections out to the other subscribers, never to the sender, and drops them on leave", async () => {
    const alice = await person("pa", "Alice Adams");
    const bob = await person("pb", "Bob Brown");
    const { projectId, nodeId } = await seedProject(alice.id);
    await addMember(wsOf(alice.id), bob.id, "viewer");
    const ga = await gateway(alice.id);
    const gb = await gateway(bob.id);
    await subscribe(ga, projectId);
    await subscribe(gb, projectId);

    ga.send("presence", { projectId, key: "t1", cursor: { x: 120, y: -40 }, selection: [nodeId] });
    const upd = await gb.next((e) => e.type === "presence.updated");
    expect(upd.channel).toBe("project");
    expect(upd.projectId).toBe(projectId);
    expect(upd.seq).toBeUndefined(); // transient: no event cursor
    expect(upd.payload.entry).toMatchObject({ userId: alice.id, name: "Alice Adams", cursor: { x: 120, y: -40 }, selection: [nodeId], canEdit: true });
    await ga.none((e) => e.type === "presence.updated");

    // A viewer's presence reaches the owner too (canEdit false).
    gb.send("presence", { projectId, key: "t9", cursor: { x: 1, y: 2 } });
    const fromBob = await ga.next((e) => e.type === "presence.updated");
    expect(fromBob.payload.entry).toMatchObject({ userId: bob.id, canEdit: false, selection: [] });

    // Sync: everyone on the project, with the last cursor kept.
    const state = await gb.request("presence.sync", { projectId, key: "t9" });
    expect(state.type).toBe("presence.state");
    expect(state.payload.entries.map((e: any) => e.userId).sort()).toEqual([alice.id, bob.id].sort());

    // Bursts are coalesced: the last position arrives.
    for (let i = 0; i < 10; i++) ga.send("presence", { projectId, key: "t1", cursor: { x: i, y: i } });
    let last: Envelope | null = null;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        last = await gb.next((e) => e.type === "presence.updated", 200);
        if (last.payload.entry.cursor.x === 9) break;
      } catch {
        break;
      }
    }
    expect(last?.payload.entry.cursor).toEqual({ x: 9, y: 9 });

    // Never persisted: not in the event ring, not in SQLite.
    const stub = env.PROJECT.get(env.PROJECT.idFromName(projectId));
    await runInDurableObject(stub, async (_obj, state2) => {
      const rows = state2.storage.sql.exec("SELECT COUNT(*) AS n FROM event_ring WHERE type LIKE 'presence%'").one();
      expect(Number(rows.n)).toBe(0);
    });

    // Closing a socket leaves.
    gb.ws.close(1000, "bye");
    const left = await ga.next((e) => e.type === "presence.left");
    expect(left.payload.userId).toBe(bob.id);
    ga.ws.close(1000, "bye");
  });

  it("refuses presence before subscribing and bad payloads", async () => {
    const alice = await person("pc", "Cy");
    const { projectId } = await seedProject(alice.id);
    const g = await gateway(alice.id);
    const r = await g.request("presence", { projectId, cursor: { x: 1, y: 1 } });
    expect(r.payload.code).toBe("NOT_SUBSCRIBED");
    await subscribe(g, projectId);
    const bad = await g.request("presence", { projectId, selection: "node_1" });
    expect(bad.payload.code).toBe("BAD_MESSAGE");
    g.ws.close(1000, "bye");
  });
});

describe("comments", () => {
  it("creates, replies, resolves, edits and deletes by role", async () => {
    const owner = await person("co", "Olive Owner");
    const editor = await person("ce", "Eli Editor");
    const viewer = await person("cv", "Vic Viewer");
    const { projectId, nodeId, canvasId } = await seedProject(owner.id);
    await addMember(wsOf(owner.id), editor.id, "editor");
    await addMember(wsOf(owner.id), viewer.id, "viewer");
    const ws = { "x-workspace-id": wsOf(owner.id) };

    // Every anchor kind.
    const node = await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "node", nodeId }, body: "Warmer light here" } }), 201);
    expect(node.thread).toMatchObject({ status: "open", anchor: { kind: "node", nodeId }, comments: [{ body: "Warmer light here", author: { kind: "member", id: owner.id, name: "Olive Owner" } }] });
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "timeline", canvasId, start: 1.5, end: 3 }, body: "Cut earlier" } }), 201);
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "canvas", x: 40, y: 80 }, body: "Add a title card" } }), 201);
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "node", nodeId: "node_missing" }, body: "x" } }), 404);
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "version", nodeId, versionId: "ver_missing" }, body: "x" } }), 404);
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "timeline", canvasId: "cnv_other", start: 0, end: 1 }, body: "x" } }), 404);
    const assetId = await addAsset(wsOf(owner.id), owner.id);
    const added = await projectRoom(env, projectId).addVersion({ nodeId, assetId, inputDigest: "dg" });
    if (!added.ok) throw new Error("addVersion failed");
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "version", nodeId, versionId: added.version.id }, body: "This take" } }), 201);

    const threadId = node.thread.id as string;
    // Viewers comment.
    const reply = await body(await api(viewer.id, `/api/projects/${projectId}/comments/${threadId}/replies`, { method: "POST", headers: ws, json: { body: "Agreed" } }), 201);
    expect(reply.thread.comments).toHaveLength(2);
    // Viewers cannot resolve; editors can; reopen works.
    await body(await api(viewer.id, `/api/projects/${projectId}/comments/${threadId}`, { method: "PATCH", headers: ws, json: { status: "resolved" } }), 403);
    const resolved = await body(await api(editor.id, `/api/projects/${projectId}/comments/${threadId}`, { method: "PATCH", headers: ws, json: { status: "resolved" } }), 200);
    expect(resolved.thread).toMatchObject({ status: "resolved", resolvedBy: editor.id });
    const reopened = await body(await api(owner.id, `/api/projects/${projectId}/comments/${threadId}`, { method: "PATCH", json: { status: "open" } }), 200);
    expect(reopened.thread.status).toBe("open");

    // Only the author edits; the author or an owner deletes.
    const ownerComment = node.thread.comments[0].id as string;
    const viewerComment = reply.commentId as string;
    await body(await api(viewer.id, `/api/projects/${projectId}/comments/${threadId}/${ownerComment}`, { method: "PATCH", headers: ws, json: { body: "hijack" } }), 403);
    const edited = await body(await api(owner.id, `/api/projects/${projectId}/comments/${threadId}/${ownerComment}`, { method: "PATCH", json: { body: "Warmer light, please" } }), 200);
    expect(edited.thread.comments[0]).toMatchObject({ body: "Warmer light, please", editedAt: expect.any(Number) });
    await body(await api(editor.id, `/api/projects/${projectId}/comments/${threadId}/${viewerComment}`, { method: "DELETE", headers: ws }), 403);
    const del = await body(await api(owner.id, `/api/projects/${projectId}/comments/${threadId}/${viewerComment}`, { method: "DELETE" }), 200);
    expect(del.thread.comments.find((c: any) => c.id === viewerComment)).toMatchObject({ deleted: true, body: "" });

    // Unread: the viewer has not opened the owner's other threads.
    const list = await body(await api(viewer.id, `/api/projects/${projectId}/comments`, { headers: ws }), 200);
    expect(list.threads).toHaveLength(4);
    expect(list.canResolve).toBe(false);
    expect(list.unread).toBeGreaterThanOrEqual(3);
    expect(list.members.map((m: any) => m.userId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
    const read = await body(await api(viewer.id, `/api/projects/${projectId}/comments/read`, { method: "POST", headers: ws, json: { threadIds: list.threads.map((t: any) => t.id) } }), 200);
    expect(read.unread).toBe(0);

    // Outsiders see nothing.
    const stranger = await person("cx", "Stranger");
    await body(await api(stranger.id, `/api/projects/${projectId}/comments`), 404);

    // Activity: edits, the run, comments, resolve.
    const feed = await body(await api(viewer.id, `/api/projects/${projectId}/activity`, { headers: ws }), 200);
    const kinds = feed.entries.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["edit", "run.done", "comment", "comment.resolved", "comment.reopened"]));
    const edit = feed.entries.find((e: any) => e.kind === "edit");
    expect(edit.actor).toMatchObject({ kind: "member", id: owner.id, name: "Olive Owner" });
  });

  it("records one run start per job: the pre-job mark with an empty job id adds none", async () => {
    const owner = await person("cr", "Rae Runner");
    const { projectId, nodeId } = await seedProject(owner.id);
    const room = projectRoom(env, projectId);
    await room.markRunning({ nodeId, jobId: "", progress: 0, status: "queued" });
    await room.markRunning({ nodeId, jobId: "job_activity1", progress: 0, status: "queued" });
    await room.markRunning({ nodeId, jobId: "job_activity1", progress: 0.5, status: "generating" });
    const feed = await body(await api(owner.id, `/api/projects/${projectId}/activity`), 200);
    const started = feed.entries.filter((e: any) => e.kind === "run.started");
    expect(started).toHaveLength(1);
    expect(started[0].data).toMatchObject({ jobId: "job_activity1" });
  });

  it("broadcasts threads to subscribers and coalesces edits in the feed", async () => {
    const owner = await person("cb", "Bea");
    const { projectId, revision: start } = await seedProject(owner.id);
    const g = await gateway(owner.id);
    await subscribe(g, projectId);
    await body(await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "canvas", x: 0, y: 0 }, body: "Hello" } }), 201);
    const ev = await g.next((e) => e.type === "comment.thread");
    expect(ev.seq).toEqual(expect.any(Number)); // replayable
    expect(ev.payload.thread.comments[0].body).toBe("Hello");
    let revision = start;
    for (let i = 0; i < 3; i++) {
      const r = await body<{ revision: number }>(
        await api(owner.id, `/api/projects/${projectId}/patch`, { method: "POST", json: { baseRevision: revision, ops: [{ op: "addNode", tempId: `n${i}`, kind: "text", title: `T${i}`, params: { text: "x" } }] } }),
        200,
      );
      revision = r.revision;
    }
    const feed = await body(await api(owner.id, `/api/projects/${projectId}/activity`), 200);
    const first = feed.entries[0];
    expect(first.kind).toBe("edit");
    expect(first.data.count).toBe(3);
    g.ws.close(1000, "bye");
  });
});

describe("mentions", () => {
  it("notify through UserHub and email, and follow the notification switch", async () => {
    const owner = await person("mo", "Mia");
    const bob = await person("mb", "Ben");
    const quiet = await person("mq", "Quinn");
    const { projectId, nodeId } = await seedProject(owner.id);
    await addMember(wsOf(owner.id), bob.id, "editor");
    await addMember(wsOf(owner.id), quiet.id, "viewer");
    await env.DB.prepare("UPDATE user_prefs SET notifications = ? WHERE user_id = ?")
      .bind(JSON.stringify({ done: true, low: true, renewal: true, product: false, comments: false, mentions: false, reviews: true }), quiet.id)
      .run();
    const gb = await gateway(bob.id);
    const before = RecordingEmailProvider.to(bob.email).length;
    const created = await body(
      await api(owner.id, `/api/projects/${projectId}/comments`, { method: "POST", json: { anchor: { kind: "node", nodeId }, body: "@Ben @Quinn can you check this?", mentions: [bob.id, quiet.id, "usr_not_a_member", owner.id] } }),
      201,
    );
    expect(created.thread.comments[0].mentions.sort()).toEqual([bob.id, quiet.id].sort());
    const note = await gb.next((e) => e.type === "notification" && e.payload.kind === "mention");
    expect(note.channel).toBe("user");
    expect(note.payload).toMatchObject({ projectId, threadId: created.thread.id, href: `/p/${projectId}?thread=${created.thread.id}` });
    for (let i = 0; i < 100 && RecordingEmailProvider.to(bob.email).length === before; i++) await new Promise((r) => setTimeout(r, 20));
    const mail = RecordingEmailProvider.to(bob.email).at(-1)!;
    expect(mail.subject).toBe("Mia mentioned you in Launch film");
    expect(mail.text).toContain(`/p/${projectId}?thread=${created.thread.id}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(RecordingEmailProvider.to(quiet.email)).toHaveLength(0);

    // A reply notifies participants (comments switch) and the project creator.
    const go = await gateway(owner.id);
    await body(await api(bob.id, `/api/projects/${projectId}/comments/${created.thread.id}/replies`, { method: "POST", headers: { "x-workspace-id": wsOf(owner.id) }, json: { body: "Looks right" } }), 201);
    const reply = await go.next((e) => e.type === "notification" && e.payload.kind === "comment");
    expect(reply.payload.title).toBe("Ben commented on Launch film");
    gb.ws.close(1000, "bye");
    go.ws.close(1000, "bye");
  });
});

describe("review links", () => {
  async function setup() {
    const owner = await person("ro", "Rae Owner");
    const { projectId, nodeId } = await seedProject(owner.id);
    const assetId = await addAsset(wsOf(owner.id), owner.id);
    const added = await projectRoom(env, projectId).addVersion({ nodeId, assetId, inputDigest: "dg_r", rating: "safe" });
    if (!added.ok) throw new Error("addVersion failed");
    return { owner, projectId, nodeId, versionId: added.version.id, assetId };
  }

  const tokenOf = (url: string) => url.split("/review/")[1]!;

  it("shows media to reviewers, takes verified time-coded comments and decisions, and reports status to the owner", async () => {
    const { owner, projectId, nodeId, versionId } = await setup();
    const created = await body(await api(owner.id, `/api/projects/${projectId}/reviews`, { method: "POST", json: { kind: "version", nodeId, versionId } }), 201);
    expect(created.review).toMatchObject({ kind: "version", state: "active", status: "pending", hasPassword: false, mature: false, title: "Shot A · v1" });
    const token = tokenOf(created.review.url);

    // Signed out, no password: the page with a signed media URL.
    const page = await body(await api(null, `/api/review/${token}`), 200);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: "video", withheld: null });
    expect(page.items[0].media.url).toMatch(/sig=/);
    expect(page.me).toBeNull();

    // Comments need a verified email.
    await body(await api(null, `/api/review/${token}/comments`, { method: "POST", json: { itemId: "i1", at: 2.5, body: "Hold the shot longer" } }), 401);
    const email = `client.${Date.now()}@example.org`;
    await body(await api(null, `/api/review/${token}/code`, { method: "POST", json: { name: "Casey Client", email } }), 202);
    const mail = RecordingEmailProvider.to(email).at(-1)!;
    const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await body(await api(null, `/api/review/${token}/verify`, { method: "POST", json: { email, code: wrong } }), 400);
    expect(bad.error.code).toBe("INVALID_CODE");
    // Resend cooldown.
    await body(await api(null, `/api/review/${token}/code`, { method: "POST", json: { name: "Casey Client", email } }), 429);
    const verified = await body(await api(null, `/api/review/${token}/verify`, { method: "POST", json: { email, code } }), 200);
    expect(verified.reviewer).toMatchObject({ name: "Casey Client", email });
    const rt = { "x-reviewer-token": verified.reviewerToken as string };
    // The code is single use.
    await body(await api(null, `/api/review/${token}/verify`, { method: "POST", json: { email, code } }), 400);

    const comment = await body(await api(null, `/api/review/${token}/comments`, { method: "POST", headers: rt, json: { itemId: "i1", at: 2.5, body: "Hold the shot longer" } }), 201);
    expect(comment.thread).toMatchObject({ reviewId: created.review.id, anchor: { kind: "review", itemId: "i1", at: 2.5 }, comments: [{ author: { kind: "reviewer", name: "Casey Client" } }] });
    await body(await api(null, `/api/review/${token}/comments`, { method: "POST", headers: rt, json: { itemId: "nope", body: "x" } }), 404);

    // The owner sees the reviewer thread in the project comments and replies; the reviewer sees the reply.
    const threads = await body(await api(owner.id, `/api/projects/${projectId}/comments`), 200);
    const t = threads.threads.find((x: any) => x.reviewId === created.review.id);
    expect(t.unread).toBe(true);
    await body(await api(owner.id, `/api/projects/${projectId}/comments/${t.id}/replies`, { method: "POST", json: { body: "Will do" } }), 201);
    const again = await body(await api(null, `/api/review/${token}`, { headers: rt }), 200);
    expect(again.threads[0].comments.map((c: any) => c.body)).toEqual(["Hold the shot longer", "Will do"]);
    expect(again.me).toMatchObject({ name: "Casey Client", decision: null });

    // Decisions: changes requested, then approved (latest wins); the owner is emailed.
    const ownerMails = RecordingEmailProvider.to(owner.email).length;
    const d1 = await body(await api(null, `/api/review/${token}/decision`, { method: "POST", headers: rt, json: { decision: "changes_requested", note: "Shorter intro" } }), 200);
    expect(d1.status).toBe("changes_requested");
    const d2 = await body(await api(null, `/api/review/${token}/decision`, { method: "POST", headers: rt, json: { decision: "approved" } }), 200);
    expect(d2).toMatchObject({ status: "approved", me: { decision: "approved" } });
    for (let i = 0; i < 100 && RecordingEmailProvider.to(owner.email).length < ownerMails + 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(RecordingEmailProvider.to(owner.email).map((m) => m.subject)).toEqual(expect.arrayContaining(["Casey Client asked for changes on Shot A · v1", "Casey Client approved Shot A · v1"]));

    const list = await body(await api(owner.id, `/api/projects/${projectId}/reviews`), 200);
    expect(list.reviews[0]).toMatchObject({ id: created.review.id, status: "approved", decisions: [{ name: "Casey Client", decision: "approved" }] });
    const feed = await body(await api(owner.id, `/api/projects/${projectId}/activity`), 200);
    expect(feed.entries.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["review.created", "review.comment", "review.decision"]));

    // Revoked: 410 everywhere.
    const revoked = await body(await api(owner.id, `/api/projects/${projectId}/reviews/${created.review.id}`, { method: "DELETE" }), 200);
    expect(revoked.review.state).toBe("revoked");
    const gone = await body(await api(null, `/api/review/${token}`), 410);
    expect(gone.error).toMatchObject({ code: "LINK_EXPIRED", data: { state: "revoked" } });
    await body(await api(null, `/api/review/${token}/decision`, { method: "POST", headers: rt, json: { decision: "approved" } }), 410);
    await body(await api(null, "/api/review/not-a-real-token-at-all"), 404);
  });

  it("expires, asks for the password, and invalidates passes when the password changes", async () => {
    const { owner, projectId, nodeId } = await setup();
    const created = await body(await api(owner.id, `/api/projects/${projectId}/reviews`, { method: "POST", json: { kind: "shots", nodeIds: [nodeId], expiresInDays: 7, password: "sesame-42", title: "Round 1" } }), 201);
    expect(created.review).toMatchObject({ hasPassword: true, title: "Round 1", expiresAt: expect.any(Number) });
    const token = tokenOf(created.review.url);
    const locked = await body(await api(null, `/api/review/${token}`), 401);
    expect(locked.error).toMatchObject({ code: "PASSWORD_REQUIRED", data: { title: "Round 1" } });
    await body(await api(null, `/api/review/${token}/code`, { method: "POST", json: { name: "X", email: "x@example.org" } }), 401);
    await body(await api(null, `/api/review/${token}/unlock`, { method: "POST", json: { password: "nope" } }), 403);
    const { pass } = await body(await api(null, `/api/review/${token}/unlock`, { method: "POST", json: { password: "sesame-42" } }), 200);
    await body(await api(null, `/api/review/${token}`, { headers: { "x-review-pass": pass } }), 200);
    await body(await api(null, `/api/review/${token}`, { headers: { "x-review-pass": `${pass}x` } }), 401);

    // New password: old passes stop working.
    await body(await api(owner.id, `/api/projects/${projectId}/reviews/${created.review.id}`, { method: "PATCH", json: { password: "another-one" } }), 200);
    await body(await api(null, `/api/review/${token}`, { headers: { "x-review-pass": pass } }), 401);
    // Password removed: open.
    await body(await api(owner.id, `/api/projects/${projectId}/reviews/${created.review.id}`, { method: "PATCH", json: { password: null } }), 200);
    await body(await api(null, `/api/review/${token}`), 200);

    // Expired.
    await env.DB.prepare("UPDATE review_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, created.review.id).run();
    const expired = await body(await api(null, `/api/review/${token}`), 410);
    expect(expired.error.data.state).toBe("expired");
    const listed = await body(await api(owner.id, `/api/projects/${projectId}/reviews`), 200);
    expect(listed.reviews[0].state).toBe("expired");
    // Extending brings it back.
    await body(await api(owner.id, `/api/projects/${projectId}/reviews/${created.review.id}`, { method: "PATCH", json: { expiresInDays: 3 } }), 200);
    await body(await api(null, `/api/review/${token}`), 200);
  });

  it("only editors and owners create links; viewers do not", async () => {
    const { owner, projectId, nodeId } = await setup();
    const viewer = await person("rv", "Vee");
    await addMember(wsOf(owner.id), viewer.id, "viewer");
    await body(await api(viewer.id, `/api/projects/${projectId}/reviews`, { method: "POST", headers: { "x-workspace-id": wsOf(owner.id) }, json: { kind: "version", nodeId } }), 403);
    // Viewers can list them.
    await body(await api(viewer.id, `/api/projects/${projectId}/reviews`, { headers: { "x-workspace-id": wsOf(owner.id) } }), 200);
  });

  it("guards mature content: explicit owner confirmation, mature-allowed owner, and only mature-allowed viewers see it", async () => {
    const owner = await person("mo", "Max Owner");
    const editor = await person("me", "Ed");
    const { projectId, nodeId } = await seedProject(owner.id);
    await addMember(wsOf(owner.id), editor.id, "editor");
    const assetId = await addAsset(wsOf(owner.id), owner.id, { mature: true });
    const v = await projectRoom(env, projectId).addVersion({ nodeId, assetId, inputDigest: "dg_m", rating: "explicit" });
    if (!v.ok) throw new Error("addVersion failed");
    const url = `/api/projects/${projectId}/reviews`;

    // No confirmation → 409; owner without D-005 access → 403 even when confirming; editors never.
    const needs = await body(await api(owner.id, url, { method: "POST", json: { kind: "version", nodeId } }), 403);
    expect(needs.error.data.reason).toBe("MATURE_NOT_ALLOWED");
    await body(await api(editor.id, url, { method: "POST", headers: { "x-workspace-id": wsOf(owner.id) }, json: { kind: "version", nodeId, confirmMature: true } }), 403);

    // Owner becomes mature-allowed (active plan, preference on, workspace allows).
    await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, updated_at, seats) VALUES (?1, ?2, 'pro', 'month', 'active', ?3, 0, 1)")
      .bind(`sub_${crypto.randomUUID()}`, wsOf(owner.id), Date.now() + 30 * 86_400_000)
      .run();
    await env.DB.prepare("UPDATE user_prefs SET mature_content = 1 WHERE user_id = ?").bind(owner.id).run();
    const confirm = await body(await api(owner.id, url, { method: "POST", json: { kind: "version", nodeId } }), 409);
    expect(confirm.error).toMatchObject({ code: "MATURE_CONFIRM_REQUIRED", data: { items: ["i1"] } });
    const created = await body(await api(owner.id, url, { method: "POST", json: { kind: "version", nodeId, confirmMature: true } }), 201);
    expect(created.review.mature).toBe(true);
    const token = created.review.url.split("/review/")[1];

    // Anonymous reviewers: withheld, no URL.
    const anon = await body(await api(null, `/api/review/${token}`), 200);
    expect(anon.items[0]).toMatchObject({ withheld: "mature", media: null, mature: true });
    expect(anon.viewerMatureAllowed).toBe(false);
    // A signed-in member without mature access: withheld too.
    const plain = await person("mp", "Plain");
    expect((await body(await api(plain.id, `/api/review/${token}`), 200)).items[0].withheld).toBe("mature");
    // A signed-in mature-allowed viewer sees it.
    const seen = await body(await api(owner.id, `/api/review/${token}`), 200);
    expect(seen.items[0]).toMatchObject({ withheld: null });
    expect(seen.items[0].media.url).toMatch(/sig=/);

    // An item marked mature after a non-mature link was made is withheld for everyone.
    const safeAsset = await addAsset(wsOf(owner.id), owner.id);
    const v2 = await projectRoom(env, projectId).addVersion({ nodeId, assetId: safeAsset, inputDigest: "dg_s", rating: "safe" });
    if (!v2.ok) throw new Error("addVersion failed");
    const safeLink = await body(await api(owner.id, url, { method: "POST", json: { kind: "version", nodeId, versionId: v2.version.id } }), 201);
    expect(safeLink.review.mature).toBe(false);
    await env.DB.prepare("UPDATE assets SET mature = 1 WHERE id = ?").bind(safeAsset).run();
    const later = await body(await api(owner.id, `/api/review/${safeLink.review.url.split("/review/")[1]}`), 200);
    expect(later.items[0].withheld).toBe("mature");
  });
});
