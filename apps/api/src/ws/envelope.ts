/**
 * WebSocket envelope shared by ProjectRoom and UserHub (D-003).
 * Every message in both directions is `{ type, id, payload }`.
 *
 * TODO(M1+): move these schemas to packages/core so apps/web can import them.
 */
import { z } from "zod";

export const WsEnvelope = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  payload: z.unknown(),
});
export type WsEnvelope = z.infer<typeof WsEnvelope>;

/** Client -> ProjectRoom: graph patch. `ops` become `GraphOp[]` once packages/core defines them. */
export const PatchPayload = z.object({
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(z.unknown()).max(500),
});
export type PatchPayload = z.infer<typeof PatchPayload>;

/** Message types the server sends. Client -> server types: `patch`, `ping`. */
export const ServerMessageType = z.enum([
  "snapshot",
  "hello",
  "ack",
  "conflict",
  "error",
  "pong",
  "graph.patched",
  "node.version",
  "job.progress",
  "job.done",
  "job.failed",
  "timeline.patched",
  "credits.changed",
  "proposal.created",
  "agent.delta",
  "activity.updated",
  "notification",
]);
export type ServerMessageType = z.infer<typeof ServerMessageType>;

export interface ProjectSnapshot {
  projectId: string | null;
  revision: number;
  canvases: unknown[];
  nodes: unknown[];
  edges: unknown[];
}

export function envelope(type: ServerMessageType, payload: unknown, id: string = crypto.randomUUID()): string {
  return JSON.stringify({ type, id, payload } satisfies WsEnvelope);
}

export type ParseResult =
  | { ok: true; message: WsEnvelope }
  | { ok: false; id: string; code: "BAD_MESSAGE"; message: string };

export function parseEnvelope(raw: string | ArrayBuffer): ParseResult {
  if (typeof raw !== "string") {
    return { ok: false, id: "unknown", code: "BAD_MESSAGE", message: "Binary messages are not supported" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, id: "unknown", code: "BAD_MESSAGE", message: "Message must be JSON" };
  }
  const parsed = WsEnvelope.safeParse(json);
  if (!parsed.success) {
    const id =
      typeof json === "object" && json !== null && typeof (json as { id?: unknown }).id === "string"
        ? (json as { id: string }).id
        : "unknown";
    return { ok: false, id, code: "BAD_MESSAGE", message: "Invalid envelope" };
  }
  return { ok: true, message: parsed.data };
}
