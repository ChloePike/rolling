import { DurableObject } from "cloudflare:workers";
import { AGENT_ABUSE_LIMIT, slidingWindowTake } from "@rolling/core";
import { envelope, parseEnvelope, type ServerMessageType } from "../ws/envelope";

/**
 * One instance per user (`idFromName(userId)`). Carries credits changes,
 * Activity updates, notifications and Home agent streams to every open tab.
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
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.send(envelope("hello", { userId, connectedAt: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }, parsed.id));
      return;
    }
    if (parsed.message.type === "ping") {
      ws.send(envelope("pong", null, parsed.message.id));
      return;
    }
    ws.send(
      envelope("error", { code: "UNKNOWN_TYPE", message: `Unknown message type: ${parsed.message.type}` }, parsed.message.id),
    );
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** RPC: push one envelope to every socket of this user. Returns the number of sockets reached. */
  async broadcast(type: ServerMessageType, payload: unknown): Promise<number> {
    const message = envelope(type, payload);
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
