import { DurableObject } from "cloudflare:workers";
import { AGENT_ABUSE_LIMIT, slidingWindowTake } from "@rolling/core";
import { roleAtLeast, isRole } from "@rolling/core/auth/roles";
import {
  channelEnvelope,
  GatewayPatchPayload,
  ProjectRefPayload,
  SubscribePayload,
  TimelinePatchPayload,
} from "@rolling/core/graph";
import { projectRoom } from "../lib/access";
import { envelope, parseEnvelope, type ServerMessageType } from "../ws/envelope";
import { projectIdForCanvas, type PatchOk, type RoomCaller, type RoomError } from "./ProjectRoom";

/** Membership is re-read from D1 before a write when the cached check is older than this. */
const MEMBERSHIP_TTL_MS = 60_000;

interface Subscription {
  workspaceId: string;
  canEdit: boolean;
  checkedAt: number;
}

/** Per-socket state, kept in the hibernation attachment (nothing lives only in memory). */
interface SocketState {
  userId: string;
  connId: string;
  subs: Record<string, Subscription>;
}

/**
 * One instance per user (`idFromName(userId)`) and, since D-014, the user's
 * WebSocket gateway: every browser holds one socket to `/api/ws` (in a
 * SharedWorker).
 *
 * - User channel (`channel: 'user'`): credits.changed, prefs.changed,
 *   activity.updated, agent.allowance, notification and Home agent streams go
 *   to every socket of the user (`broadcast`).
 * - Project channel (`channel: 'project'`, `projectId`, `seq`): a socket
 *   `subscribe`s to projects (workspace membership checked in D1); the hub
 *   registers itself with the ProjectRoom, which fans out its events to the
 *   hub (`deliver`), and the hub forwards them to the subscribed sockets.
 *   `patch`, `undo`, `redo`, `timeline.patch` and `snapshot` are forwarded to
 *   the room as the user and answered with the client message id.
 *
 * Hibernation: subscriptions live in socket attachments, so a hub woken by a
 * `deliver` RPC or a message finds them again.
 */
export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get("x-user-id");
    if (!userId) return new Response("Missing user", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.serializeAttachment({ userId, connId, subs: {} } satisfies SocketState);
    server.send(channelEnvelope("hello", { userId, connId, connectedAt: Date.now() }, { channel: "user" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (raw === "ping") return;
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }, parsed.id));
      return;
    }
    const msg = parsed.message;
    const state = this.stateOf(ws);
    if (!state) {
      ws.close(4401, "Unknown socket");
      return;
    }
    switch (msg.type) {
      case "ping":
        ws.send(envelope("pong", null, msg.id));
        return;
      case "subscribe":
        return this.subscribe(ws, state, msg.id, msg.payload);
      case "unsubscribe":
        return this.unsubscribe(ws, state, msg.id, msg.payload);
      case "patch":
      case "undo":
      case "redo":
      case "snapshot":
      case "timeline.patch":
        return this.forward(ws, state, msg.type, msg.id, msg.payload);
      default:
        ws.send(envelope("error", { code: "UNKNOWN_TYPE", message: `Unknown message type: ${msg.type}` }, msg.id));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = this.stateOf(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    if (state) await this.releaseProjects(ws, state.userId, Object.keys(state.subs));
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const state = this.stateOf(ws);
    try {
      ws.close(1011, "Socket error");
    } catch {
      // Already closed.
    }
    if (state) await this.releaseProjects(ws, state.userId, Object.keys(state.subs));
  }

  // ---------------------------------------------------------------- user channel

  /** RPC: push one envelope to every socket of this user (`channel: 'user'`). Returns the number of sockets reached. */
  async broadcast(type: ServerMessageType, payload: unknown): Promise<number> {
    const message = channelEnvelope(type, payload, { channel: "user" });
    let sent = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        sent++;
      } catch {
        // Socket is closing.
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------- project channel (D-014)

  /**
   * RPC from ProjectRoom: one project event for the sockets subscribed to
   * `projectId` (except the connection that sent the command, which got an
   * `ack`). `subscribed: false` tells the room to drop this hub. `drop` ends
   * the subscriptions (project deleted).
   */
  async deliver(input: { projectId: string; type: ServerMessageType; payload: unknown; seq?: number; exceptConn?: string; drop?: boolean }): Promise<{ subscribed: boolean }> {
    const message = channelEnvelope(input.type, input.payload, { channel: "project", projectId: input.projectId, ...(input.seq !== undefined ? { seq: input.seq } : {}) });
    let subscribed = false;
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.stateOf(socket);
      if (!state?.subs[input.projectId]) continue;
      subscribed = true;
      if (input.drop) {
        delete state.subs[input.projectId];
        socket.serializeAttachment(state);
      }
      if (state.connId === input.exceptConn) continue;
      try {
        socket.send(message);
      } catch {
        // Socket is closing.
      }
    }
    return { subscribed: subscribed && !input.drop };
  }

  private async subscribe(ws: WebSocket, state: SocketState, id: string, raw: unknown): Promise<void> {
    const parsed = SubscribePayload.safeParse(raw);
    if (!parsed.success) return this.fail(ws, id, null, "BAD_MESSAGE", "Invalid subscribe payload");
    const { projectId, lastRevision, lastSeq } = parsed.data;
    const access = await this.membership(state.userId, projectId);
    if (!access) return this.fail(ws, id, projectId, "NOT_FOUND", "Project not found");
    // Mark the socket subscribed first: events the room sends while it answers are forwarded
    // (clients buffer them and drop those with seq <= `subscribed.seq`).
    const marked = this.stateOf(ws) ?? state;
    marked.subs[projectId] = { ...access, checkedAt: Date.now() };
    ws.serializeAttachment(marked);
    const res = await projectRoom(this.env, projectId).hubSubscribe(this.caller(state.userId, access), {
      ...(lastRevision !== undefined ? { lastRevision } : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
    });
    if (!res.ok) {
      const fresh = this.stateOf(ws);
      if (fresh) {
        delete fresh.subs[projectId];
        ws.serializeAttachment(fresh);
      }
      return this.fail(ws, id, projectId, res.code, res.message);
    }
    const { ok: _ok, ...body } = res;
    ws.send(channelEnvelope("subscribed", { ...body, canEdit: access.canEdit }, { channel: "project", projectId, seq: res.seq }, id));
  }

  private async unsubscribe(ws: WebSocket, state: SocketState, id: string, raw: unknown): Promise<void> {
    const parsed = ProjectRefPayload.safeParse(raw);
    if (!parsed.success) return this.fail(ws, id, null, "BAD_MESSAGE", "Invalid unsubscribe payload");
    const { projectId } = parsed.data;
    if (state.subs[projectId]) {
      delete state.subs[projectId];
      ws.serializeAttachment(state);
      await this.releaseProjects(ws, state.userId, [projectId]);
    }
    ws.send(channelEnvelope("unsubscribed", { projectId }, { channel: "project", projectId }, id));
  }

  /** Commands for a subscribed project, run in ProjectRoom as the user. */
  private async forward(ws: WebSocket, state: SocketState, type: "patch" | "undo" | "redo" | "snapshot" | "timeline.patch", id: string, raw: unknown): Promise<void> {
    let projectId: string;
    let payload: { baseRevision: number; ops?: unknown; canvasId?: string } | null = null;
    if (type === "patch") {
      const p = GatewayPatchPayload.safeParse(raw);
      if (!p.success) return this.fail(ws, id, null, "BAD_MESSAGE", "Invalid patch payload");
      projectId = p.data.projectId;
      payload = p.data;
    } else if (type === "timeline.patch") {
      const p = TimelinePatchPayload.safeParse(raw);
      const pid = p.success ? projectIdForCanvas(p.data.canvasId) : null;
      if (!p.success || !pid) return this.fail(ws, id, null, "BAD_MESSAGE", "Invalid timeline patch payload");
      projectId = pid;
      payload = p.data;
    } else {
      const p = ProjectRefPayload.safeParse(raw);
      if (!p.success) return this.fail(ws, id, null, "BAD_MESSAGE", `Invalid ${type} payload`);
      projectId = p.data.projectId;
    }
    if (!state.subs[projectId]) return this.fail(ws, id, projectId, "NOT_SUBSCRIBED", "Subscribe to the project first");
    const sub = await this.freshSubscription(ws, state, projectId, type !== "snapshot");
    if (!sub) return this.fail(ws, id, projectId, "NOT_FOUND", "Project not found");
    const room = projectRoom(this.env, projectId);
    const caller = this.caller(state.userId, sub);
    const except = { userId: state.userId, connId: state.connId };
    const route = { channel: "project" as const, projectId };
    switch (type) {
      case "snapshot": {
        const snap = await room.getSnapshot(caller);
        if ("ok" in snap && snap.ok === false) return this.fail(ws, id, projectId, snap.code, snap.message);
        ws.send(channelEnvelope("snapshot", snap, route, id));
        return;
      }
      case "patch": {
        const result = await room.applyPatch(caller, { baseRevision: payload!.baseRevision, ops: payload!.ops as unknown[], origin: "user" }, { except });
        return this.reply(ws, id, projectId, result, false);
      }
      case "undo":
      case "redo": {
        const result = type === "undo" ? await room.undo(caller, { except }) : await room.redo(caller, { except });
        return this.reply(ws, id, projectId, result, true);
      }
      case "timeline.patch": {
        const result = await room.patchTimeline(caller, { canvasId: payload!.canvasId, baseRevision: payload!.baseRevision, ops: payload!.ops });
        if (result.ok) ws.send(channelEnvelope("ack", { revision: result.timeline.revision, canvasId: result.timeline.canvasId }, route, id));
        else if (result.code === "CONFLICT") ws.send(channelEnvelope("conflict", { timeline: result.timeline }, route, id));
        else this.fail(ws, id, projectId, result.code, result.message);
        return;
      }
    }
  }

  /** Same reply shapes as the project socket: `ack`, `conflict { snapshot }` or `error`. */
  private reply(ws: WebSocket, id: string, projectId: string, result: PatchOk | RoomError, withOps: boolean): void {
    const route = { channel: "project" as const, projectId };
    if (result.ok) {
      ws.send(
        channelEnvelope(
          "ack",
          withOps ? { revision: result.revision, ops: result.ops, statuses: result.statuses } : { revision: result.revision, idMap: result.idMap, statuses: result.statuses },
          route,
          id,
        ),
      );
      return;
    }
    if (result.code === "CONFLICT") {
      ws.send(channelEnvelope("conflict", { snapshot: result.snapshot ?? null }, route, id));
      return;
    }
    const code = result.refusal?.code ?? result.code;
    ws.send(channelEnvelope("error", { projectId, code, message: result.message, ...(result.refusal ? { data: result.refusal } : {}) }, route, id));
  }

  /** Per-subscription error (the connection stays open). */
  private fail(ws: WebSocket, id: string, projectId: string | null, code: string, message: string): void {
    ws.send(
      projectId
        ? channelEnvelope("error", { projectId, code, message }, { channel: "project", projectId }, id)
        : envelope("error", { code, message }, id),
    );
  }

  /** The socket's subscription, with membership re-read before writes when the cached check is stale. */
  private async freshSubscription(ws: WebSocket, state: SocketState, projectId: string, write: boolean): Promise<Subscription | null> {
    const sub = state.subs[projectId];
    if (!sub) return null;
    if (!write || Date.now() - sub.checkedAt < MEMBERSHIP_TTL_MS) return sub;
    const access = await this.membership(state.userId, projectId);
    const fresh = this.stateOf(ws) ?? state;
    if (!access) {
      delete fresh.subs[projectId];
      ws.serializeAttachment(fresh);
      await this.releaseProjects(ws, state.userId, [projectId]);
      return null;
    }
    fresh.subs[projectId] = { ...access, checkedAt: Date.now() };
    ws.serializeAttachment(fresh);
    return fresh.subs[projectId]!;
  }

  /** Tells rooms this hub is gone for projects no other socket of the user still follows. */
  private async releaseProjects(origin: WebSocket, userId: string, projectIds: string[]): Promise<void> {
    if (!projectIds.length) return;
    const stillFollowed = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === origin) continue;
      for (const p of Object.keys(this.stateOf(socket)?.subs ?? {})) stillFollowed.add(p);
    }
    await Promise.all(
      projectIds.filter((p) => !stillFollowed.has(p)).map((p) => projectRoom(this.env, p).hubUnsubscribe(userId).catch(() => undefined)),
    );
  }

  /** Workspace and edit right of the user on a project (missing and foreign projects look the same). */
  private async membership(userId: string, projectId: string): Promise<Omit<Subscription, "checkedAt"> | null> {
    const row = await this.env.DB.prepare(
      "SELECT p.workspace_id, m.role FROM projects p JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ?1 WHERE p.id = ?2",
    )
      .bind(userId, projectId)
      .first<{ workspace_id: string; role: string }>();
    if (!row || !isRole(row.role)) return null;
    return { workspaceId: row.workspace_id, canEdit: roleAtLeast(row.role, "editor") };
  }

  private caller(userId: string, sub: Omit<Subscription, "checkedAt">): RoomCaller {
    return { userId, workspaceId: sub.workspaceId, canEdit: sub.canEdit };
  }

  private stateOf(ws: WebSocket): SocketState | null {
    const s = ws.deserializeAttachment() as Partial<SocketState> | null;
    if (!s || typeof s.userId !== "string") return null;
    return { userId: s.userId, connId: typeof s.connId === "string" ? s.connId : "", subs: s.subs ?? {} };
  }

  // ---------------------------------------------------------------- agent abuse limit

  /**
   * RPC: takes one turn slot of the per-user abuse limit for unmetered agent
   * LLMs (D-012 amendment: 300 turns per rolling hour). Serialized by the DO.
   */
  async takeAgentTurnSlot(now = Date.now()): Promise<{ ok: true; remaining: number } | { ok: false; retryAfter: number }> {
    const prev = (await this.ctx.storage.get<number[]>("agent_turns")) ?? [];
    const r = slidingWindowTake(prev, now, AGENT_ABUSE_LIMIT.turns, AGENT_ABUSE_LIMIT.windowMs);
    if (!r.ok) return { ok: false, retryAfter: r.retryAfter };
    await this.ctx.storage.put("agent_turns", r.timestamps);
    return { ok: true, remaining: r.remaining };
  }
}
