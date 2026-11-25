/**
 * Creation-side backend access (canvas, editor, agent, Home, tools, Activity,
 * assets). One place that knows whether the app talks to the real Worker API
 * or runs on the in-browser mocks, how REST errors look (`docs/api.md`:
 * `{ error: { code, message, data } }`), how GraphQL reads are sent and how
 * WebSocket URLs are built.
 *
 * Mode: `VITE_API_MODE=mock` (set by the Playwright config for the fidelity
 * and interaction specs) keeps every creation feature on its mocks; anything
 * else talks to `/api`. `?api=mock` / `?api=real` overrides it for a manual
 * look on localhost only.
 *
 * TODO(api): when `lib/api` (typed client) and `lib/realtime` (UserHub socket)
 * land, `apiFetch`, `gql` and `userEvents` become thin re-exports of them;
 * callers keep importing from here.
 */

import { apiRequest, getWorkspaceId, ApiError, isApiError, apiMode, isMockApi, type ApiErrorCode, type ApiMode } from '@/lib/api';
import * as realtime from '@/lib/realtime';

export { ApiError, isApiError, apiMode, isMockApi, type ApiErrorCode, type ApiMode };

/** Tests: pin the mode (same switch `lib/api` reads). */
export function setApiModeForTests(mode: ApiMode | null) {
  (globalThis as { __rollingApiMode?: ApiMode }).__rollingApiMode = mode ?? undefined;
}

/* ---------- Dev identity (wrangler dev only) ---------- */

/**
 * `ENVIRONMENT=development` Workers accept `x-dev-user` (header) / `devUser`
 * (query) as the identity. The e2e `real` project sets
 * `localStorage['rolling.devUser']`; production ignores both.
 */
export const DEV_USER_KEY = 'rolling.devUser';

export function devUser(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
  }
}

/* ---------- REST ---------- */

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | null | undefined>;
}

/** `lib/api`'s request (cookies, workspace header, typed `ApiError`), plus the dev identity header on wrangler dev. */
export async function apiFetch<T>(path: string, init: ApiRequest = {}): Promise<T> {
  const dev = devUser();
  return apiRequest<T>(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    body: init.body,
    query: init.query,
    signal: init.signal,
    headers: dev ? { 'x-dev-user': dev } : undefined,
  });
}

/* ---------- GraphQL (read-only) ---------- */

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch<{ data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> }>('/graphql', {
    method: 'POST',
    body: { query, variables },
    signal,
  });
  if (r.errors?.length) {
    const first = r.errors[0]!;
    throw new ApiError((first.extensions?.code ?? 'UNKNOWN') as ApiErrorCode, first.message, 200);
  }
  return r.data as T;
}

/* ---------- WebSockets ---------- */

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const dev = devUser();
  const url = new URL(`${proto}//${location.host}/api${path}`);
  if (dev) url.searchParams.set('devUser', dev);
  const ws = getWorkspaceId();
  if (ws) url.searchParams.set('workspaceId', ws);
  return url.toString();
}

export interface Envelope<P = unknown> {
  type: string;
  id: string;
  payload: P;
}

type Listener = (msg: Envelope) => void;

/**
 * A reconnecting JSON-envelope socket. Reconnects with backoff (1 s → 30 s)
 * unless closed by us or with a 44xx code (auth, not found, deleted), which
 * is final and reported through `onClose`.
 */
export class EnvelopeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private rawListeners = new Set<(raw: string) => void>();
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private queue: string[] = [];
  onOpen?: () => void;
  onClose?: (code: number, final: boolean) => void;

  constructor(private readonly path: string) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(wsUrl(this.path));
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      for (const raw of this.queue.splice(0)) ws.send(raw);
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      this.onOpen?.();
    });
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      for (const l of this.rawListeners) l(e.data);
      if (!this.listeners.size) return;
      let msg: Envelope;
      try {
        msg = JSON.parse(e.data) as Envelope;
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', (e) => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      const final = this.closed || (e.code >= 4400 && e.code < 4500);
      this.onClose?.(e.code, final);
      if (final) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(raw: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw);
    else this.queue.push(raw);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Raw text frames (the canvas sync parses its own envelopes). */
  subscribeRaw(l: (raw: string) => void): () => void {
    this.rawListeners.add(l);
    return () => this.rawListeners.delete(l);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }
}

/**
 * UserHub (`/api/ws`) events through `lib/realtime` (the session starts the
 * socket once signed in): `credits.changed`, `activity.updated`, `agent.*`
 * of Home and tool threads, `proposal.*`.
 */
export function userEvents(listener: (msg: Envelope) => void): () => void {
  if (isMockApi()) return () => {};
  // `lib/realtime` is moving to one shared connection (D-014); accept either export.
  const rt = realtime as unknown as {
    userSocket?: { onAny?: (h: (type: string, payload: unknown, id: string) => void) => () => void };
    subscribeUser?: (h: (type: string, payload: unknown, id: string) => void) => () => void;
  };
  const sub = rt.subscribeUser ?? rt.userSocket?.onAny?.bind(rt.userSocket);
  return sub ? sub((type: string, payload: unknown, id: string) => listener({ type, id, payload })) : () => {};
}

/* ---------- Project channel (D-014) ---------- */

/**
 * D-014: one WebSocket per browser (SharedWorker in `lib/realtime`),
 * multiplexed by channel. A project channel is
 * `realtime.subscribeProject(projectId, { lastRevision })` → `{ send, on, unsubscribe }`.
 * This is the shape the canvas codes against; until `lib/realtime` exports
 * `subscribeProject`, `openProjectChannel` falls back to a dedicated
 * reconnecting project socket with the same behaviour.
 */
export interface ProjectChannel {
  /** Raw envelope text to the room (`patch`, `undo`, `redo`, `timeline.patch`, `snapshot`); replies come back with the same id. */
  send(raw: string): void;
  /** Every server message of this project (as raw envelope text). */
  onMessage(listener: (raw: string) => void): () => void;
  /** Connection state: `open` false while reconnecting; `fatal` close codes 4401/4403/4404/4410. */
  onStatus(listener: (s: { open: boolean; fatalCode?: number; neverOpened?: boolean }) => void): () => void;
  unsubscribe(): void;
}

interface RealtimeProjectHandle {
  send: (type: string, payload: unknown, id?: string) => unknown;
  on: (event: string, handler: (payload: unknown, id: string, type?: string) => void) => () => void;
  unsubscribe: () => void;
}

type SubscribeProject = (projectId: string, opts: { lastRevision?: number }) => RealtimeProjectHandle;

export function openProjectChannel(projectId: string, opts: { lastRevision?: number } = {}): ProjectChannel {
  const subscribe = (realtime as unknown as { subscribeProject?: SubscribeProject }).subscribeProject;
  if (typeof subscribe === 'function') {
    const handle = subscribe(projectId, opts);
    const raws = new Set<(raw: string) => void>();
    const statuses = new Set<(s: { open: boolean; fatalCode?: number }) => void>();
    const off = handle.on('*', (payload, id, type) => {
      if (type === 'channel.status') {
        const st = payload as { open: boolean; fatalCode?: number };
        for (const l of statuses) l(st);
        return;
      }
      const raw = JSON.stringify({ type, id, payload });
      for (const l of raws) l(raw);
    });
    return {
      send: (raw) => {
        const m = JSON.parse(raw) as Envelope;
        handle.send(m.type, m.payload, m.id);
      },
      onMessage: (l) => (raws.add(l), () => raws.delete(l)),
      onStatus: (l) => (statuses.add(l), () => statuses.delete(l)),
      unsubscribe: () => {
        off();
        handle.unsubscribe();
      },
    };
  }
  // TODO(realtime, D-014): remove once lib/realtime exports subscribeProject.
  const socket = new EnvelopeSocket(`/projects/${encodeURIComponent(projectId)}/ws`);
  const statuses = new Set<(s: { open: boolean; fatalCode?: number; neverOpened?: boolean }) => void>();
  let opened = false;
  socket.onOpen = () => {
    opened = true;
    for (const l of statuses) l({ open: true });
  };
  socket.onClose = (code, final) => {
    const fatalCode = code >= 4400 && code < 4500 ? code : undefined;
    if (final && !fatalCode) return;
    for (const l of statuses) l({ open: false, fatalCode, neverOpened: !opened });
  };
  return {
    send: (raw) => socket.send(raw),
    onMessage: (l) => socket.subscribeRaw(l),
    onStatus: (l) => (statuses.add(l), () => statuses.delete(l)),
    unsubscribe: () => socket.close(),
  };
}

/* ---------- Media ---------- */

/**
 * Signed-in redirect to a short-lived signed URL (`GET /api/media/private/:assetId`
 * → 302, D-008: the API never carries the bytes). Good for `<img>` / `<video>`
 * sources and as a `refreshUrl` for downloads.
 */
export function assetMediaUrl(assetId: string): string {
  const dev = devUser();
  return `/api/media/private/${encodeURIComponent(assetId)}${dev ? `?devUser=${encodeURIComponent(dev)}` : ''}`;
}

/* ---------- Resume after checkout ---------- */

const PENDING_KEY = 'rolling.pendingAction';

export interface PendingAction {
  /** Feature that resumes it, e.g. `canvas.run`, `home.agent`, `tools.run`. */
  kind: string;
  data: unknown;
  at: number;
}

/** Keeps the action the paywall interrupted so it resumes after checkout (D-007), even across the Stripe redirect. */
export function savePendingAction(kind: string, data: unknown) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ kind, data, at: Date.now() } satisfies PendingAction));
  } catch {
    /* Storage unavailable: the action is lost after a redirect. */
  }
}

/** Takes (and clears) the pending action of `kind`, if one is younger than an hour. */
export function takePendingAction<T>(kind: string): T | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingAction;
    if (p.kind !== kind || Date.now() - p.at > 3_600_000) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return p.data as T;
  } catch {
    return null;
  }
}
