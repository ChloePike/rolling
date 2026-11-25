import { newId } from '@rolling/core/ids';
import { messageId, toSnapshot, type ClientMessage, type ServerMessage } from '@rolling/core/graph';
import { applyOps } from './store';
import type { Transport } from './transport';
import type { GraphState } from '@rolling/core/graph';

export interface MockRoomOptions {
  projectId: string;
  initial: GraphState;
  /** Simulated network latency, ms. */
  latency?: number;
  /** Interval between `job.progress` events, ms. */
  tick?: number;
  /** Progress added per tick (0..1). */
  step?: number;
  /** When true, jobs never advance on their own (screenshots, tests). */
  frozen?: boolean;
  /** Workspace credits the room's CreditAccount stand-in starts with. */
  credits?: { balance: number; held: number };
  /** Every new job fails at 40% (`?mock=fail`), to see the refund path. */
  failAll?: boolean;
}

interface Job {
  id: string;
  nodeId: string;
  progress: number;
  fail: boolean;
  /** Upstream nodes of the same run that must finish first (GenerateWorkflow waits on them). */
  waitFor: string[];
}

/**
 * In-browser stand-in for the ProjectRoom Durable Object. Speaks the same
 * envelope protocol: snapshot on connect, `patch` → `ack` | `conflict` (stale
 * base revision) | `error` (refused op), `graph.patched` to the other sockets,
 * and `job.progress` / `job.done` / `job.failed` for runs.
 */
export class MockProjectRoom {
  state: GraphState;
  private sockets = new Set<(raw: string) => void>();
  private jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Credits held per running node (CreditAccount hold → settle | release). */
  private holds = new Map<string, number>();
  credits: { balance: number; held: number };
  readonly opts: Required<MockRoomOptions>;

  constructor(options: MockRoomOptions) {
    this.opts = { latency: 40, tick: 400, step: 0.06, frozen: false, credits: { balance: 0, held: 0 }, failAll: false, ...options };
    this.credits = { ...this.opts.credits };
    this.state = options.initial;
    for (const n of this.state.nodes) {
      if (n.status === 'generating') this.jobs.set(n.id, { id: newId('job'), nodeId: n.id, progress: n.progress ?? 0, fail: false, waitFor: [] });
    }
    this.ensureTicking();
  }

  /** Opens a socket for one client. */
  connect(): Transport {
    const listeners = new Set<(raw: string) => void>();
    const deliver = (raw: string) => {
      setTimeout(() => {
        for (const l of listeners) l(raw);
      }, this.opts.latency);
    };
    this.sockets.add(deliver);
    deliver(this.envelope('snapshot', toSnapshot(this.opts.projectId, this.state)));
    return {
      send: (raw) => setTimeout(() => this.receive(raw, deliver), this.opts.latency),
      onMessage: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      close: () => {
        this.sockets.delete(deliver);
        listeners.clear();
      },
    };
  }

  private envelope<T extends ServerMessage['type']>(type: T, payload: Extract<ServerMessage, { type: T }>['payload'], id = messageId()): string {
    return JSON.stringify({ type, id, payload });
  }

  private broadcast(raw: string, except?: (raw: string) => void) {
    for (const s of this.sockets) if (s !== except) s(raw);
  }

  private receive(raw: string, reply: (raw: string) => void) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      reply(this.envelope('error', { code: 'BAD_MESSAGE', message: 'Message must be JSON' }, 'unknown'));
      return;
    }
    if (msg.type === 'ping') {
      reply(this.envelope('pong', null, msg.id));
      return;
    }
    if (msg.type !== 'patch') {
      reply(this.envelope('error', { code: 'UNKNOWN_TYPE', message: 'Unknown message type' }, (msg as { id: string }).id));
      return;
    }
    const { baseRevision, ops } = msg.payload;
    if (baseRevision !== this.state.revision) {
      reply(this.envelope('conflict', { snapshot: toSnapshot(this.opts.projectId, this.state) }, msg.id));
      return;
    }
    const result = applyOps(this.state, ops);
    if (!result.ok) {
      reply(this.envelope('error', { code: 'PATCH_REFUSED', message: result.refusal.message, data: result.refusal }, msg.id));
      return;
    }
    this.state = result.state;
    reply(this.envelope('ack', { revision: result.revision }, msg.id));
    this.broadcast(this.envelope('graph.patched', { revision: result.revision, ops, actor: 'usr_other' }), reply);
  }

  /** Applies a patch as another collaborator (or the agent) would. */
  remotePatch(ops: Parameters<typeof applyOps>[1], actor = 'usr_other') {
    const result = applyOps(this.state, ops, undefined, actor === 'agent' ? 'agent' : 'user');
    if (!result.ok) return result;
    this.state = result.state;
    this.broadcast(this.envelope('graph.patched', { revision: result.revision, ops, actor }));
    return result;
  }

  /**
   * Starts a generation job for each node (after the run was approved). Holds
   * `costs[nodeId]` credits per job; refuses the whole run when the balance
   * does not cover it (the API answers `INSUFFICIENT_CREDITS`).
   */
  startJobs(nodeIds: string[], options: { fail?: string[]; costs?: Record<string, number> } = {}): { ok: true } | { ok: false; code: 'INSUFFICIENT_CREDITS'; needed: number } {
    const total = nodeIds.reduce((s, id) => s + (options.costs?.[id] ?? 0), 0);
    if (total > this.credits.balance) return { ok: false, code: 'INSUFFICIENT_CREDITS', needed: total - this.credits.balance };
    for (const nodeId of nodeIds) {
      const cost = options.costs?.[nodeId] ?? 0;
      if (cost) {
        this.holds.set(nodeId, cost);
        this.credits = { balance: this.credits.balance - cost, held: this.credits.held + cost };
      }
      // Everything upstream of this node that is part of the run (keyframes before the videos they feed).
      const waitFor = this.upstream(nodeId).filter((id) => nodeIds.includes(id) || this.jobs.has(id));
      const job: Job = { id: newId('job'), nodeId, progress: 0, fail: this.opts.failAll || (options.fail?.includes(nodeId) ?? false), waitFor };
      this.jobs.set(nodeId, job);
      if (waitFor.length) {
        this.patchNode(nodeId, { status: 'queued', progress: 0 });
        this.broadcast(this.envelope('job.queued', { jobId: job.id, nodeId }));
      } else {
        this.patchNode(nodeId, { status: 'generating', progress: 0 });
        this.broadcast(this.envelope('job.progress', { jobId: job.id, nodeId, progress: 0 }));
      }
    }
    if (total) this.broadcastCredits();
    this.ensureTicking();
    return { ok: true };
  }

  /** A completed top-up (Stripe webhook → CreditAccount grant). */
  grant(amount: number) {
    this.credits = { ...this.credits, balance: this.credits.balance + amount };
    this.broadcastCredits();
  }

  /** Switches the node's active version (`POST /api/nodes/:id/versions/:n/activate`). */
  setVersion(nodeId: string, n: number) {
    const node = this.state.nodes.find((x) => x.id === nodeId);
    if (!node?.version || n < 1 || n > node.version.total) return false;
    const version = { n, total: node.version.total };
    this.patchNode(nodeId, { version });
    this.broadcast(this.envelope('node.version', { nodeId, version }));
    return true;
  }

  private broadcastCredits() {
    this.broadcast(this.envelope('credits.changed', { ...this.credits }));
  }

  /** Settles (done) or releases (failed) the node's hold. */
  private closeHold(nodeId: string, settle: boolean): number {
    const held = this.holds.get(nodeId);
    if (held === undefined) return 0;
    this.holds.delete(nodeId);
    this.credits = { balance: this.credits.balance + (settle ? 0 : held), held: this.credits.held - held };
    this.broadcastCredits();
    return held;
  }

  private patchNode(nodeId: string, patch: Partial<GraphState['nodes'][number]>) {
    this.state = { ...this.state, nodes: this.state.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
  }

  private ensureTicking() {
    if (this.opts.frozen || this.timer || !this.jobs.size) return;
    this.timer = setInterval(() => this.advance(), this.opts.tick);
  }

  private upstream(nodeId: string): string[] {
    const out = new Set<string>();
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of this.state.edges) if (e.to.node === id && !out.has(e.from.node)) {
        out.add(e.from.node);
        stack.push(e.from.node);
      }
    }
    return [...out];
  }

  /** Moves every running job one step (also callable from tests). */
  advance(step = this.opts.step) {
    for (const job of [...this.jobs.values()]) {
      // Ended during this step (a failed upstream fails its dependents).
      if (this.jobs.get(job.nodeId) !== job) continue;
      if (job.waitFor.some((id) => this.jobs.has(id))) continue;
      if (job.waitFor.length) {
        job.waitFor = [];
        this.patchNode(job.nodeId, { status: 'generating', progress: 0 });
        this.broadcast(this.envelope('job.progress', { jobId: job.id, nodeId: job.nodeId, progress: 0 }));
        continue;
      }
      job.progress = Math.min(1, job.progress + step);
      if (job.fail && job.progress >= 0.4) {
        this.failJob(job.nodeId);
        continue;
      }
      if (job.progress >= 1) {
        this.finishJob(job.nodeId);
        continue;
      }
      this.patchNode(job.nodeId, { progress: job.progress });
      this.broadcast(this.envelope('job.progress', { jobId: job.id, nodeId: job.nodeId, progress: job.progress }));
    }
    if (!this.jobs.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  finishJob(nodeId: string) {
    const job = this.jobs.get(nodeId);
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!job || !node) return;
    this.jobs.delete(nodeId);
    const total = (node.version?.total ?? 0) + 1;
    const version = { n: total, total };
    this.patchNode(nodeId, { status: 'done', progress: 1, version });
    this.closeHold(nodeId, true);
    this.broadcast(this.envelope('job.done', { jobId: job.id, nodeId, version }));
  }

  /** Fails the job and refunds its hold, like CreditAccount.release. */
  failJob(nodeId: string, reason = 'Provider error') {
    const job = this.jobs.get(nodeId);
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!job || !node) return;
    this.jobs.delete(nodeId);
    const held = this.holds.has(nodeId) ? this.closeHold(nodeId, false) : undefined;
    const refunded = held ?? node.cost ?? (typeof node.params.runCost === 'number' ? node.params.runCost : 0);
    this.patchNode(nodeId, { status: 'failed', refunded });
    this.broadcast(this.envelope('job.failed', { jobId: job.id, nodeId, refunded, reason }));
    // Queued jobs that needed this result cannot run: release their holds too.
    for (const other of [...this.jobs.values()]) if (other.waitFor.includes(nodeId)) this.failJob(other.nodeId, 'Upstream failed');
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sockets.clear();
  }
}
