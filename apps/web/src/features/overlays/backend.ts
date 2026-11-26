/**
 * Creation-side backend access (canvas, editor, agent, Home, tools, Activity,
 * assets), on top of `lib/api` (typed client, mode, errors) and
 * `lib/realtime` (D-014: one shared connection, user and project channels).
 *
 * Mode: `VITE_API_MODE=mock` (set by the Playwright config for the fidelity
 * and interaction specs, and by Vitest) keeps every creation feature on its
 * mocks; anything else talks to `/api`.
 */

import { apiRequest, ApiError, isApiError, apiMode, isMockApi, type ApiErrorCode, type ApiMode } from '@/lib/api';
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

/* ---------- Realtime (D-014: one shared connection in lib/realtime) ---------- */

export interface Envelope<P = unknown> {
  type: string;
  id: string;
  payload: P;
}

/**
 * UserHub events through `lib/realtime`'s user channel (D-014: one shared
 * connection): `credits.changed`, `activity.updated`, `agent.*` and
 * `proposal.*` of Home and tool threads.
 */
export function userEvents(listener: (msg: Envelope) => void): () => void {
  if (isMockApi()) return () => {};
  return realtime.realtime.user.onAny((type, payload, id) => listener({ type, id, payload }));
}

/* ---------- Project channel (D-014) ---------- */

/**
 * The canvas' view of a project channel of the shared realtime connection
 * (`realtime.subscribeProject`). The canvas sync speaks raw envelopes with its
 * own message ids; this adapter maps them to the channel's ids both ways and
 * turns `subscribed { snapshot }` into a `snapshot`.
 */
export interface ProjectChannel {
  /** Envelope text to the room (`patch`, `timeline.patch`, `snapshot`); the reply comes back with the same id. */
  send(raw: string): void;
  /** Every server message of this project (as envelope text). */
  onMessage(listener: (raw: string) => void): () => void;
  /** Connection state; `fatalCode` 4401/4403/4404/4410 when the project can't be used any more. */
  onStatus(listener: (s: { open: boolean; fatalCode?: number }) => void): () => void;
  unsubscribe(): void;
}

const FATAL_CODES: Record<string, number> = { UNAUTHENTICATED: 4401, FORBIDDEN: 4403, NOT_FOUND: 4404, PROJECT_DELETED: 4410 };

export function openProjectChannel(projectId: string): ProjectChannel {
  const channel = realtime.realtime.subscribeProject(projectId, {});
  const ours = new Map<string, string>();
  const raws = new Set<(raw: string) => void>();
  const statuses = new Set<(s: { open: boolean; fatalCode?: number }) => void>();
  /** Project events that arrive before `subscribed` (D-014 catch-up): applied after it. */
  let buffer: Array<{ type: string; id: string; payload: unknown }> | null = [];
  /** This handle has applied a full snapshot (a second subscriber of a project the hub already follows gets only `events`). */
  let hasSnapshot = false;
  const emit = (type: string, id: string, payload: unknown) => {
    const raw = JSON.stringify({ type, id, payload });
    for (const l of raws) l(raw);
  };
  /** Keeps the hub's catch-up cursor at the last graph revision this tab applied. */
  const track = (type: string, payload: unknown) => {
    const p = payload as { revision?: unknown; canvasId?: unknown } | null;
    if (typeof p?.revision !== 'number' || (type !== 'ack' && type !== 'graph.patched' && type !== 'snapshot') || p.canvasId !== undefined) return;
    channel.setRevision(p.revision);
  };
  const offAny = channel.onAny((type, payload, id) => {
    const mine = ours.get(id);
    if (mine) ours.delete(id);
    if (type === 'subscribed') {
      // `{ projectId, revision, seq, canEdit, snapshot?, events? }`: a snapshot, or the events since our cursor.
      const p = payload as { canEdit?: boolean; snapshot?: { revision: number }; events?: Array<{ seq: number; type: string; payload: unknown }> };
      emit('hello', id, { actor: '', canEdit: p.canEdit !== false });
      if (p.snapshot) {
        hasSnapshot = true;
        emit('snapshot', id, p.snapshot);
        track('snapshot', p.snapshot);
      } else if (!hasSnapshot) {
        // Catch-up only makes sense on top of a snapshot this handle has: ask for one.
        channel.send('snapshot', {});
      }
      for (const e of p.events ?? []) {
        emit(e.type, `${id}:${e.seq}`, e.payload);
        track(e.type, e.payload);
      }
      for (const e of buffer ?? []) emit(e.type, e.id, e.payload);
      buffer = null;
      for (const l of statuses) l({ open: true });
      return;
    }
    if (type === 'unsubscribed') return;
    if (type === 'snapshot') hasSnapshot = true;
    if (type === 'error' && !mine) {
      const code = (payload as { code?: string })?.code ?? '';
      if (FATAL_CODES[code]) for (const l of statuses) l({ open: false, fatalCode: FATAL_CODES[code] });
    }
    if (buffer && !mine && type !== 'error') {
      buffer.push({ type, id, payload });
      return;
    }
    emit(type, mine ?? id, payload);
    track(type, payload);
  });
  let lastStatus: string = realtime.realtime.user.status;
  const offStatus = realtime.realtime.user.onEvent('status', (st) => {
    const was = lastStatus;
    lastStatus = st;
    if (st === was) return;
    // A dropped connection: the hub re-subscribes on reconnect; buffer until its `subscribed` answer.
    if (was === 'open' && (st === 'retrying' || st === 'closed')) {
      buffer ??= [];
      for (const l of statuses) l({ open: false });
    }
  });
  const offClosed = realtime.realtime.user.onEvent('closed', (code) => {
    if (code >= 4400 && code < 4500) for (const l of statuses) l({ open: false, fatalCode: code });
  });
  return {
    send: (raw) => {
      const m = JSON.parse(raw) as Envelope<Record<string, unknown> | null>;
      const id = channel.send(m.type, m.payload ?? {});
      ours.set(id, m.id);
    },
    onMessage: (l) => {
      raws.add(l);
      return () => raws.delete(l);
    },
    onStatus: (l) => {
      statuses.add(l);
      return () => statuses.delete(l);
    },
    unsubscribe: () => {
      offAny();
      offStatus();
      offClosed();
      channel.unsubscribe();
    },
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

/**
 * Poster of a video served through `assetMediaUrl` (`?variant=poster`: the provider's poster or a still taken from
 * the clip). Undefined for any other URL, so `<video poster>` is simply left out.
 */
export function posterUrl(src: string | null | undefined): string | undefined {
  if (!src || !src.startsWith('/api/media/private/')) return undefined;
  return `${src}${src.includes('?') ? '&' : '?'}variant=poster`;
}

/* ---------- Resume after checkout ---------- */

/**
 * Keeps the action the paywall interrupted so it resumes after checkout
 * (D-007), even across the Stripe redirect: stored per checkout session in
 * `lib/session/pending` and replayed from `onCheckoutResume` listeners.
 */
export { hasPendingAction, savePendingAction, takePendingAction, type PendingAction } from '@/lib/session/pending';
