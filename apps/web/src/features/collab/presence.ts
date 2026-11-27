import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { PRESENCE_CLIENT_THROTTLE_MS, PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS, throttle, type PresenceCursor, type PresenceEntry } from '@rolling/core/collab';
import { subscribeProjectMessages } from '@/features/canvas/api';
import { isMockApi } from '@/features/overlays/backend';
import { realtime } from '@/lib/realtime';

/**
 * Canvas presence client (D-031). Sends this tab's cursor (flow coordinates,
 * throttled to one message per 50 ms) and selection on the project channel
 * of the shared socket, repeats it every 15 s, asks for everyone on open and
 * after a reconnect (`presence.sync`), and says `presence.leave` on close.
 * Keeps the other people's entries for the cursor layer and the avatars.
 *
 * Mock mode has no socket: entries come only from the test seam
 * `window.__collabPresence` (`set(entry)`, `remove(id)`).
 */

type Send = (raw: string) => void;

declare global {
  interface Window {
    /** Test seam (mock mode): inject or remove other people's presence. */
    __collabPresence?: { set(entry: PresenceEntry): void; remove(id: string): void; sent: unknown[] };
  }
}

const tabKey = () => Math.random().toString(36).slice(2, 10);

export class PresenceClient {
  readonly key = tabKey();
  private entries = new Map<string, PresenceEntry>();
  private snapshot: PresenceEntry[] = [];
  private listeners = new Set<() => void>();
  private cursor: PresenceCursor | null = null;
  private selection: string[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private offs: Array<() => void> = [];
  private n = 0;
  readonly sendCursor = throttle(() => this.push({ cursor: this.cursor }), PRESENCE_CLIENT_THROTTLE_MS);

  constructor(
    readonly projectId: string,
    private readonly send: Send | null,
  ) {}

  start(): void {
    if (this.send) {
      this.offs.push(
        subscribeProjectMessages(this.projectId, (msg) => {
          if (msg.type === 'presence.updated') this.upsert((msg.payload as { entry: PresenceEntry }).entry);
          else if (msg.type === 'presence.left') this.remove((msg.payload as { id: string }).id);
          else if (msg.type === 'presence.state') {
            this.entries.clear();
            for (const e of (msg.payload as { entries: PresenceEntry[] }).entries ?? []) this.upsert(e, false);
            this.publish();
          }
        }),
      );
      let last = realtime.status;
      this.offs.push(
        realtime.user.onEvent('status', (s) => {
          // The hub re-subscribes after a reconnect; announce ourselves and fetch everyone again.
          if (s === 'open' && last !== 'open') setTimeout(() => this.announce(), 300);
          last = s;
        }),
      );
      this.announce();
      this.timers.push(setInterval(() => this.push({ cursor: this.cursor, selection: this.selection }), PRESENCE_HEARTBEAT_MS));
    }
    this.timers.push(
      setInterval(() => {
        const cutoff = Date.now() - PRESENCE_TTL_MS;
        let changed = false;
        for (const [id, e] of this.entries) if (e.at < cutoff && !id.startsWith('mock:')) changed = this.entries.delete(id) || changed;
        if (changed) this.publish();
      }, PRESENCE_HEARTBEAT_MS),
    );
  }

  stop(): void {
    this.sendCursor.cancel();
    for (const t of this.timers) clearInterval(t);
    for (const off of this.offs) off();
    this.timers = [];
    this.offs = [];
    this.raw('presence.leave', {});
  }

  private announce() {
    this.push({ cursor: this.cursor, selection: this.selection });
    this.raw('presence.sync', {});
  }

  private raw(type: string, payload: Record<string, unknown>) {
    const body = { key: this.key, ...payload };
    if (typeof window !== 'undefined' && window.__collabPresence) window.__collabPresence.sent.push({ type, ...body });
    if (!this.send) return;
    try {
      this.send(JSON.stringify({ type, id: `pr${this.key}.${++this.n}`, payload: body }));
    } catch {
      // Not connected: the next heartbeat or reconnect sends it.
    }
  }

  private push(payload: { cursor?: PresenceCursor | null; selection?: string[] }) {
    this.raw('presence', payload);
  }

  setCursor(c: PresenceCursor | null): void {
    this.cursor = c ? { x: Math.round(c.x), y: Math.round(c.y) } : null;
    this.sendCursor();
  }

  setSelection(ids: string[]): void {
    if (ids.length === this.selection.length && ids.every((x, i) => x === this.selection[i])) return;
    this.selection = ids.slice(0, 50);
    this.push({ selection: this.selection });
  }

  upsert(e: PresenceEntry, publish = true): void {
    this.entries.set(e.id, e);
    if (publish) this.publish();
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.publish();
  }

  private publish() {
    this.snapshot = [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;
}

/** One person per user id (several tabs show one avatar). */
export function peopleOf(entries: readonly PresenceEntry[]): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>();
  for (const e of entries) {
    const prev = byUser.get(e.userId);
    if (!prev || e.at > prev.at) byUser.set(e.userId, e);
  }
  return [...byUser.values()];
}

/**
 * Presence of a project while mounted. `send` is the canvas session's raw
 * envelope sender (real mode); `selection` is this tab's selected node ids.
 */
export function useProjectPresence(projectId: string, send: Send | undefined, selection: readonly string[]): { client: PresenceClient; entries: PresenceEntry[] } {
  const client = useMemo(() => new PresenceClient(projectId, isMockApi() ? null : (send ?? null)), [projectId, send]);
  useEffect(() => {
    client.start();
    if (isMockApi() && typeof window !== 'undefined') {
      const prev = window.__collabPresence;
      window.__collabPresence = {
        set: (e) => client.upsert({ ...e, id: e.id.startsWith('mock:') ? e.id : `mock:${e.id}` }),
        remove: (id) => client.remove(id.startsWith('mock:') ? id : `mock:${id}`),
        sent: prev?.sent ?? [],
      };
    }
    return () => client.stop();
  }, [client]);
  const key = selection.join(',');
  useEffect(() => {
    client.setSelection(key ? key.split(',') : []);
  }, [client, key]);
  const entries = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return { client, entries };
}
