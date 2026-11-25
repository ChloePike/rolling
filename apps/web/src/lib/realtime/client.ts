import type { LocalOp, ProjectSnapshot, ServerMessage } from '@rolling/core/graph';
import type { HubMessage, TabMessage } from './protocol';
import { connectRealtime, type RealtimeTransport, type RealtimeTransportMode } from './transport';
import type { SocketStatus, UserHubPayloads, UserHubType } from './types';

/**
 * Tab side of realtime (D-014). One WebSocket per browser lives in the hub
 * (SharedWorker, else this tab); this client talks to it over a port.
 *
 * - `realtime.user`: the user channel (credits, prefs, allowance, activity,
 *   notifications, Home/tool agent streams). Started by lib/session once
 *   signed in.
 * - `realtime.subscribeProject(projectId, { lastRevision })`: a project
 *   channel handle (graph/timeline patches, jobs, agent streams of canvas and
 *   editor threads). Tabs on the same project share one server subscription;
 *   after a reconnect the hub re-subscribes with `lastRevision` (keep it
 *   current with `setRevision`) and the handle gets `subscribed` again.
 */

// ---------------------------------------------------------------- project channel types

/** Server → client on a project channel: the ProjectRoom messages plus D-014's `subscribed`. */
export type ProjectPayloads = { [M in ServerMessage as M['type']]: M['payload'] } & {
  /** Answer to `subscribe` (also after every reconnect): a full snapshot, or the patches since `lastRevision`. */
  /**
   * Answer to `subscribe` (also after every reconnect): `snapshot`, or `events`
   * (the gap since `lastSeq` / `lastRevision`). Project events can arrive before
   * it: buffer them, apply this, then the buffered ones with `seq > subscribed.seq`.
   */
  subscribed: { projectId: string; revision: number; seq: number; canEdit: boolean; snapshot?: ProjectSnapshot; events?: { seq: number; type: string; payload: unknown }[] };
  unsubscribed: { projectId: string };
  'timeline.patched': { revision: number; ops: unknown[]; actor?: string; canvasId?: string; [k: string]: unknown };
  'proposal.created': { threadId: string; turnId: string; proposal: unknown };
  'proposal.updated': { threadId: string; proposalId: string; status: string; reason?: string };
  'agent.delta': { threadId: string; turnId: string; delta: string };
  'agent.tool': { threadId: string; turnId: string; name: string; status: 'started' | 'ok' | 'error'; error?: string };
  'agent.done': { threadId: string; turnId: string; messageId: string; reason: string; proposalId: string | null };
  'agent.error': { threadId: string; turnId: string; code: string; message: string };
  error: { code: string; message?: string; data?: unknown; projectId?: string };
};
export type ProjectEventType = keyof ProjectPayloads;

export interface Reply {
  type: string;
  id: string;
  payload: unknown;
}

export type PatchResult = { ok: true; revision: number; idMap?: Record<string, string>; statuses?: unknown } | { ok: false; conflict: ProjectSnapshot };

export class RealtimeError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RealtimeError';
  }
}

export interface ProjectChannel {
  readonly projectId: string;
  /** Typed subscription to one project message type. */
  on<K extends ProjectEventType>(type: K, handler: (payload: ProjectPayloads[K], id: string, meta: EventMeta) => void): () => void;
  onAny(handler: (type: string, payload: unknown, id: string, meta: EventMeta) => void): () => void;
  /** Sends an envelope on this project (the hub adds nothing; `projectId` is put in the payload). Returns its id. */
  send(type: string, payload?: Record<string, unknown>): string;
  /** Sends and waits for the reply with the same id (`ack`, `conflict`, `error`, ...). */
  request(type: string, payload?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Reply>;
  /** `patch {projectId, baseRevision, ops}` → `ack {revision}` or `conflict {snapshot}`; `error` rejects. */
  patch(baseRevision: number, ops: LocalOp[]): Promise<PatchResult>;
  undo(): Promise<Reply>;
  redo(): Promise<Reply>;
  timelinePatch(payload: Record<string, unknown>): Promise<Reply>;
  /** The latest revision this tab applied (used for catch-up after a reconnect). */
  setRevision(revision: number): void;
  unsubscribe(): void;
}

// ---------------------------------------------------------------- client

/** Envelope details besides the payload: the event cursor (`seq`) and whether the hub synthesized it from this browser's own ack. */
export interface EventMeta {
  seq?: number;
  synthetic?: boolean;
}

type Listener = (type: string, payload: unknown, id: string, meta: EventMeta) => void;

interface UserEvents {
  unauthorized: () => void;
  closed: (code: number) => void;
  failure: (attempt: number) => void;
  status: (s: SocketStatus) => void;
}

export interface RealtimeClientOptions {
  transport?: () => RealtimeTransport;
  force?: RealtimeTransportMode;
}

const tabId = () => Math.random().toString(36).slice(2, 10);

export class RealtimeClient {
  private transport: RealtimeTransport | null = null;
  private readonly tab = tabId();
  private seq = 0;
  private userHandlers = new Map<string, Set<(p: unknown, id: string) => void>>();
  private userAny = new Set<(type: string, payload: unknown, id: string) => void>();
  private events: { [K in keyof UserEvents]: Set<UserEvents[K]> } = { unauthorized: new Set(), closed: new Set(), failure: new Set(), status: new Set() };
  private projectListeners = new Map<string, Set<Listener>>();
  private pending = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private wantsUser = false;
  status: SocketStatus = 'idle';

  constructor(private readonly opts: RealtimeClientOptions = {}) {
    Object.defineProperty(this.user, 'status', { get: () => this.status });
  }

  private get port(): RealtimeTransport {
    if (!this.transport) {
      this.transport = this.opts.transport ? this.opts.transport() : connectRealtime({ force: this.opts.force });
      this.transport.onMessage((m) => this.receive(m));
      if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.transport?.post({ t: 'bye' }));
    }
    return this.transport;
  }

  get mode(): RealtimeTransportMode | null {
    return this.transport?.mode ?? null;
  }

  private post(m: TabMessage) {
    this.port.post(m);
  }

  private nextId(prefix: string) {
    return `${prefix}${this.tab}.${++this.seq}`;
  }

  // ------------------------------------------------ user channel

  /** The user channel: same surface as a single socket (`on`, `onEvent`, `start`, `stop`, `reconnect`). */
  readonly user = {
    on: <K extends UserHubType>(type: K, handler: (payload: UserHubPayloads[K], id: string) => void): (() => void) => {
      let set = this.userHandlers.get(type);
      if (!set) this.userHandlers.set(type, (set = new Set()));
      const h = handler as (p: unknown, id: string) => void;
      set.add(h);
      return () => set!.delete(h);
    },
    onAny: (handler: (type: string, payload: unknown, id: string) => void): (() => void) => {
      this.userAny.add(handler);
      return () => this.userAny.delete(handler);
    },
    onEvent: <K extends keyof UserEvents>(event: K, handler: UserEvents[K]): (() => void) => {
      (this.events[event] as Set<UserEvents[K]>).add(handler);
      return () => (this.events[event] as Set<UserEvents[K]>).delete(handler);
    },
    /** This tab is signed in: keep the socket up. */
    start: () => {
      this.wantsUser = true;
      this.post({ t: 'start' });
    },
    /** This tab signed out. */
    stop: () => {
      if (!this.wantsUser && !this.transport) return;
      this.wantsUser = false;
      this.post({ t: 'stop' });
    },
    /** Fresh connection (after sign-in or a user change). */
    reconnect: () => {
      this.wantsUser = true;
      this.post({ t: 'start', restart: true });
    },
    send: (type: string, payload: unknown = null): string => {
      const id = this.nextId('u');
      this.post({ t: 'send', type, id, payload });
      return id;
    },
    /** Replaced by a live getter in the constructor. */
    status: 'idle' as SocketStatus,
  };

  // ------------------------------------------------ project channels

  subscribeProject(projectId: string, opts: { lastRevision?: number; lastSeq?: number } = {}): ProjectChannel {
    const sub = this.nextId('s');
    const listeners = new Set<Listener>();
    this.projectListeners.set(sub, listeners);
    this.post({ t: 'subscribe', sub, projectId, lastRevision: opts.lastRevision, lastSeq: opts.lastSeq, req: this.nextId('r') });
    let closed = false;

    const request = (type: string, payload: Record<string, unknown> = {}, o: { timeoutMs?: number } = {}): Promise<Reply> => {
      if (closed) return Promise.reject(new RealtimeError('UNSUBSCRIBED'));
      const id = this.nextId('m');
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RealtimeError('TIMEOUT', `No answer to ${type}`));
        }, o.timeoutMs ?? 15_000);
        this.pending.set(id, { resolve, reject, timer });
        this.post({ t: 'send', type, id, payload: { projectId, ...payload }, sub });
      });
    };

    const channel: ProjectChannel = {
      projectId,
      on: (type, handler) => {
        const l: Listener = (t, p, id, meta) => {
          if (t === type) (handler as (p: unknown, id: string, meta: EventMeta) => void)(p, id, meta);
        };
        listeners.add(l);
        return () => listeners.delete(l);
      },
      onAny: (handler) => {
        const l: Listener = (t, p, id, meta) => handler(t, p, id, meta);
        listeners.add(l);
        return () => listeners.delete(l);
      },
      send: (type, payload = {}) => {
        const id = this.nextId('m');
        this.post({ t: 'send', type, id, payload: { projectId, ...payload }, sub });
        return id;
      },
      request,
      patch: async (baseRevision, ops) => {
        const r = await request('patch', { baseRevision, ops });
        if (r.type === 'ack') {
          const a = r.payload as { revision: number; idMap?: Record<string, string>; statuses?: unknown };
          return { ok: true, revision: a.revision, idMap: a.idMap, statuses: a.statuses };
        }
        if (r.type === 'conflict') return { ok: false, conflict: (r.payload as { snapshot: ProjectSnapshot }).snapshot };
        const e = r.payload as { code?: string; message?: string; data?: unknown };
        throw new RealtimeError(e?.code ?? 'ERROR', e?.message, e?.data);
      },
      undo: () => request('undo'),
      redo: () => request('redo'),
      // `timeline.patch` is keyed by canvas; `projectId` rides along for routing.
      timelinePatch: (payload) => request('timeline.patch', payload),
      setRevision: (revision) => {
        if (!closed) this.post({ t: 'revision', sub, revision });
      },
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        this.projectListeners.delete(sub);
        this.post({ t: 'unsubscribe', sub });
      },
    };
    return channel;
  }

  // ------------------------------------------------ incoming

  private receive(m: HubMessage) {
    if (m.t === 'status') {
      this.status = m.status;
      for (const h of this.events.status) h(m.status);
      return;
    }
    if (m.t === 'event') {
      if (m.event === 'unauthorized') for (const h of this.events.unauthorized) h();
      if (m.event === 'closed') for (const h of this.events.closed) h(m.code ?? 1000);
      if (m.event === 'failure') for (const h of this.events.failure) h(m.attempt ?? 1);
      return;
    }
    if (m.t === 'unsent') {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        p.reject(new RealtimeError('NOT_CONNECTED', 'The realtime connection is down'));
      }
      return;
    }
    // A reply to one of this tab's requests.
    const replyId = this.pending.has(m.id) ? m.id : typeof (m.payload as { id?: unknown })?.id === 'string' && this.pending.has((m.payload as { id: string }).id) ? (m.payload as { id: string }).id : null;
    if (replyId) {
      const p = this.pending.get(replyId)!;
      clearTimeout(p.timer);
      this.pending.delete(replyId);
      p.resolve({ type: m.type, id: m.id, payload: m.payload });
    }
    if (m.channel === 'project') {
      const subs = m.subs ?? [];
      const meta: EventMeta = { seq: m.seq, synthetic: m.synthetic };
      for (const sub of subs) for (const l of this.projectListeners.get(sub) ?? []) safe(() => l(m.type, m.payload, m.id, meta));
      return;
    }
    for (const h of this.userHandlers.get(m.type) ?? []) safe(() => h(m.payload, m.id));
    for (const h of this.userAny) safe(() => h(m.type, m.payload, m.id));
  }
}

function safe(fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error('realtime handler failed', e);
  }
}

/** The tab's realtime client (real API only; nothing connects until the session starts it or a project subscribes). */
export const realtime = new RealtimeClient();

/** The user channel, under its older name (lib/session uses it). */
export const userSocket = realtime.user;
