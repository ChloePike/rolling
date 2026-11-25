import { Connection, type ConnectionOptions } from './connection';
import type { HubMessage, PortLike, TabMessage } from './protocol';

/**
 * The realtime hub (D-014): owns the browser's one WebSocket to `/api/ws` and
 * multiplexes it for every tab.
 *
 * - User channel: always on while any tab is signed in; every envelope without
 *   a project goes to every tab.
 * - Project channels: tabs subscribe by project; subscriptions are ref-counted
 *   so several tabs on one project share one server subscription. The last
 *   tab leaving sends `unsubscribe`.
 * - Replies (`ack`, `conflict`, `error`, `subscribed`) to a tab's message are
 *   routed back to that tab by envelope id (or `payload.id`).
 * - After a reconnect every open project is re-subscribed with the last
 *   `seq` the hub forwarded (`lastSeq`, preferred) and the lowest revision its
 *   tabs reported (`lastRevision`); the `subscribed` answer (snapshot or
 *   `events`) goes to all of the project's tabs.
 * - The server sends the patch sender `ack` instead of its own
 *   `graph.patched`. Since one socket serves every tab, the hub fans the
 *   change out to the sender's sibling tabs as a `graph.patched` /
 *   `timeline.patched` marked `synthetic` (built from the sent ops, or the
 *   ops an undo/redo `ack` returns).
 *
 * A tab joining a project that is already subscribed sends its own
 * `subscribe` (with its id) so the server answers it with a snapshot or the
 * patches it missed; the server treats a repeated subscribe on the same socket
 * as the same subscription.
 */

interface SubState {
  port: PortLike;
  projectId: string;
  revision?: number;
}

interface ProjectState {
  subs: Set<string>;
  revision?: number;
  /** Last event cursor forwarded for this project (D-014 `seq`). */
  seq?: number;
}

interface PendingReply {
  port: PortLike;
  sub?: string;
  /** The command, kept to fan an `ack` out to sibling tabs. */
  type?: string;
  payload?: unknown;
  /** Hub-originated (resubscribe): answer every subscriber of the project. */
  projectId?: string;
  at: number;
}

const REPLY_TYPES = new Set(['ack', 'conflict', 'error', 'subscribed', 'unsubscribed', 'pong', 'snapshot']);
const REPLY_TTL_MS = 60_000;

export interface HubOptions extends ConnectionOptions {
  /** Test seam: build the connection. */
  connection?: Connection;
}

export class RealtimeHub {
  readonly conn: Connection;
  private ports = new Map<PortLike, { wants: boolean; subs: Set<string> }>();
  private subs = new Map<string, SubState>();
  private projects = new Map<string, ProjectState>();
  private replies = new Map<string, PendingReply>();
  private seq = 0;

  constructor(opts: HubOptions = {}) {
    this.conn = opts.connection ?? new Connection(opts);
    this.conn.onAny((type, payload, id, raw) => this.route(type, payload, id, raw));
    this.conn.onOpen(() => this.resubscribeAll());
    this.conn.onEvent('status', (status) => this.broadcast({ t: 'status', status }));
    this.conn.onEvent('unauthorized', () => this.broadcast({ t: 'event', event: 'unauthorized', code: 4401 }));
    this.conn.onEvent('closed', (code) => this.broadcast({ t: 'event', event: 'closed', code }));
    this.conn.onEvent('failure', (attempt) => this.broadcast({ t: 'event', event: 'failure', attempt }));
  }

  /** Registers a tab; returns its message handler. */
  connect(port: PortLike): (msg: TabMessage) => void {
    this.ports.set(port, { wants: false, subs: new Set() });
    port.postMessage({ t: 'status', status: this.conn.status });
    return (msg) => this.handle(port, msg);
  }

  /** The tab is gone: drop its subscriptions and its claim on the socket. */
  disconnect(port: PortLike) {
    const p = this.ports.get(port);
    if (!p) return;
    for (const sub of [...p.subs]) this.unsubscribe(sub);
    this.ports.delete(port);
    this.syncWanted();
  }

  private handle(port: PortLike, msg: TabMessage) {
    const p = this.ports.get(port) ?? { wants: false, subs: new Set<string>() };
    if (!this.ports.has(port)) this.ports.set(port, p);
    switch (msg.t) {
      case 'start':
        p.wants = true;
        if (msg.restart) this.conn.reconnect();
        else this.syncWanted();
        return;
      case 'stop':
        p.wants = false;
        this.syncWanted();
        return;
      case 'bye':
        this.disconnect(port);
        return;
      case 'subscribe': {
        this.subs.set(msg.sub, { port, projectId: msg.projectId, revision: msg.lastRevision });
        p.subs.add(msg.sub);
        let proj = this.projects.get(msg.projectId);
        if (!proj) this.projects.set(msg.projectId, (proj = { subs: new Set(), revision: msg.lastRevision, seq: msg.lastSeq }));
        proj.subs.add(msg.sub);
        this.syncWanted();
        if (this.conn.isOpen) {
          this.expect(msg.req, { port, sub: msg.sub, at: Date.now() });
          this.conn.send(
            'subscribe',
            {
              channel: 'project',
              projectId: msg.projectId,
              ...(msg.lastSeq !== undefined ? { lastSeq: msg.lastSeq } : {}),
              ...(msg.lastRevision !== undefined ? { lastRevision: msg.lastRevision } : {}),
            },
            msg.req,
          );
        }
        // Not connected: `resubscribeAll` on open answers every subscriber.
        return;
      }
      case 'unsubscribe':
        this.unsubscribe(msg.sub);
        this.syncWanted();
        return;
      case 'revision': {
        const s = this.subs.get(msg.sub);
        if (s) s.revision = Math.max(s.revision ?? 0, msg.revision);
        return;
      }
      case 'send': {
        this.expect(msg.id, { port, sub: msg.sub, type: msg.type, payload: msg.payload, at: Date.now() });
        if (!this.conn.send(msg.type, msg.payload, msg.id)) {
          this.replies.delete(msg.id);
          port.postMessage({ t: 'unsent', id: msg.id });
        }
        return;
      }
    }
  }

  private syncWanted() {
    // Signed-in tabs keep the user channel up; an open project channel does too.
    const wanted = [...this.ports.values()].some((p) => p.wants || p.subs.size > 0);
    if (wanted && (this.conn.status === 'idle' || this.conn.status === 'closed')) this.conn.start();
    else if (!wanted && this.conn.status !== 'idle' && this.conn.status !== 'closed') this.conn.stop();
  }

  private unsubscribe(sub: string) {
    const s = this.subs.get(sub);
    if (!s) return;
    this.subs.delete(sub);
    this.ports.get(s.port)?.subs.delete(sub);
    const proj = this.projects.get(s.projectId);
    if (!proj) return;
    proj.subs.delete(sub);
    if (proj.subs.size === 0) {
      this.projects.delete(s.projectId);
      this.conn.send('unsubscribe', { projectId: s.projectId });
    }
  }

  private expect(id: string, r: PendingReply) {
    const now = Date.now();
    for (const [k, v] of this.replies) if (now - v.at > REPLY_TTL_MS) this.replies.delete(k);
    this.replies.set(id, r);
  }

  private resubscribeAll() {
    for (const [projectId, proj] of this.projects) {
      const known = [...proj.subs].map((s) => this.subs.get(s)?.revision).filter((r): r is number => typeof r === 'number');
      const lastRevision = known.length ? Math.min(...known) : proj.revision;
      const req = `h${++this.seq}`;
      const anyPort = this.subs.get([...proj.subs][0]!)?.port;
      if (anyPort) this.expect(req, { port: anyPort, projectId, at: Date.now() });
      this.conn.send(
        'subscribe',
        { channel: 'project', projectId, ...(proj.seq !== undefined ? { lastSeq: proj.seq } : {}), ...(lastRevision !== undefined ? { lastRevision } : {}) },
        req,
      );
    }
  }

  private trackRevision(projectId: string, payload: unknown) {
    const p = payload as { revision?: unknown; snapshot?: { revision?: unknown } } | null;
    const r = typeof p?.revision === 'number' ? p.revision : typeof p?.snapshot?.revision === 'number' ? p.snapshot.revision : null;
    const proj = this.projects.get(projectId);
    if (proj && r !== null) proj.revision = Math.max(proj.revision ?? 0, r);
  }

  private route(type: string, payload: unknown, id: string, raw: Record<string, unknown>) {
    const pl = payload as { id?: unknown; projectId?: unknown } | null;
    const projectId = typeof raw.projectId === 'string' ? raw.projectId : typeof pl?.projectId === 'string' ? pl.projectId : undefined;
    const channel: 'user' | 'project' = raw.channel === 'project' || (raw.channel === undefined && projectId && this.projects.has(projectId)) ? 'project' : 'user';
    const seq = typeof raw.seq === 'number' ? raw.seq : undefined;
    if (projectId) {
      this.trackRevision(projectId, payload);
      const proj = this.projects.get(projectId);
      const cursor = seq ?? (type === 'subscribed' && typeof (payload as { seq?: unknown })?.seq === 'number' ? (payload as { seq: number }).seq : undefined);
      if (proj && cursor !== undefined) proj.seq = Math.max(proj.seq ?? 0, cursor);
    }

    const replyId = this.replies.has(id) ? id : typeof pl?.id === 'string' && this.replies.has(pl.id) ? pl.id : null;
    if (replyId && REPLY_TYPES.has(type)) {
      const r = this.replies.get(replyId)!;
      this.replies.delete(replyId);
      if (!r.projectId) {
        r.port.postMessage({ t: 'msg', type, id, payload, channel, projectId, seq, subs: r.sub ? [r.sub] : undefined });
        if (type === 'ack' && r.sub) this.fanOutAck(r, payload);
        return;
      }
    }

    if (channel === 'project' && projectId) {
      const proj = this.projects.get(projectId);
      if (!proj) return;
      const byPort = new Map<PortLike, string[]>();
      for (const sub of proj.subs) {
        const s = this.subs.get(sub);
        if (!s) continue;
        byPort.set(s.port, [...(byPort.get(s.port) ?? []), sub]);
      }
      for (const [port, subs] of byPort) port.postMessage({ t: 'msg', type, id, payload, channel, projectId, seq, subs });
      return;
    }
    this.broadcast({ t: 'msg', type, id, payload, channel: 'user' });
  }

  /** The sender's own change, as the event its sibling subscribers would otherwise miss (same socket). */
  private fanOutAck(r: PendingReply, payload: unknown) {
    const from = this.subs.get(r.sub!);
    if (!from) return;
    const proj = this.projects.get(from.projectId);
    if (!proj) return;
    const ack = (payload ?? {}) as { revision?: number; ops?: unknown[]; idMap?: unknown; canvasId?: string };
    const sent = (r.payload ?? {}) as { ops?: unknown[]; canvasId?: string };
    let type: string;
    let event: Record<string, unknown>;
    if (r.type === 'patch' || r.type === 'undo' || r.type === 'redo') {
      const ops = ack.ops ?? sent.ops;
      if (!ops) return;
      type = 'graph.patched';
      event = { revision: ack.revision, ops, actor: 'self', ...(ack.idMap ? { idMap: ack.idMap } : {}) };
    } else if (r.type === 'timeline.patch') {
      type = 'timeline.patched';
      event = { revision: ack.revision, canvasId: ack.canvasId ?? sent.canvasId, ops: sent.ops ?? [], actor: 'self' };
    } else return;
    const byPort = new Map<PortLike, string[]>();
    for (const sub of proj.subs) {
      if (sub === r.sub) continue;
      const s = this.subs.get(sub);
      if (s) byPort.set(s.port, [...(byPort.get(s.port) ?? []), sub]);
    }
    for (const [port, subs] of byPort) port.postMessage({ t: 'msg', type, id: `${r.sub}:ack`, payload: event, channel: 'project', projectId: from.projectId, subs, synthetic: true });
  }

  private broadcast(msg: HubMessage) {
    for (const port of this.ports.keys()) {
      try {
        port.postMessage(msg);
      } catch {
        this.ports.delete(port);
      }
    }
  }
}
