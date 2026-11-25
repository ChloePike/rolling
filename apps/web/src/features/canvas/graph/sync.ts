import { fromSnapshot, messageId, type ClientMessage, type ServerMessage } from '@rolling/core/graph';
import { applyOps, normalizeOps, type ApplyResult, type GraphStore, type LocalOp } from './store';
import type { Transport } from './transport';
import type { GraphState, NodeStatus, Refusal } from '@rolling/core/graph';

export type SyncStatus = 'connecting' | 'saving' | 'saved' | 'offline';

/** Active version of a node's result (`snapshot.nodes[].asset_id`, `node.version`, `job.done`). */
export interface NodeMedia {
  assetId: string | null;
  versionId?: string;
  /** D-005 content rating of the active version; `suggestive` / `explicit` thumbnails stay blurred until clicked. */
  rating?: 'safe' | 'suggestive' | 'explicit' | null;
}

/** Envelope the sync layer does not handle itself (agent, proposals, timeline, unsolicited errors). */
export interface ForwardedMessage {
  type: string;
  id: string;
  payload: unknown;
}

export interface SyncEvents {
  /** The server refused a patch the client thought was valid, or a rebase dropped it. */
  onRefused?: (refusal: Refusal) => void;
  onJobDone?: (nodeId: string) => void;
  onJobFailed?: (nodeId: string, refunded: number) => void;
  onCredits?: (balance: number, held: number, extra?: { plan?: number; purchased?: number }) => void;
  /** `hello { canEdit }`: viewers get a read-only canvas. */
  onHello?: (info: { actor: string; canEdit: boolean }) => void;
  /** Messages for other layers: `agent.*`, `proposal.*`, `timeline.patched`, `error` without a pending patch (e.g. PROJECT_DELETED). */
  onMessage?: (msg: ForwardedMessage) => void;
}

interface Pending {
  id: string;
  ops: LocalOp[];
}

/**
 * Optimistic sync between the local GraphStore and a ProjectRoom socket.
 * Local edits apply at once and go out as `patch { baseRevision, ops }`;
 * `ack` confirms, `conflict` replaces the confirmed state with the server
 * snapshot and replays the edits still in flight, `graph.patched` brings in
 * other people's edits.
 */
export class ProjectSync {
  private confirmed: GraphState | null = null;
  private pending: Pending[] = [];
  private listeners = new Set<() => void>();
  private off: () => void;
  status: SyncStatus = 'connecting';
  /** False for viewers (`hello.canEdit`); local edits are then refused before they are sent. */
  canEdit = true;
  private media = new Map<string, NodeMedia>();
  private mediaListeners = new Set<() => void>();
  private mediaVersion = 0;

  constructor(
    private readonly store: GraphStore,
    private readonly transport: Transport,
    private readonly events: SyncEvents = {},
  ) {
    this.off = transport.onMessage((raw) => this.receive(raw));
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getStatus = () => this.status;

  /** The transport lost or regained its connection (real socket only). */
  setConnected(connected: boolean) {
    if (!connected) this.setStatus('offline');
    else if (this.status === 'offline') this.setStatus(this.pending.length ? 'saving' : 'connecting');
  }

  /** Active result asset per node, for thumbnails and the result viewer. */
  getMedia = (nodeId: string): NodeMedia | undefined => this.media.get(nodeId);
  subscribeMedia = (l: () => void) => {
    this.mediaListeners.add(l);
    return () => this.mediaListeners.delete(l);
  };
  getMediaVersion = () => this.mediaVersion;

  private setMedia(nodeId: string, media: NodeMedia | null) {
    if (media) this.media.set(nodeId, media);
    else this.media.delete(nodeId);
    this.mediaVersion++;
    for (const l of this.mediaListeners) l();
  }

  /** Server-derived statuses (`statuses: { nodeId: status }` on ack, graph.patched, node.version). */
  private applyStatuses(statuses: unknown) {
    if (!statuses || typeof statuses !== 'object') return;
    for (const [nodeId, status] of Object.entries(statuses as Record<string, NodeStatus>)) {
      if (typeof status === 'string') this.runtime(nodeId, { status });
    }
  }

  private setStatus(s: SyncStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.listeners) l();
  }

  /** Applies `ops` locally and sends them. Refusals return without sending. */
  commit(ops: LocalOp[], options: { record?: boolean; actor?: 'user' | 'agent' } = {}): ApplyResult {
    if (!this.canEdit) return { ok: false, refusal: { code: 'NODE_NOT_FOUND', message: 'You can view this project but not edit it.', data: { reason: 'READ_ONLY' } } };
    const normalized = normalizeOps(ops);
    const result = this.store.apply(normalized, options);
    if (!result.ok) return result;
    this.send(normalized);
    // Report the caller's own temp ids too (normalizeOps replaced them).
    const idMap = { ...result.idMap };
    ops.forEach((op, i) => {
      const n = normalized[i];
      if (op.op === 'addNode' && n?.op === 'addNode') idMap[op.tempId] = n.tempId;
    });
    return { ...result, idMap };
  }

  undo(): ApplyResult | null {
    if (!this.canEdit) return null;
    const out = this.store.undo();
    if (out?.result.ok && out.ops.length) this.send(out.ops);
    return out?.result ?? null;
  }

  redo(): ApplyResult | null {
    if (!this.canEdit) return null;
    const out = this.store.redo();
    if (out?.result.ok && out.ops.length) this.send(out.ops);
    return out?.result ?? null;
  }

  private send(ops: LocalOp[]) {
    const base = (this.confirmed?.revision ?? 0) + this.pending.length;
    const id = messageId();
    this.pending.push({ id, ops });
    this.setStatus('saving');
    const msg: ClientMessage = { type: 'patch', id, payload: { baseRevision: base, ops } };
    this.transport.send(JSON.stringify(msg));
  }

  private resend() {
    const all = this.pending.splice(0);
    let state = this.confirmed!;
    for (const p of all) {
      const r = applyOps(state, p.ops);
      if (!r.ok) {
        this.events.onRefused?.(r.refusal);
        continue;
      }
      state = r.state;
      const base = this.confirmed!.revision + this.pending.length;
      this.pending.push(p);
      this.transport.send(JSON.stringify({ type: 'patch', id: p.id, payload: { baseRevision: base, ops: p.ops } } satisfies ClientMessage));
    }
    this.store.rebase({ ...state, revision: this.confirmed!.revision + this.pending.length });
  }

  /** Optimistic view = confirmed + pending, keeping runtime fields from the store. */
  private rebuild() {
    let state = this.confirmed!;
    const kept: Pending[] = [];
    for (const p of this.pending) {
      const r = applyOps(state, p.ops);
      if (r.ok) {
        state = r.state;
        kept.push(p);
      }
    }
    this.pending = kept;
    this.store.rebase({ ...state, revision: this.confirmed!.revision + kept.length });
  }

  private receive(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        const p = msg.payload as { actor: string; canEdit?: boolean };
        this.canEdit = p.canEdit !== false;
        this.events.onHello?.({ actor: p.actor, canEdit: this.canEdit });
        return;
      }
      case 'snapshot': {
        const first = this.confirmed === null;
        this.confirmed = fromSnapshot(msg.payload);
        for (const row of msg.payload.nodes as Array<{ id: string; asset_id?: string | null; active_version_id?: string | null; version_rating?: NodeMedia['rating'] }>) {
          if (row.asset_id) this.media.set(row.id, { assetId: row.asset_id, versionId: row.active_version_id ?? undefined, rating: row.version_rating ?? null });
        }
        this.mediaVersion++;
        for (const l of this.mediaListeners) l();
        if (first || !this.pending.length) {
          this.pending = [];
          this.store.replace(this.confirmed);
        } else {
          // Reconnected with edits in flight: keep them on top; their ack (or conflict) follows.
          this.rebuild();
        }
        this.setStatus(this.pending.length ? 'saving' : 'saved');
        return;
      }
      case 'ack': {
        const idx = this.pending.findIndex((p) => p.id === msg.id);
        if (idx < 0) {
          // Not a graph patch of ours (e.g. the editor's `timeline.patch`).
          this.events.onMessage?.(msg as ForwardedMessage);
          return;
        }
        if (!this.confirmed) return;
        const [done] = this.pending.splice(idx, 1);
        const r = applyOps(this.confirmed, done!.ops);
        if (r.ok) this.confirmed = { ...r.state, revision: msg.payload.revision };
        this.store.setRevision(this.confirmed.revision + this.pending.length);
        this.applyStatuses((msg.payload as { statuses?: unknown }).statuses);
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'conflict': {
        if (!('snapshot' in (msg.payload as object))) {
          this.events.onMessage?.(msg as ForwardedMessage);
          return;
        }
        this.confirmed = fromSnapshot(msg.payload.snapshot);
        this.resend();
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'error': {
        const idx = this.pending.findIndex((p) => p.id === msg.id);
        if (idx < 0) {
          this.events.onMessage?.(msg as ForwardedMessage);
          return;
        }
        this.pending.splice(idx, 1);
        const data = msg.payload.data as Refusal | undefined;
        this.events.onRefused?.(data && typeof data === 'object' && 'code' in data ? data : { code: 'NODE_NOT_FOUND', message: msg.payload.message });
        if (this.confirmed) this.rebuild();
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'graph.patched': {
        // Catch-up after a reconnect may repeat events this tab already applied.
        if (!this.confirmed || msg.payload.revision <= this.confirmed.revision) return;
        const r = applyOps(this.confirmed, msg.payload.ops, undefined, msg.payload.actor === 'agent' ? 'agent' : 'user');
        if (!r.ok) return;
        this.confirmed = { ...r.state, revision: msg.payload.revision };
        if (!this.pending.length) {
          // Build-in animation for nodes others (or the agent) added.
          this.store.apply(msg.payload.ops, { record: false, actor: msg.payload.actor === 'agent' ? 'agent' : 'user' });
          this.store.setRevision(this.confirmed.revision);
        } else {
          this.rebuild();
        }
        this.applyStatuses((msg.payload as { statuses?: unknown }).statuses);
        return;
      }
      case 'job.queued': {
        this.runtime(msg.payload.nodeId, { status: 'queued', progress: 0 });
        return;
      }
      case 'node.version': {
        const p = msg.payload as {
          nodeId: string;
          version: { id?: string; n: number; total: number; assetId?: string | null; rating?: NodeMedia['rating'] } | null;
          status?: NodeStatus;
          statuses?: unknown;
        };
        if (p.version) {
          this.runtime(p.nodeId, { version: { n: p.version.n, total: p.version.total } });
          if (p.version.assetId !== undefined) this.setMedia(p.nodeId, { assetId: p.version.assetId, versionId: p.version.id, rating: p.version.rating ?? null });
        }
        if (p.status) this.runtime(p.nodeId, { status: p.status, progress: undefined });
        this.applyStatuses(p.statuses);
        return;
      }
      case 'job.progress': {
        const p = msg.payload as { nodeId: string; progress: number; status?: 'queued' | 'generating' };
        this.runtime(p.nodeId, { status: p.status === 'queued' ? 'queued' : 'generating', progress: p.progress });
        return;
      }
      case 'job.done': {
        const p = msg.payload as { nodeId: string; version?: { n: number; total: number }; assetId?: string };
        this.runtime(p.nodeId, { status: 'done', progress: 1, ...(p.version ? { version: p.version } : {}) });
        if (p.assetId) this.setMedia(p.nodeId, { assetId: p.assetId });
        this.events.onJobDone?.(p.nodeId);
        return;
      }
      case 'job.failed': {
        this.runtime(msg.payload.nodeId, { status: 'failed', refunded: msg.payload.refunded });
        this.events.onJobFailed?.(msg.payload.nodeId, msg.payload.refunded);
        return;
      }
      case 'credits.changed': {
        const p = msg.payload as { balance: number; held: number; plan?: number; purchased?: number };
        this.events.onCredits?.(p.balance, p.held, { plan: p.plan, purchased: p.purchased });
        return;
      }
      default:
        this.events.onMessage?.(msg as ForwardedMessage);
        return;
    }
  }

  private runtime(nodeId: string, patch: Parameters<GraphStore['setRuntime']>[1]) {
    if (this.confirmed) {
      this.confirmed = { ...this.confirmed, nodes: this.confirmed.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
    }
    this.store.setRuntime(nodeId, patch);
  }

  dispose() {
    this.off();
    this.transport.close();
  }
}
