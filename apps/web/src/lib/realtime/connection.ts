import { CLOSE_FORBIDDEN, CLOSE_NO_PLAN, CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, type SocketStatus, type UserHubPayloads, type UserHubType } from './types';

/**
 * One WebSocket connection to `/api/ws` (D-014: one per browser, held by the
 * realtime hub in a SharedWorker, else one per tab). Reconnects with exponential
 * backoff and equal jitter (500 ms base, 30 s cap); a heartbeat ping every
 * 25 s detects dead connections (no answer in 10 s → reconnect). Close codes
 * 4401 (session gone), 4403 (forbidden) and 4404 (not found) stop it: they do
 * not get better by retrying. An upgrade refused over HTTP (e.g. 401) looks
 * like a plain failed connection; `onFailure` lets the session check whether
 * it is still signed in. The server accepts refused upgrades and sends one
 * `error` envelope before closing with `4000 + status` (docs/api.md → WebSocket
 * close codes); 4402 (no plan) also stops.
 */

export interface ConnectionOptions {
  url?: () => string;
  WebSocketImpl?: typeof WebSocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
  pingEveryMs?: number;
  pongTimeoutMs?: number;
  random?: () => number;
}

type Handler<K extends UserHubType> = (payload: UserHubPayloads[K], id: string) => void;
/** Every parsed envelope; `raw` carries the top-level `channel` / `projectId` (D-014). */
type AnyHandler = (type: string, payload: unknown, id: string, raw: Record<string, unknown>) => void;

export interface ConnectionEvents {
  /** The server closed with 4401: the session is gone. */
  unauthorized: () => void;
  /** Closed for good (4403/4404, or `stop()`). */
  closed: (code: number) => void;
  /** A connection attempt failed or dropped; `attempt` counts failures since the last open. */
  failure: (attempt: number) => void;
  status: (s: SocketStatus) => void;
}

export function backoffDelay(attempt: number, base: number, cap: number, random: () => number = Math.random): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Equal jitter: half fixed, half random.
  return Math.round(exp / 2 + random() * (exp / 2));
}

function defaultUrl(): string {
  const { protocol, host } = (globalThis as unknown as { location: Location }).location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/ws`;
}

export class Connection {
  private ws: WebSocket | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Map<string, Set<(p: unknown, id: string) => void>>();
  private any = new Set<AnyHandler>();
  private events: { [K in keyof ConnectionEvents]: Set<ConnectionEvents[K]> } = {
    unauthorized: new Set(),
    closed: new Set(),
    failure: new Set(),
    status: new Set(),
  };
  private seq = 0;
  status: SocketStatus = 'idle';

  constructor(private readonly opts: ConnectionOptions = {}) {}

  private get o() {
    return {
      url: this.opts.url ?? defaultUrl,
      WS: this.opts.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined),
      base: this.opts.baseDelayMs ?? 500,
      cap: this.opts.maxDelayMs ?? 30_000,
      pingEvery: this.opts.pingEveryMs ?? 25_000,
      pongTimeout: this.opts.pongTimeoutMs ?? 10_000,
      random: this.opts.random ?? Math.random,
    };
  }

  /** Typed subscription to one message type. Returns the unsubscribe function. */
  on<K extends UserHubType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = handler as (p: unknown, id: string) => void;
    set.add(h);
    return () => set!.delete(h);
  }

  onAny(handler: AnyHandler): () => void {
    this.any.add(handler);
    return () => this.any.delete(handler);
  }

  onEvent<K extends keyof ConnectionEvents>(event: K, handler: ConnectionEvents[K]): () => void {
    (this.events[event] as Set<ConnectionEvents[K]>).add(handler);
    return () => (this.events[event] as Set<ConnectionEvents[K]>).delete(handler);
  }

  private emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>) {
    for (const h of this.events[event]) (h as (...a: unknown[]) => void)(...args);
  }

  private setStatus(s: SocketStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    (globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('online', this.onOnline);
    this.connect();
  }

  stop(code = 1000) {
    this.wanted = false;
    (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.('online', this.onOnline);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'client stop');
      } catch {
        /* Already closed. */
      }
    }
    this.setStatus('closed');
    this.emit('closed', code);
  }

  /** Reconnect now (e.g. after sign-in or when the network comes back). */
  reconnect() {
    if (!this.wanted) return this.start();
    this.attempt = 0;
    this.dropSocket();
    this.connect();
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** Sends one envelope; false when not connected (the hub queues and resends). */
  send(type: string, payload: unknown, id: string = `c${++this.seq}`): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ type, id, payload }));
    return true;
  }

  /** Called on every successful open (after reconnects too). */
  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  }
  private openListeners = new Set<() => void>();

  private onOnline = () => {
    if (this.wanted && this.status !== 'open') this.reconnect();
  };

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.retryTimer = this.pingTimer = this.pongTimer = null;
  }

  private dropSocket() {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(4000, 'reconnect');
      } catch {
        /* Already closed. */
      }
    }
  }

  private connect() {
    const { WS, url } = this.o;
    if (!WS || !this.wanted) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.startHeartbeat();
      for (const l of this.openListeners) l();
    };
    ws.onmessage = (ev) => this.dispatch(ev.data);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.wanted = false;
        this.setStatus('closed');
        this.emit('unauthorized');
        this.emit('closed', ev.code);
        return;
      }
      if (ev.code === CLOSE_FORBIDDEN || ev.code === CLOSE_NOT_FOUND || ev.code === CLOSE_NO_PLAN) {
        this.wanted = false;
        this.setStatus('closed');
        this.emit('closed', ev.code);
        return;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows and schedules the retry. */
    };
  }

  private scheduleRetry() {
    if (!this.wanted) return;
    this.attempt += 1;
    this.emit('failure', this.attempt);
    if (!this.wanted) return; // A failure handler may stop the socket.
    this.setStatus('retrying');
    const { base, cap, random } = this.o;
    this.retryTimer = setTimeout(() => this.connect(), backoffDelay(this.attempt, base, cap, random));
  }

  private startHeartbeat() {
    const { pingEvery, pongTimeout } = this.o;
    this.pingTimer = setInterval(() => {
      // Plain "ping": the UserHub answers "pong" by auto-response without waking from hibernation.
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send('ping');
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // No answer: the connection is dead even if the browser has not noticed.
        this.dropSocket();
        this.scheduleRetry();
      }, pongTimeout);
    }, pingEvery);
  }

  private dispatch(raw: unknown) {
    // Any message proves the connection is alive.
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (typeof raw !== 'string') return;
    if (raw === 'pong') return;
    let msg: { type?: unknown; id?: unknown; payload?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg?.type !== 'string') return;
    const id = typeof msg.id === 'string' ? msg.id : '';
    for (const h of this.handlers.get(msg.type) ?? []) {
      try {
        h(msg.payload, id);
      } catch (e) {
        console.error('user socket handler failed', msg.type, e);
      }
    }
    for (const h of this.any) h(msg.type, msg.payload, id, msg);
  }
}

/** Older name. */
export { Connection as UserSocket };
