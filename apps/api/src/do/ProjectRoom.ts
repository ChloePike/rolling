import { DurableObject } from "cloudflare:workers";
import { migrateDurableObject } from "@rolling/db/do/migrate";
import { projectMigrations } from "@rolling/db/do/project";
import { envelope, parseEnvelope, PatchPayload, type ProjectSnapshot } from "../ws/envelope";

/**
 * One instance per project. Serializes graph edits, keeps revisions and fans
 * changes out over hibernating WebSockets.
 *
 * M0 stub: real GraphOp application lands in M3; patches are logged and
 * acknowledged with the next revision.
 */
export class ProjectRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage, projectMigrations);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const projectId = request.headers.get("x-project-id");
    if (projectId) this.setMeta("project_id", projectId);
    const actor = request.headers.get("x-user-id") ?? "anonymous";

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [`actor:${actor}`]);
    server.send(envelope("snapshot", this.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }, parsed.id));
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "patch": {
        const payload = PatchPayload.safeParse(msg.payload);
        if (!payload.success) {
          ws.send(envelope("error", { code: "BAD_MESSAGE", message: "Invalid patch payload" }, msg.id));
          return;
        }
        const result = this.applyPatch(payload.data, this.actorOf(ws));
        if (!result.ok) {
          ws.send(envelope("conflict", { snapshot: this.snapshot() }, msg.id));
          return;
        }
        ws.send(envelope("ack", { revision: result.revision }, msg.id));
        this.broadcast(
          envelope("graph.patched", { revision: result.revision, ops: payload.data.ops, actor: this.actorOf(ws) }),
          ws,
        );
        return;
      }
      case "ping":
        ws.send(envelope("pong", null, msg.id));
        return;
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

  /** Current revision; exposed over RPC for REST handlers and tests. */
  async getRevision(): Promise<number> {
    return this.revision();
  }

  private applyPatch(patch: PatchPayload, actor: string): { ok: true; revision: number } | { ok: false } {
    return this.ctx.storage.transactionSync(() => {
      const current = this.revision();
      if (patch.baseRevision !== current) return { ok: false as const };
      const next = current + 1;
      // TODO(M3): validate and apply GraphOps from packages/core to nodes/edges.
      this.ctx.storage.sql.exec(
        "INSERT INTO patch_log (revision, actor, ops, created_at) VALUES (?, ?, ?, ?)",
        next,
        actor,
        JSON.stringify(patch.ops),
        Date.now(),
      );
      this.setMeta("revision", String(next));
      return { ok: true as const, revision: next };
    });
  }

  private snapshot(): ProjectSnapshot {
    const sql = this.ctx.storage.sql;
    return {
      projectId: this.getMeta("project_id"),
      revision: this.revision(),
      canvases: sql.exec("SELECT * FROM canvases").toArray(),
      nodes: sql.exec("SELECT * FROM nodes").toArray(),
      edges: sql.exec("SELECT * FROM edges").toArray(),
    };
  }

  private revision(): number {
    return Number(this.getMeta("revision") ?? 0);
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private actorOf(ws: WebSocket): string {
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("actor:"));
    return tag ? tag.slice("actor:".length) : "anonymous";
  }

  private broadcast(message: string, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(message);
      } catch {
        // Socket is closing; hibernation API will deliver webSocketClose.
      }
    }
  }
}
