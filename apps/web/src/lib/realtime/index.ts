import { useEffect, useRef, useSyncExternalStore } from 'react';
import { realtime } from './client';
import type { SocketStatus, UserHubPayloads, UserHubType } from './types';

/**
 * Realtime (D-003, D-014): one WebSocket per browser to `/api/ws`, held by a
 * SharedWorker hub (fallback: one per tab) and multiplexed by channel.
 *
 * - User channel (`realtime.user`, alias `userSocket`): started by lib/session
 *   once signed in; the session applies `credits.changed`, `prefs.changed`,
 *   `agent.allowance`, `activity.updated` and `notification` itself. Features
 *   listen with `useUserSocketEvent` (e.g. Home agent streams).
 * - Project channels: `realtime.subscribeProject(projectId, { lastRevision })`
 *   → `ProjectChannel` (`on`, `send`, `request`, `patch`, `undo`, `redo`,
 *   `timelinePatch`, `setRevision`, `unsubscribe`). Ref-counted across tabs;
 *   re-subscribed with `lastRevision` after reconnects; replies routed back by
 *   message id.
 */
export { realtime, userSocket, RealtimeClient, RealtimeError, type EventMeta, type ProjectChannel, type ProjectPayloads, type ProjectEventType, type PatchResult, type Reply, type RealtimeClientOptions } from './client';
export { Connection, backoffDelay, type ConnectionOptions } from './connection';
export { RealtimeHub } from './hub';
export type { HubMessage, TabMessage } from './protocol';
export { connectRealtime, type RealtimeTransport, type RealtimeTransportMode } from './transport';
export * from './types';

/** Calls `handler` for every `type` message on the user channel while mounted. */
export function useUserSocketEvent<K extends UserHubType>(type: K, handler: (payload: UserHubPayloads[K], id: string) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.user.on(type, (p, id) => ref.current(p, id)), [type]);
}

export function useUserSocketStatus(): SocketStatus {
  return useSyncExternalStore(
    (cb) => realtime.user.onEvent('status', cb),
    () => realtime.status,
    () => 'idle' as SocketStatus,
  );
}
