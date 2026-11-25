import type { SocketStatus } from './types';

/**
 * Messages between a tab (`client.ts`) and the realtime hub (`hub.ts`, in the
 * SharedWorker or this tab). The hub holds the browser's one WebSocket
 * (D-014) and multiplexes it by channel.
 */

/** Tab → hub. */
export type TabMessage =
  /** This tab is signed in and wants the socket. `restart` forces a fresh connection (sign-in, another user). */
  | { t: 'start'; restart?: boolean }
  /** This tab no longer needs the socket (signed out, closing). */
  | { t: 'stop' }
  /** Opens (or joins) a project channel; `sub` is the tab's handle id, `req` the envelope id of the `subscribe`. */
  | { t: 'subscribe'; sub: string; projectId: string; lastRevision?: number; lastSeq?: number; req: string }
  | { t: 'unsubscribe'; sub: string }
  /** Latest revision this tab has applied (for catch-up after a reconnect). */
  | { t: 'revision'; sub: string; revision: number }
  /** One envelope to the server; replies with this `id` come back to this tab only. */
  | { t: 'send'; type: string; id: string; payload: unknown; sub?: string }
  /** The tab is going away (pagehide). */
  | { t: 'bye' };

/** Hub → tab. */
export type HubMessage =
  /** One server envelope: user channel (every tab), a project channel (its subscribers), or a reply (the sender). */
  | { t: 'msg'; type: string; id: string; payload: unknown; channel: 'user' | 'project'; projectId?: string; seq?: number; subs?: string[]; synthetic?: boolean }
  | { t: 'status'; status: SocketStatus }
  /** 4401 (session gone), refused (4403/4404) or a failed attempt. */
  | { t: 'event'; event: 'unauthorized' | 'closed' | 'failure'; code?: number; attempt?: number }
  /** A send could not go out (not connected); the tab may retry or wait for reconnect. */
  | { t: 'unsent'; id: string };

export interface PortLike {
  postMessage(msg: HubMessage): void;
}
