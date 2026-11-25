/**
 * WebSocket upgrade failures (docs/api.md → WebSocket close codes). Browsers
 * cannot read the body or status of a failed upgrade, so a refused upgrade is
 * accepted and then closed right away: the server sends one
 * `error { code, message, data }` envelope and closes with `4000 + HTTP status`
 * (4401 signed out, 4403 forbidden, 4404 not found; 4402 no plan on the
 * agent thread socket).
 */
import type { ErrorCode } from "./errors";

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export function wsCloseCode(status: number): number {
  return status >= 400 && status < 500 ? 4000 + status : 1011;
}

export function refuseWebSocket(status: number, code: ErrorCode, message: string, data: Record<string, unknown> = {}): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ type: "error", id: crypto.randomUUID(), payload: { code, message, data } }));
  // Close reasons are limited to 123 bytes.
  server.close(wsCloseCode(status), code.slice(0, 120));
  return new Response(null, { status: 101, webSocket: client });
}
