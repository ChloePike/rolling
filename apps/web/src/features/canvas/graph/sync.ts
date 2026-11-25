import { fromSnapshot, messageId, type ClientMessage, type ServerMessage } from '@rolling/core/graph';
import { applyOps, normalizeOps, type ApplyResult, type GraphStore, type LocalOp } from './store';
import type { Transport } from './transport';
import type { GraphState, Refusal } from '@rolling/core/graph';

export type SyncStatus = 'connecting' | 'saving' | 'saved';

export interface SyncEvents {
  /** The server refused a patch the client thought was valid, or a rebase dropped it. */
  onRefused?: (refusal: Refusal) => void;
  onJobDone?: (nodeId: string) => void;
  onJobFailed?: (nodeId: string, refunded: number) => void;
  onCredits?: (balance: number, held: number) => void;
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

  private setStatus(s: SyncStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.listeners) l();
  }

  /** Applies `ops` locally and sends them. Refusals return without sending. */
  commit(ops: LocalOp[], options: { record?: boolean; actor?: 'user' | 'agent' } = {}): ApplyResult {
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
    const out = this.store.undo();
    if (out?.result.ok && out.ops.length) this.send(out.ops);
    return out?.result ?? null;
  }

  redo(): ApplyResult | null {
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
      case 'snapshot': {
        this.confirmed = fromSnapshot(msg.payload);
        this.pending = [];
        this.store.replace(this.confirmed);
        this.setStatus('saved');
        return;
      }
      case 'ack': {
        const idx = this.pending.findIndex((p) => p.id === msg.id);
        if (idx < 0 || !this.confirmed) return;
        const [done] = this.pending.splice(idx, 1);
        const r = applyOps(this.confirmed, done!.ops);
        if (r.ok) this.confirmed = { ...r.state, revision: msg.payload.revision };
        this.store.setRevision(this.confirmed.revision + this.pending.length);
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'conflict': {
        this.confirmed = fromSnapshot(msg.payload.snapshot);
        this.resend();
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'error': {
        const idx = this.pending.findIndex((p) => p.id === msg.id);
        if (idx < 0) return;
        this.pending.splice(idx, 1);
        const data = msg.payload.data as Refusal | undefined;
        this.events.onRefused?.(data && typeof data === 'object' && 'code' in data ? data : { code: 'NODE_NOT_FOUND', message: msg.payload.message });
        if (this.confirmed) this.rebuild();
        if (!this.pending.length) this.setStatus('saved');
        return;
      }
      case 'graph.patched': {
        if (!this.confirmed) return;
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
        return;
      }
      case 'job.queued': {
        this.runtime(msg.payload.nodeId, { status: 'queued', progress: 0 });
        return;
      }
      case 'node.version': {
        this.runtime(msg.payload.nodeId, { version: msg.payload.version });
        return;
      }
      case 'job.progress': {
        this.runtime(msg.payload.nodeId, { status: 'generating', progress: msg.payload.progress });
        return;
      }
      case 'job.done': {
        this.runtime(msg.payload.nodeId, { status: 'done', progress: 1, version: msg.payload.version });
        this.events.onJobDone?.(msg.payload.nodeId);
        return;
      }
      case 'job.failed': {
        this.runtime(msg.payload.nodeId, { status: 'failed', refunded: msg.payload.refunded });
        this.events.onJobFailed?.(msg.payload.nodeId, msg.payload.refunded);
        return;
      }
      case 'credits.changed': {
        this.events.onCredits?.(msg.payload.balance, msg.payload.held);
        return;
      }
      default:
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
