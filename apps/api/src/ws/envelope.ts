/**
 * WebSocket envelope shared by ProjectRoom and UserHub (D-003). The schemas
 * and helpers live in packages/core (`@rolling/core/graph`) so the canvas
 * uses the same envelope.
 */
export {
  envelope,
  parseEnvelope,
  PatchPayload,
  ServerMessageType,
  WsEnvelope,
  type ParseResult,
} from "@rolling/core/graph";

export interface ProjectSnapshot {
  projectId: string | null;
  revision: number;
  canvases: unknown[];
  nodes: unknown[];
  edges: unknown[];
}
