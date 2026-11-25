/**
 * WebSocket envelope shared by ProjectRoom and UserHub (D-003). Every message
 * in both directions is `{ type, id, payload }`. The Worker validates with
 * these schemas; the canvas types its messages with `TypedEnvelope`.
 *
 * D-014: one global socket per browser (`/api/ws`, UserHub gateway),
 * multiplexed by channel. Server messages on it carry `channel`
 * (`user` | `project`) and, for project events, `projectId` and `seq` (the
 * project's event cursor for catch-up on resubscribe).
 */
import { z } from 'zod';

export const WsChannel = z.enum(['user', 'project']);
export type WsChannel = z.infer<typeof WsChannel>;

export const WsEnvelope = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  payload: z.unknown(),
  /** D-014 gateway: which channel a server message belongs to. */
  channel: WsChannel.optional(),
  /** D-014 gateway: the project of a `project` channel message. */
  projectId: z.string().min(1).max(64).optional(),
  /** D-014 gateway: the project's event cursor (replayable project events only). */
  seq: z.number().int().nonnegative().optional(),
});
export type WsEnvelope = z.infer<typeof WsEnvelope>;

/** One message type with its payload, e.g. `TypedEnvelope<'ack', { revision: number }>`. */
export interface TypedEnvelope<T extends string = string, P = unknown> {
  type: T;
  id: string;
  payload: P;
}

/** Client -> ProjectRoom: graph patch. Ops are checked op by op when applied (`LocalOp` in `./types`). */
export const PatchPayload = z.object({
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(z.unknown()).max(500),
});
export type PatchPayload = z.infer<typeof PatchPayload>;

const ProjectId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** D-014 client -> gateway: subscribe to a project's events (membership checked). */
export const SubscribePayload = z.object({
  channel: z.literal('project'),
  projectId: ProjectId,
  /** Last graph revision the client applied; the reply carries the gap or a fresh snapshot. */
  lastRevision: z.number().int().nonnegative().optional(),
  /** Last project event `seq` the client saw (exact catch-up when still in the ring). */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type SubscribePayload = z.infer<typeof SubscribePayload>;

/** D-014 client -> gateway: `unsubscribe`, `undo`, `redo`, `snapshot` name the project. */
export const ProjectRefPayload = z.object({ projectId: ProjectId });
export type ProjectRefPayload = z.infer<typeof ProjectRefPayload>;

/** D-014 client -> gateway: graph patch for one project. */
export const GatewayPatchPayload = PatchPayload.extend({ projectId: ProjectId });
export type GatewayPatchPayload = z.infer<typeof GatewayPatchPayload>;

/** Client -> server: timeline patch (`timeline.patch`); on the gateway the project comes from `canvasId`. */
export const TimelinePatchPayload = z.object({
  canvasId: z.string().min(1).max(64),
  baseRevision: z.number().int().nonnegative(),
  ops: z.unknown(),
});
export type TimelinePatchPayload = z.infer<typeof TimelinePatchPayload>;

/** Message types clients send. Project sockets: `patch`, `undo`, `redo`, `timeline.patch`, `snapshot`, `ping`; the gateway adds `subscribe`, `unsubscribe`. */
export const ClientMessageType = z.enum(['subscribe', 'unsubscribe', 'patch', 'undo', 'redo', 'timeline.patch', 'snapshot', 'ping']);
export type ClientMessageType = z.infer<typeof ClientMessageType>;

/** Message types the server sends. */
export const ServerMessageType = z.enum([
  'snapshot',
  'hello',
  'ack',
  'conflict',
  'error',
  'pong',
  'graph.patched',
  'node.version',
  'job.queued',
  'job.progress',
  'job.done',
  'job.failed',
  'timeline.patched',
  'export.progress',
  'export.done',
  'export.failed',
  'credits.changed',
  'proposal.created',
  'proposal.updated',
  'agent.delta',
  'agent.tool',
  'agent.done',
  'agent.error',
  'agent.allowance',
  'activity.updated',
  'notification',
  'prefs.changed',
  'subscribed',
  'unsubscribed',
]);
export type ServerMessageType = z.infer<typeof ServerMessageType>;

export function envelope(type: ServerMessageType, payload: unknown, id: string = crypto.randomUUID()): string {
  return JSON.stringify({ type, id, payload } satisfies WsEnvelope);
}

/** D-014 gateway envelope: `channel`, plus `projectId` / `seq` on project messages. */
export function channelEnvelope(
  type: ServerMessageType,
  payload: unknown,
  route: { channel: WsChannel; projectId?: string; seq?: number },
  id: string = crypto.randomUUID(),
): string {
  return JSON.stringify({
    type,
    id,
    payload,
    channel: route.channel,
    ...(route.projectId !== undefined ? { projectId: route.projectId } : {}),
    ...(route.seq !== undefined ? { seq: route.seq } : {}),
  } satisfies WsEnvelope);
}

export type ParseResult =
  | { ok: true; message: WsEnvelope }
  | { ok: false; id: string; code: 'BAD_MESSAGE'; message: string };

export function parseEnvelope(raw: string | ArrayBuffer): ParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, id: 'unknown', code: 'BAD_MESSAGE', message: 'Binary messages are not supported' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, id: 'unknown', code: 'BAD_MESSAGE', message: 'Message must be JSON' };
  }
  const parsed = WsEnvelope.safeParse(json);
  if (!parsed.success) {
    const id =
      typeof json === 'object' && json !== null && typeof (json as { id?: unknown }).id === 'string'
        ? (json as { id: string }).id
        : 'unknown';
    return { ok: false, id, code: 'BAD_MESSAGE', message: 'Invalid envelope' };
  }
  return { ok: true, message: parsed.data };
}
