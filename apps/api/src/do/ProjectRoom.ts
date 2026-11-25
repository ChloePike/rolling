import { DurableObject } from "cloudflare:workers";
import { migrateDurableObject } from "@rolling/db/do/migrate";
import { projectMigrations } from "@rolling/db/do/project";
import {
  envelope,
  parseEnvelope,
  PatchPayload,
  type EdgeRow,
  type GraphState,
  type GroupRow,
  type NodeRow,
  type NodeStatus,
  type ProjectSnapshot,
  type ServerMessageType,
} from "@rolling/core/graph";
import {
  applyGraphOps,
  assembleFromGraph,
  computeInputDigests,
  derivedStatus,
  diffGraph,
  parseOps,
  parseTimelineOps,
  planRun as planGraphRun,
  reassemble,
  type NodeFlags,
  type PlanItem,
  type RoomOp,
  type RunScope,
  type ServerRefusal,
} from "@rolling/core/project";
import { applyOps as applyTimelineOps, type Edl, type TimelineOp } from "@rolling/core/timeline";
import { newId } from "@rolling/core/ids";

/** Who is calling a ProjectRoom RPC. The Worker resolves it from the auth context; the DO re-checks the workspace. */
export interface RoomCaller {
  userId: string;
  workspaceId: string;
  canEdit: boolean;
}

export type Origin = "user" | "agent";

export interface RoomError {
  ok: false;
  code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "REFUSED" | "NOTHING_TO_UNDO" | "NOTHING_TO_REDO" | "TIMELINE_INVALID";
  message: string;
  refusal?: ServerRefusal;
  snapshot?: RoomSnapshot;
  timeline?: TimelineState;
}

export interface PatchOk {
  ok: true;
  revision: number;
  /** Normalized ops (final ids), exactly as broadcast in `graph.patched`. */
  ops: RoomOp[];
  idMap: Record<string, string>;
  /** Nodes whose derived status changed (staleness), node id → status. */
  statuses: Record<string, NodeStatus>;
}

export interface VersionInfo {
  id: string;
  nodeId: string;
  n: number;
  assetId: string | null;
  output: unknown;
  inputDigest: string;
  model: string | null;
  jobId: string | null;
  createdAt: number;
  active: boolean;
  /** Made with inputs that differ from the node's current inputs ("Input changed"). */
  stale: boolean;
}

export interface TimelineState {
  canvasId: string;
  revision: number;
  edl: Edl;
}

/** Node row with the runtime fields ProjectRoom fills in (versions, active asset). */
export interface RoomNodeRow extends NodeRow {
  asset_id?: string | null;
}

export interface RoomSnapshot extends ProjectSnapshot {
  title: string | null;
  workspaceId: string | null;
  nodes: RoomNodeRow[];
  groups: GroupRow[];
  timeline: TimelineState | null;
}

interface SocketInfo {
  userId: string;
  canEdit: boolean;
}

interface ActiveVersion {
  versionId: string;
  digest: string;
  n: number;
  total: number;
  assetId: string | null;
  createdAt: number;
}

/** Debounce for the D1 projects index (title, updated_at, node_count, thumbnail). */
export const INDEX_DEBOUNCE_MS = 2000;

/** `prj_<ULID>` → `cnv_<ULID>`: one canvas per project for now, with a globally unique id. */
export function canvasIdFor(projectId: string): string {
  return projectId.startsWith("prj_") ? `cnv_${projectId.slice(4)}` : `cnv_${projectId}`;
}

export function projectIdForCanvas(canvasId: string): string | null {
  return /^cnv_[A-Za-z0-9]+$/.test(canvasId) ? `prj_${canvasId.slice(4)}` : null;
}

/**
 * One instance per project. Serializes graph and timeline edits (one SQLite
 * transaction per patch), keeps revisions, the patch log (undo/redo), node
 * versions and staleness, and fans changes out over hibernating WebSockets.
 * Mirrors the project into the D1 `projects` index after commits (debounced alarm).
 */
export class ProjectRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage, projectMigrations);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates the room for a new project. Idempotent; template ops are applied as revision 1 by `system`. */
  async init(input: { projectId: string; workspaceId: string; title: string; createdBy: string; ops?: RoomOp[] }): Promise<{ revision: number }> {
    const existing = this.getMeta("workspace_id");
    if (existing) {
      if (existing !== input.workspaceId) throw new Error("Project belongs to another workspace");
      return { revision: this.revision() };
    }
    this.ctx.storage.transactionSync(() => {
      this.setMeta("project_id", input.projectId);
      this.setMeta("workspace_id", input.workspaceId);
      this.setMeta("title", input.title);
      this.setMeta("created_by", input.createdBy);
      this.setMeta("canvas_id", canvasIdFor(input.projectId));
      this.setMeta("revision", "0");
      this.setMeta("updated_at", String(Date.now()));
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO canvases (id, title, viewport) VALUES (?, 'Main', NULL)", canvasIdFor(input.projectId));
    });
    if (input.ops?.length) {
      const result = this.commit({ userId: "system", ops: input.ops, origin: "user", kind: "patch", base: 0 });
      if (!result.ok) throw new Error(`Template could not be applied: ${result.message}`);
    }
    return { revision: this.revision() };
  }

  async setTitle(caller: RoomCaller, title: string): Promise<{ ok: true } | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    this.setMeta("title", title);
    this.setMeta("updated_at", String(Date.now()));
    return { ok: true };
  }

  /** Deletes everything (project deleted). Open sockets are closed with 4410. */
  async destroy(caller: RoomCaller): Promise<{ ok: true } | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(envelope("error", { code: "PROJECT_DELETED", message: "This project was deleted" }));
        ws.close(4410, "Project deleted");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  // ---------------------------------------------------------------- graph

  async getSnapshot(caller: RoomCaller): Promise<RoomSnapshot | RoomError> {
    return this.check(caller, false) ?? this.snapshot();
  }

  /** Current graph (GraphState) with active version assets, for quotes, sharing and the agent. */
  async getGraph(caller: RoomCaller): Promise<{ state: GraphState; assets: Record<string, string> } | RoomError> {
    const denied = this.check(caller, false);
    if (denied) return denied;
    const state = this.loadState();
    const assets: Record<string, string> = {};
    for (const [nodeId, v] of this.activeVersions()) if (v.assetId) assets[nodeId] = v.assetId;
    return { state, assets };
  }

  async applyPatch(caller: RoomCaller, patch: { baseRevision: number; ops: unknown[]; origin?: Origin }): Promise<PatchOk | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    const parsed = parseOps(patch.ops);
    if (!parsed.ok) return { ok: false, code: "REFUSED", message: parsed.refusal.message, refusal: parsed.refusal };
    const result = this.commit({ userId: caller.userId, ops: parsed.ops, origin: patch.origin ?? "user", kind: "patch", base: patch.baseRevision });
    if (result.ok) this.afterCommit(result, caller.userId, patch.origin ?? "user", null);
    return result;
  }

  async undo(caller: RoomCaller): Promise<PatchOk | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    const result = this.undoRedo(caller.userId, "undo");
    if (result.ok) this.afterCommit(result, caller.userId, "user", null, "undo");
    return result;
  }

  async redo(caller: RoomCaller): Promise<PatchOk | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    const result = this.undoRedo(caller.userId, "redo");
    if (result.ok) this.afterCommit(result, caller.userId, "user", null, "redo");
    return result;
  }

  // ---------------------------------------------------------------- versions

  /**
   * Records a generated output as the node's new active version (called by the
   * Generate workflow's `commit` step with the digest the run was quoted with).
   * Broadcasts `node.version`; downstream nodes become "Input changed".
   */
  async addVersion(input: {
    nodeId: string;
    assetId: string | null;
    inputDigest: string;
    model?: string | null;
    jobId?: string | null;
    output?: unknown;
  }): Promise<{ ok: true; version: VersionInfo; statuses: Record<string, NodeStatus> } | RoomError> {
    const sql = this.ctx.storage.sql;
    const result = this.ctx.storage.transactionSync(() => {
      const node = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id = ?", input.nodeId).toArray()[0];
      if (!node) return null;
      const n = Number(sql.exec<{ n: number }>("SELECT COALESCE(MAX(n), 0) AS n FROM node_versions WHERE node_id = ?", input.nodeId).one().n) + 1;
      const id = newId("version");
      const now = Date.now();
      sql.exec(
        "INSERT INTO node_versions (id, node_id, n, asset_id, output, input_digest, model, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.nodeId,
        n,
        input.assetId,
        input.output === undefined ? null : JSON.stringify(input.output),
        input.inputDigest,
        input.model ?? null,
        input.jobId ?? null,
        now,
      );
      // A finished run always leaves the runtime states; staleness decides done vs outdated.
      sql.exec("UPDATE nodes SET active_version_id = ?, status = 'idle', updated_at = ? WHERE id = ?", id, now, input.nodeId);
      const statuses = this.recomputeStatuses(this.loadState());
      this.touch();
      return { id, statuses };
    });
    if (!result) return { ok: false, code: "NOT_FOUND", message: "Node not found" };
    const version = this.versionsOf(input.nodeId).find((v) => v.id === result.id)!;
    this.fanOut(envelope("node.version", { nodeId: input.nodeId, version: this.versionPayload(version), statuses: result.statuses }));
    void this.scheduleIndex();
    return { ok: true, version, statuses: result.statuses };
  }

  /** The node's current input digest: what a run started now would record. */
  async inputDigest(caller: RoomCaller, nodeId: string): Promise<{ ok: true; digest: string } | RoomError> {
    const denied = this.check(caller, false);
    if (denied) return denied;
    const digest = this.currentDigests().get(nodeId);
    return digest ? { ok: true, digest } : { ok: false, code: "NOT_FOUND", message: "Node not found" };
  }

  async listVersions(caller: RoomCaller, nodeId: string): Promise<{ ok: true; versions: VersionInfo[]; activeVersionId: string | null } | RoomError> {
    const denied = this.check(caller, false);
    if (denied) return denied;
    const node = this.ctx.storage.sql.exec<{ active_version_id: string | null }>("SELECT active_version_id FROM nodes WHERE id = ?", nodeId).toArray()[0];
    if (!node) return { ok: false, code: "NOT_FOUND", message: "Node not found" };
    return { ok: true, versions: this.versionsOf(nodeId), activeVersionId: node.active_version_id };
  }

  async setActiveVersion(caller: RoomCaller, nodeId: string, versionId: string): Promise<{ ok: true; version: VersionInfo; statuses: Record<string, NodeStatus> } | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    const sql = this.ctx.storage.sql;
    const statuses = this.ctx.storage.transactionSync(() => {
      const v = sql.exec<{ id: string }>("SELECT id FROM node_versions WHERE id = ? AND node_id = ?", versionId, nodeId).toArray()[0];
      const node = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id = ?", nodeId).toArray()[0];
      if (!v || !node) return null;
      sql.exec(
        "UPDATE nodes SET active_version_id = ?, status = CASE WHEN status IN ('queued','generating') THEN status ELSE 'idle' END, updated_at = ? WHERE id = ?",
        versionId,
        Date.now(),
        nodeId,
      );
      const s = this.recomputeStatuses(this.loadState());
      this.touch();
      return s;
    });
    if (!statuses) return { ok: false, code: "NOT_FOUND", message: "Version not found" };
    const version = this.versionsOf(nodeId).find((v) => v.id === versionId)!;
    this.fanOut(envelope("node.version", { nodeId, version: this.versionPayload(version), statuses }));
    void this.scheduleIndex();
    return { ok: true, version, statuses };
  }

  // ---------------------------------------------------------------- runs (M4)

  /**
   * What a run of `scope` would do, per node: run / reuse / blocked / bypassed / none,
   * with the input digest each new version must record and the upstream it waits for.
   * Pricing happens in the quote route (CreditAccount).
   */
  async planRun(caller: RoomCaller, input: { scope: RunScope; nodeIds?: string[] }): Promise<{ ok: true; revision: number; items: PlanItem[] } | RoomError> {
    const denied = this.check(caller, false);
    if (denied) return denied;
    const state = this.loadState();
    const active = this.activeVersions();
    const digests = computeInputDigests(state, new Map([...active].map(([k, v]) => [k, v.versionId])));
    const items = planGraphRun(
      state,
      new Map([...active].map(([k, v]) => [k, { versionId: v.versionId, digest: v.digest, assetId: v.assetId }])),
      digests,
      input.scope,
      input.nodeIds ?? [],
    );
    return { ok: true, revision: state.revision, items };
  }

  /** A job for the node was queued or reports progress (0..1): runtime state, not revisioned. Broadcasts `job.progress`. */
  async markRunning(input: { nodeId: string; jobId: string; progress?: number; status?: "queued" | "generating" }): Promise<{ ok: boolean }> {
    const status = input.status ?? "generating";
    const hit = this.ctx.storage.sql.exec("UPDATE nodes SET status = ? WHERE id = ?", status, input.nodeId).rowsWritten > 0;
    if (!hit) return { ok: false };
    this.fanOut(envelope("job.progress", { jobId: input.jobId, nodeId: input.nodeId, progress: input.progress ?? 0, status }));
    return { ok: true };
  }

  /** A run item waits for inputs or a free slot: node shows queued; broadcasts `job.queued`. */
  async markQueued(input: { nodeId: string; jobId: string; reason?: string }): Promise<{ ok: boolean }> {
    const hit = this.ctx.storage.sql.exec("UPDATE nodes SET status = 'queued' WHERE id = ?", input.nodeId).rowsWritten > 0;
    if (!hit) return { ok: false };
    this.fanOut(envelope("job.queued", { jobId: input.jobId, nodeId: input.nodeId, ...(input.reason ? { reason: input.reason } : {}) }));
    return { ok: true };
  }

  /**
   * Clears a runtime state (failed, canceled, queued, generating) back to the
   * derived one: done / outdated with a version, else idle. Use for canceled
   * items instead of markFailed. Broadcasts `node.version { nodeId, version, status, statuses }`.
   */
  async resetNode(input: { nodeId: string; reason?: "canceled" | "retry" | "reset" }): Promise<{ ok: boolean; status?: NodeStatus }> {
    const sql = this.ctx.storage.sql;
    const result = this.ctx.storage.transactionSync(() => {
      if (sql.exec("UPDATE nodes SET status = 'idle' WHERE id = ?", input.nodeId).rowsWritten === 0) return null;
      const statuses = this.recomputeStatuses(this.loadState());
      const status = (sql.exec<{ status: NodeStatus }>("SELECT status FROM nodes WHERE id = ?", input.nodeId).one().status) as NodeStatus;
      return { statuses: { ...statuses, [input.nodeId]: status }, status };
    });
    if (!result) return { ok: false };
    const active = this.activeVersions().get(input.nodeId);
    this.fanOut(
      envelope("node.version", {
        nodeId: input.nodeId,
        version: active ? { id: active.versionId, n: active.n, total: active.total, assetId: active.assetId } : null,
        status: result.status,
        statuses: result.statuses,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    );
    return { ok: true, status: result.status };
  }

  /** A job failed: node shows failed with the refund; broadcasts `job.failed`. */
  async markFailed(input: { nodeId: string; jobId: string; refunded: number; reason: string }): Promise<{ ok: boolean }> {
    const hit = this.ctx.storage.sql.exec("UPDATE nodes SET status = 'failed', updated_at = ? WHERE id = ?", Date.now(), input.nodeId).rowsWritten > 0;
    if (!hit) return { ok: false };
    this.fanOut(envelope("job.failed", { jobId: input.jobId, nodeId: input.nodeId, refunded: input.refunded, reason: input.reason }));
    return { ok: true };
  }

  /**
   * Sends a server message to every open socket of the project (job.progress,
   * job.done, credits.changed, proposal.created, agent.delta, ...). Trusted
   * callers only (workflows, AgentSession); never exposed to clients.
   */
  async broadcast(type: ServerMessageType, payload: unknown): Promise<{ sent: number }> {
    const message = envelope(type, payload);
    this.fanOut(message);
    return { sent: this.ctx.getWebSockets().length };
  }

  // ---------------------------------------------------------------- timeline

  async getTimeline(caller: RoomCaller, canvasId?: string): Promise<{ ok: true; timeline: TimelineState } | RoomError> {
    const denied = this.check(caller, false) ?? this.checkCanvas(canvasId);
    if (denied) return denied;
    return { ok: true, timeline: this.ensureTimeline() };
  }

  async patchTimeline(caller: RoomCaller, patch: { canvasId?: string; baseRevision: number; ops: unknown }): Promise<{ ok: true; timeline: TimelineState; ops: TimelineOp[] } | RoomError> {
    const denied = this.check(caller, true) ?? this.checkCanvas(patch.canvasId);
    if (denied) return denied;
    const parsed = parseTimelineOps(patch.ops);
    if (!parsed.ok) return { ok: false, code: "TIMELINE_INVALID", message: parsed.message };
    const result = this.ctx.storage.transactionSync((): { ok: true; timeline: TimelineState } | RoomError => {
      const current = this.ensureTimeline();
      if (patch.baseRevision !== current.revision) {
        return { ok: false, code: "CONFLICT", message: "Timeline changed since your last update", timeline: current };
      }
      const applied = applyTimelineOps(current.edl, parsed.ops);
      if (!applied.ok) return { ok: false, code: "TIMELINE_INVALID", message: applied.error };
      const timeline = { canvasId: current.canvasId, revision: current.revision + 1, edl: applied.edl };
      this.saveTimeline(timeline);
      return { ok: true, timeline };
    });
    if (!result.ok) return result;
    this.fanOut(
      envelope("timeline.patched", { canvasId: result.timeline.canvasId, revision: result.timeline.revision, ops: parsed.ops, actor: "user", userId: caller.userId }),
    );
    void this.scheduleIndex();
    return { ok: true, timeline: result.timeline, ops: parsed.ops };
  }

  /** Rebuilds the cut from the graph, keeping manual trims where shots match. Broadcast with the full EDL. */
  async reassembleTimeline(caller: RoomCaller, canvasId?: string): Promise<{ ok: true; timeline: TimelineState } | RoomError> {
    const denied = this.check(caller, true) ?? this.checkCanvas(canvasId);
    if (denied) return denied;
    const timeline = this.ctx.storage.transactionSync(() => {
      const current = this.ensureTimeline();
      const assets = this.activeVersions();
      const edl = reassemble(current.edl, this.loadState(), (id) => assets.get(id)?.assetId ?? null);
      const next = { canvasId: current.canvasId, revision: current.revision + 1, edl };
      this.saveTimeline(next);
      return next;
    });
    this.fanOut(envelope("timeline.patched", { canvasId: timeline.canvasId, revision: timeline.revision, ops: null, edl: timeline.edl, actor: "user", userId: caller.userId }));
    void this.scheduleIndex();
    return { ok: true, timeline };
  }

  // ---------------------------------------------------------------- WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // Identity headers are set by the Worker after it checked the session and membership.
    const userId = request.headers.get("x-user-id");
    const workspaceId = request.headers.get("x-workspace-id");
    const canEdit = request.headers.get("x-can-edit") === "1";
    if (!userId || !workspaceId || this.getMeta("workspace_id") !== workspaceId) {
      return new Response("Project not found", { status: 404 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.serializeAttachment({ userId, canEdit } satisfies SocketInfo);
    server.send(envelope("hello", { actor: userId, canEdit }));
    server.send(envelope("snapshot", this.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (raw === "ping") return; // auto-response handles it outside hibernation wakes
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }, parsed.id));
      return;
    }
    const msg = parsed.message;
    const info = this.socketInfo(ws);
    if (!info) {
      ws.close(4401, "Unknown socket");
      return;
    }
    const caller: RoomCaller = { userId: info.userId, workspaceId: this.getMeta("workspace_id") ?? "", canEdit: info.canEdit };
    switch (msg.type) {
      case "ping":
        ws.send(envelope("pong", null, msg.id));
        return;
      case "snapshot":
        ws.send(envelope("snapshot", this.snapshot(), msg.id));
        return;
      case "patch": {
        const payload = PatchPayload.safeParse(msg.payload);
        if (!payload.success) {
          ws.send(envelope("error", { code: "BAD_MESSAGE", message: "Invalid patch payload" }, msg.id));
          return;
        }
        const origin: Origin = (msg.payload as { origin?: unknown }).origin === "agent" ? "agent" : "user";
        const result = await this.applyPatchFromSocket(caller, payload.data, origin, ws);
        this.reply(ws, msg.id, result, false);
        return;
      }
      case "undo":
      case "redo": {
        const denied = this.check(caller, true);
        const result = denied ?? this.undoRedo(caller.userId, msg.type);
        if (result.ok) this.afterCommit(result, caller.userId, "user", ws, msg.type);
        this.reply(ws, msg.id, result, true);
        return;
      }
      case "timeline.patch": {
        const p = msg.payload as { canvasId?: string; baseRevision?: unknown; ops?: unknown } | null;
        if (!p || typeof p.baseRevision !== "number") {
          ws.send(envelope("error", { code: "BAD_MESSAGE", message: "Invalid timeline patch payload" }, msg.id));
          return;
        }
        const result = await this.patchTimeline(caller, { canvasId: p.canvasId, baseRevision: p.baseRevision, ops: p.ops });
        if (result.ok) ws.send(envelope("ack", { revision: result.timeline.revision, canvasId: result.timeline.canvasId }, msg.id));
        else if (result.code === "CONFLICT") ws.send(envelope("conflict", { timeline: result.timeline }, msg.id));
        else ws.send(envelope("error", { code: result.code, message: result.message }, msg.id));
        return;
      }
      default:
        ws.send(envelope("error", { code: "UNKNOWN_TYPE", message: `Unknown message type: ${msg.type}` }, msg.id));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "Socket error");
    } catch {
      // Already closed.
    }
  }

  // ---------------------------------------------------------------- D1 index

  /** Writes title, updated_at, node_count and thumbnail to the D1 `projects` row. */
  override async alarm(): Promise<void> {
    if (this.getMeta("index_dirty") !== "1") return;
    const projectId = this.getMeta("project_id");
    if (!projectId) return;
    const sql = this.ctx.storage.sql;
    const nodeCount = Number(sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM nodes").one().c);
    const updatedAt = Number(this.getMeta("updated_at") ?? Date.now());
    const thumbKey = await this.pickThumbnail();
    // Clear first: a commit during the D1 write marks dirty again and schedules a new alarm.
    this.setMeta("index_dirty", "0");
    try {
      await this.env.DB.prepare("UPDATE projects SET title = ?, node_count = ?, updated_at = MAX(updated_at, ?), thumb_key = ? WHERE id = ?")
        .bind(this.getMeta("title") ?? "Untitled", nodeCount, updatedAt, thumbKey, projectId)
        .run();
    } catch (err) {
      this.setMeta("index_dirty", "1");
      throw err; // alarms retry with backoff
    }
  }

  /** Test/ops hook: write the index now instead of waiting for the alarm. */
  async flushIndex(): Promise<void> {
    await this.alarm();
  }

  // ---------------------------------------------------------------- internals

  private check(caller: RoomCaller, write: boolean): RoomError | null {
    const ws = this.getMeta("workspace_id");
    if (!ws || caller.workspaceId !== ws) return { ok: false, code: "NOT_FOUND", message: "Project not found" };
    if (write && !caller.canEdit) return { ok: false, code: "FORBIDDEN", message: "You can view this project but not edit it" };
    return null;
  }

  private checkCanvas(canvasId: string | undefined): RoomError | null {
    if (canvasId === undefined || canvasId === this.getMeta("canvas_id")) return null;
    return { ok: false, code: "NOT_FOUND", message: "Canvas not found" };
  }

  private async applyPatchFromSocket(caller: RoomCaller, patch: PatchPayload, origin: Origin, ws: WebSocket): Promise<PatchOk | RoomError> {
    const denied = this.check(caller, true);
    if (denied) return denied;
    const parsed = parseOps(patch.ops);
    if (!parsed.ok) return { ok: false, code: "REFUSED", message: parsed.refusal.message, refusal: parsed.refusal };
    const result = this.commit({ userId: caller.userId, ops: parsed.ops, origin, kind: "patch", base: patch.baseRevision });
    if (result.ok) this.afterCommit(result, caller.userId, origin, ws);
    return result;
  }

  private reply(ws: WebSocket, id: string, result: PatchOk | RoomError, withOps: boolean): void {
    if (result.ok) {
      ws.send(envelope("ack", withOps ? { revision: result.revision, ops: result.ops, statuses: result.statuses } : { revision: result.revision, idMap: result.idMap, statuses: result.statuses }, id));
      return;
    }
    if (result.code === "CONFLICT") {
      ws.send(envelope("conflict", { snapshot: result.snapshot ?? this.snapshot() }, id));
      return;
    }
    const code = result.refusal?.code ?? result.code;
    ws.send(envelope("error", { code, message: result.message, ...(result.refusal ? { data: result.refusal } : {}) }, id));
  }

  /** Broadcast + index after a committed graph patch. `except` (the sender) gets an ack instead. */
  private afterCommit(result: PatchOk, userId: string, origin: Origin, except: WebSocket | null, kind: "patch" | "undo" | "redo" = "patch"): void {
    this.fanOut(
      envelope("graph.patched", {
        revision: result.revision,
        ops: result.ops,
        actor: origin,
        userId,
        ...(kind !== "patch" ? { kind } : {}),
        ...(Object.keys(result.statuses).length ? { statuses: result.statuses } : {}),
      }),
      except ?? undefined,
    );
    void this.scheduleIndex();
  }

  /**
   * Applies ops as one transaction: revision check, GraphOp validation, SQL
   * writes, staleness, patch log. Nothing is written when anything fails.
   */
  private commit(input: {
    userId: string;
    ops: RoomOp[];
    origin: Origin;
    kind: "patch" | "undo" | "redo";
    base: number | null;
    target?: number;
  }): PatchOk | RoomError {
    try {
      return this.ctx.storage.transactionSync((): PatchOk | RoomError => {
        const current = this.revision();
        if (input.base !== null && input.base !== current) {
          return { ok: false, code: "CONFLICT", message: "The project changed since your last update", snapshot: this.snapshot() };
        }
        const before = this.loadState();
        const applied = applyGraphOps(before, input.ops, { actor: input.origin });
        if (!applied.ok) return { ok: false, code: "REFUSED", message: applied.refusal.message, refusal: applied.refusal };
        const inverse = diffGraph(applied.state, before);
        const now = Date.now();
        this.persist(before, applied.state, now);
        const statuses = this.recomputeStatuses(this.loadState());
        const revision = current + 1;
        this.ctx.storage.sql.exec(
          "INSERT INTO patch_log (revision, actor, ops, created_at, kind, inverse, target, undone) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
          revision,
          input.userId,
          JSON.stringify(applied.ops),
          now,
          input.kind,
          JSON.stringify(inverse),
          input.target ?? null,
        );
        this.setMeta("revision", String(revision));
        this.touch(now);
        return { ok: true, revision, ops: applied.ops, idMap: applied.idMap, statuses };
      });
    } catch (err) {
      console.error(JSON.stringify({ msg: "project patch failed", error: String(err) }));
      throw err;
    }
  }

  /**
   * Undo reverts the caller's latest patch (or redo) that is not undone yet;
   * redo re-applies the caller's latest undo, as long as the caller made no
   * new patch since. Both are forward patches with a new revision.
   */
  private undoRedo(userId: string, kind: "undo" | "redo"): PatchOk | RoomError {
    return this.ctx.storage.transactionSync((): PatchOk | RoomError => {
      const sql = this.ctx.storage.sql;
      let row: { revision: number; inverse: string; target: number | null } | undefined;
      if (kind === "undo") {
        row = sql
          .exec<{ revision: number; inverse: string; target: number | null }>(
            "SELECT revision, inverse, target FROM patch_log WHERE actor = ? AND kind IN ('patch','redo') AND undone = 0 ORDER BY revision DESC LIMIT 1",
            userId,
          )
          .toArray()[0];
        if (!row) return { ok: false, code: "NOTHING_TO_UNDO", message: "Nothing to undo" };
      } else {
        const lastPatch = Number(
          sql.exec<{ r: number | null }>("SELECT MAX(revision) AS r FROM patch_log WHERE actor = ? AND kind = 'patch'", userId).one().r ?? 0,
        );
        row = sql
          .exec<{ revision: number; inverse: string; target: number | null }>(
            "SELECT revision, inverse, target FROM patch_log WHERE actor = ? AND kind = 'undo' AND undone = 0 AND revision > ? ORDER BY revision DESC LIMIT 1",
            userId,
            lastPatch,
          )
          .toArray()[0];
        if (!row) return { ok: false, code: "NOTHING_TO_REDO", message: "Nothing to redo" };
      }
      const ops = JSON.parse(row.inverse) as RoomOp[];
      const result = this.commit({ userId, ops, origin: "user", kind, base: null, target: row.revision });
      if (result.ok) sql.exec("UPDATE patch_log SET undone = 1 WHERE revision = ?", row.revision);
      return result;
    });
  }

  private loadState(): GraphState {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<NodeRow & { bypass: number; collapsed: number } & Record<string, SqlStorageValue>>("SELECT * FROM nodes ORDER BY rowid").toArray();
    const edges = sql.exec<EdgeRow & Record<string, SqlStorageValue>>("SELECT * FROM edges ORDER BY rowid").toArray();
    const groups = sql.exec<GroupRow & Record<string, SqlStorageValue>>("SELECT * FROM groups ORDER BY rowid").toArray();
    return {
      revision: this.revision(),
      nodes: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        params: safeJson(r.params),
        position: { x: r.x, y: r.y },
        groupId: r.group_id,
        status: r.status,
        createdBy: r.created_by === "agent" ? "agent" : "user",
        ...(Number(r.bypass) ? { bypass: true } : {}),
        ...(Number(r.collapsed) ? { collapsed: true } : {}),
      })),
      edges: edges.map((e) => {
        const reroutes = parseReroutes(e.reroutes);
        return { id: e.id, from: { node: e.from_node, port: e.from_port }, to: { node: e.to_node, port: e.to_port }, ...(reroutes.length ? { reroutes } : {}) };
      }),
      groups: groups.map((g) => ({ id: g.id, title: g.title, nodeIds: rows.filter((n) => n.group_id === g.id).map((n) => n.id) })),
    };
  }

  /** Writes the difference between two graph states. */
  private persist(before: GraphState, after: GraphState, now: number): void {
    const sql = this.ctx.storage.sql;
    const canvas = this.getMeta("canvas_id") ?? "cnv_main";
    const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
    const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
    for (const n of before.nodes) if (!afterNodes.has(n.id)) sql.exec("DELETE FROM nodes WHERE id = ?", n.id);
    for (const n of after.nodes) {
      const was = beforeNodes.get(n.id);
      const params = JSON.stringify(n.params);
      if (!was) {
        // Re-adding a removed node (undo) restores its latest version.
        sql.exec(
          `INSERT INTO nodes (id, canvas_id, kind, title, params, x, y, group_id, active_version_id, status, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM node_versions WHERE node_id = ? ORDER BY n DESC LIMIT 1), 'idle', ?, ?)`,
          n.id,
          canvas,
          n.kind,
          n.title,
          params,
          n.position.x,
          n.position.y,
          n.groupId,
          n.id,
          n.createdBy,
          now,
        );
      } else if (was.title !== n.title || JSON.stringify(was.params) !== params || was.position.x !== n.position.x || was.position.y !== n.position.y || was.groupId !== n.groupId) {
        sql.exec("UPDATE nodes SET title = ?, params = ?, x = ?, y = ?, group_id = ?, updated_at = ? WHERE id = ?", n.title, params, n.position.x, n.position.y, n.groupId, now, n.id);
      }
      const f = n as typeof n & NodeFlags;
      const w = (was ?? {}) as NodeFlags;
      if (!!f.bypass !== !!w.bypass || !!f.collapsed !== !!w.collapsed) {
        sql.exec("UPDATE nodes SET bypass = ?, collapsed = ?, updated_at = ? WHERE id = ?", f.bypass ? 1 : 0, f.collapsed ? 1 : 0, now, n.id);
      }
    }
    const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
    const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
    const sameEdge = (a: GraphState["edges"][number], b: GraphState["edges"][number]) =>
      a.from.node === b.from.node && a.from.port === b.from.port && a.to.node === b.to.node && a.to.port === b.to.port;
    for (const e of before.edges) {
      const now2 = afterEdges.get(e.id);
      if (!now2 || !sameEdge(e, now2)) sql.exec("DELETE FROM edges WHERE id = ?", e.id);
    }
    const ord = new Map<string, number>();
    for (const e of after.edges) {
      const k = `${e.to.node}\u0000${e.to.port}`;
      const o = ord.get(k) ?? 0;
      ord.set(k, o + 1);
      const was = beforeEdges.get(e.id);
      if (!was || !sameEdge(was, e)) {
        sql.exec(
          "INSERT INTO edges (id, canvas_id, from_node, from_port, to_node, to_port, ord, pinned_version_id, reroutes) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
          e.id,
          canvas,
          e.from.node,
          e.from.port,
          e.to.node,
          e.to.port,
          o,
          e.reroutes?.length ? JSON.stringify(e.reroutes) : null,
        );
      } else {
        sql.exec("UPDATE edges SET ord = ? WHERE id = ? AND ord != ?", o, e.id, o);
        const r = e.reroutes?.length ? JSON.stringify(e.reroutes) : null;
        if (r !== (was.reroutes?.length ? JSON.stringify(was.reroutes) : null)) sql.exec("UPDATE edges SET reroutes = ? WHERE id = ?", r, e.id);
      }
    }
    const beforeGroups = new Map(before.groups.map((g) => [g.id, g]));
    const afterGroups = new Map(after.groups.map((g) => [g.id, g]));
    for (const g of before.groups) if (!afterGroups.has(g.id)) sql.exec("DELETE FROM groups WHERE id = ?", g.id);
    for (const g of after.groups) {
      const was = beforeGroups.get(g.id);
      if (!was) sql.exec("INSERT INTO groups (id, canvas_id, title, color) VALUES (?, ?, ?, NULL)", g.id, canvas, g.title);
      else if (was.title !== g.title) sql.exec("UPDATE groups SET title = ? WHERE id = ?", g.title, g.id);
    }
  }

  private activeVersions(): Map<string, ActiveVersion> {
    const rows = this.ctx.storage.sql
      .exec<{ node_id: string; id: string; input_digest: string; n: number; asset_id: string | null; created_at: number; total: number }>(
        `SELECT v.node_id, v.id, v.input_digest, v.n, v.asset_id, v.created_at,
                (SELECT COUNT(*) FROM node_versions x WHERE x.node_id = v.node_id) AS total
         FROM nodes n JOIN node_versions v ON v.id = n.active_version_id`,
      )
      .toArray();
    return new Map(
      rows.map((r) => [r.node_id, { versionId: r.id, digest: r.input_digest, n: Number(r.n), total: Number(r.total), assetId: r.asset_id, createdAt: Number(r.created_at) }]),
    );
  }

  private currentDigests(): Map<string, string> {
    const active = this.activeVersions();
    return computeInputDigests(this.loadState(), new Map([...active].map(([k, v]) => [k, v.versionId])));
  }

  /** Derives done/outdated/idle from input digests; returns the nodes that changed. */
  private recomputeStatuses(state: GraphState): Record<string, NodeStatus> {
    const active = this.activeVersions();
    const digests = computeInputDigests(state, new Map([...active].map(([k, v]) => [k, v.versionId])));
    const changed: Record<string, NodeStatus> = {};
    for (const n of state.nodes) {
      const next = derivedStatus(n.status, active.get(n.id)?.digest ?? null, digests.get(n.id)!);
      if (next !== n.status) {
        this.ctx.storage.sql.exec("UPDATE nodes SET status = ? WHERE id = ?", next, n.id);
        changed[n.id] = next;
      }
    }
    return changed;
  }

  private versionsOf(nodeId: string): VersionInfo[] {
    const sql = this.ctx.storage.sql;
    const active = sql.exec<{ a: string | null }>("SELECT active_version_id AS a FROM nodes WHERE id = ?", nodeId).toArray()[0]?.a ?? null;
    const digest = this.currentDigests().get(nodeId) ?? null;
    return sql
      .exec<{ id: string; node_id: string; n: number; asset_id: string | null; output: string | null; input_digest: string; model: string | null; job_id: string | null; created_at: number }>(
        "SELECT * FROM node_versions WHERE node_id = ? ORDER BY n DESC",
        nodeId,
      )
      .toArray()
      .map((v) => ({
        id: v.id,
        nodeId: v.node_id,
        n: Number(v.n),
        assetId: v.asset_id,
        output: v.output ? safeJson(v.output) : null,
        inputDigest: v.input_digest,
        model: v.model,
        jobId: v.job_id,
        createdAt: Number(v.created_at),
        active: v.id === active,
        stale: digest !== null && v.input_digest !== digest,
      }));
  }

  private versionPayload(v: VersionInfo) {
    const total = Number(this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM node_versions WHERE node_id = ?", v.nodeId).one().c);
    return { id: v.id, n: v.n, total, assetId: v.assetId, active: v.active, stale: v.stale, createdAt: v.createdAt };
  }

  private snapshot(): RoomSnapshot {
    const sql = this.ctx.storage.sql;
    const active = this.activeVersions();
    const nodes = sql.exec<NodeRow & Record<string, SqlStorageValue>>("SELECT * FROM nodes ORDER BY rowid").toArray().map((r): RoomNodeRow => {
      const v = active.get(r.id);
      return { ...r, ...(v ? { version_n: v.n, version_total: v.total, asset_id: v.assetId } : {}) };
    });
    const timelineRow = sql.exec<{ canvas_id: string; edl: string; revision: number }>("SELECT * FROM timelines LIMIT 1").toArray()[0];
    return {
      projectId: this.getMeta("project_id"),
      workspaceId: this.getMeta("workspace_id"),
      title: this.getMeta("title"),
      revision: this.revision(),
      canvases: sql.exec<{ id: string; title: string; viewport: string | null }>("SELECT * FROM canvases").toArray(),
      nodes,
      edges: sql.exec<EdgeRow & Record<string, SqlStorageValue>>("SELECT * FROM edges ORDER BY rowid").toArray(),
      groups: sql.exec<GroupRow & Record<string, SqlStorageValue>>("SELECT * FROM groups ORDER BY rowid").toArray(),
      timeline: timelineRow ? { canvasId: timelineRow.canvas_id, revision: Number(timelineRow.revision), edl: safeJson(timelineRow.edl) as unknown as Edl } : null,
    };
  }

  private ensureTimeline(): TimelineState {
    const canvasId = this.getMeta("canvas_id") ?? "cnv_main";
    const row = this.ctx.storage.sql.exec<{ edl: string; revision: number }>("SELECT edl, revision FROM timelines WHERE canvas_id = ?", canvasId).toArray()[0];
    if (row) return { canvasId, revision: Number(row.revision), edl: JSON.parse(row.edl) as Edl };
    const assets = this.activeVersions();
    const edl = assembleFromGraph(this.loadState(), (id) => assets.get(id)?.assetId ?? null);
    const timeline = { canvasId, revision: 0, edl };
    this.saveTimeline(timeline);
    return timeline;
  }

  private saveTimeline(t: TimelineState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO timelines (canvas_id, edl, revision) VALUES (?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET edl = excluded.edl, revision = excluded.revision",
      t.canvasId,
      JSON.stringify(t.edl),
      t.revision,
    );
    this.touch();
  }

  private async pickThumbnail(): Promise<string | null> {
    const sql = this.ctx.storage.sql;
    const candidates = [
      ...[...this.activeVersions().values()].sort((a, b) => b.createdAt - a.createdAt).map((v) => v.assetId),
      ...sql
        .exec<{ params: string }>("SELECT params FROM nodes WHERE kind = 'asset' ORDER BY updated_at DESC LIMIT 20")
        .toArray()
        .map((r) => safeJson(r.params).assetId),
    ]
      .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id))
      .slice(0, 30);
    if (!candidates.length) return null;
    const rows = await this.env.DB.prepare(
      `SELECT id, kind, r2_key, meta, mature FROM assets WHERE id IN (${candidates.map(() => "?").join(",")}) AND mature = 0 AND status IN ('ready','processing')`,
    )
      .bind(...candidates)
      .all<{ id: string; kind: string; r2_key: string; meta: string; mature: number }>();
    const byId = new Map(rows.results.map((r) => [r.id, r]));
    for (const id of candidates) {
      const r = byId.get(id);
      if (!r) continue;
      const thumb = safeJson(r.meta).thumbKey;
      if (typeof thumb === "string") return thumb;
      if (r.kind === "image") return r.r2_key;
    }
    return null;
  }

  private touch(now = Date.now()): void {
    this.setMeta("updated_at", String(now));
    this.setMeta("index_dirty", "1");
  }

  private async scheduleIndex(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + INDEX_DEBOUNCE_MS);
  }

  private revision(): number {
    return Number(this.getMeta("revision") ?? 0);
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private socketInfo(ws: WebSocket): SocketInfo | null {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    return info && typeof info.userId === "string" ? info : null;
  }

  private fanOut(message: string, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(message);
      } catch {
        // Socket is closing; the hibernation API delivers webSocketClose.
      }
    }
  }
}

function parseReroutes(raw: unknown): { x: number; y: number }[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is { x: number; y: number } => typeof p?.x === "number" && typeof p?.y === "number") : [];
  } catch {
    return [];
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
