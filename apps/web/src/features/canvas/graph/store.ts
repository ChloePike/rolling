import { newId } from '@rolling/core/ids';
import { inputPorts, OUT_PORT, resolveInputPort, validateConnection } from '@rolling/core/graph';
import type { GraphGroup, GraphNode, GraphOp, GraphState, LocalOp, NodeStatus, Refusal } from '@rolling/core/graph';

/** `LocalOp` (GraphOp plus `ungroup` for undo) lives in @rolling/core/graph. */
export type { LocalOp };

export type ApplyResult =
  | { ok: true; revision: number; idMap: Record<string, string>; state: GraphState }
  | { ok: false; refusal: Refusal };

export type RuntimePatch = Partial<Pick<GraphNode, 'status' | 'progress' | 'cost' | 'refunded' | 'version'>>;

export interface ApplyOptions {
  /** Record on the undo stack (user edits). Default true. */
  record?: boolean;
  actor?: 'user' | 'agent';
}

type Listener = () => void;

export interface IdFactory {
  node(): string;
  edge(): string;
  group(): string;
}

export const defaultIds: IdFactory = {
  node: () => newId('node'),
  edge: () => newId('edge'),
  group: () => newId('group'),
};

const UNDO_LIMIT = 100;

function clone(state: GraphState): GraphState {
  return {
    revision: state.revision,
    nodes: state.nodes.map((n) => ({ ...n, params: { ...n.params }, position: { ...n.position } })),
    edges: state.edges.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })),
    groups: state.groups.map((g) => ({ ...g, nodeIds: [...g.nodeIds] })),
  };
}

function refuse(opIndex: number, refusal: Refusal): ApplyResult {
  return { ok: false, refusal: { ...refusal, opIndex } };
}

/** Nodes with a version get "Input changed" when anything upstream of them changes. */
function markOutdated(state: GraphState, nodeId: string) {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes.find((n) => n.id === id);
    if (node && node.status === 'done') node.status = 'outdated';
    for (const e of state.edges) if (e.from.node === id) stack.push(e.to.node);
  }
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies `ops` to a copy of `state`. Atomic: the first invalid op refuses the
 * whole patch and nothing changes. Temp ids from `addNode` can be referenced by
 * later ops in the same patch.
 */
export function applyOps(state: GraphState, ops: LocalOp[], ids: IdFactory = defaultIds, actor: 'user' | 'agent' = 'user'): ApplyResult {
  const next = clone(state);
  const idMap: Record<string, string> = {};
  const resolve = (id: string) => idMap[id] ?? id;
  const findNode = (id: string) => next.nodes.find((n) => n.id === resolve(id));

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op.op) {
      case 'addNode': {
        const fixed = /^node_/.test(op.tempId) && !next.nodes.some((n) => n.id === op.tempId);
        if (/^node_/.test(op.tempId) && !fixed) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'A node with this id already exists.', data: { nodeId: op.tempId } });
        }
        const id = fixed ? op.tempId : ids.node();
        idMap[op.tempId] = id;
        next.nodes.push({
          id,
          kind: op.kind,
          title: op.title,
          params: { ...op.params },
          position: op.position ? { ...op.position } : { x: 0, y: 0 },
          groupId: null,
          status: 'idle',
          createdBy: actor,
        });
        break;
      }
      case 'updateNode': {
        const node = findNode(op.nodeId);
        if (!node) return refuse(i, { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId: op.nodeId } });
        const params = { ...node.params, ...op.params };
        const changed = !sameParams(params, node.params);
        node.params = params;
        if (op.title !== undefined) node.title = op.title;
        if (changed) markOutdated(next, node.id);
        break;
      }
      case 'moveNode': {
        const node = findNode(op.nodeId);
        if (!node) return refuse(i, { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId: op.nodeId } });
        node.position = { ...op.position };
        break;
      }
      case 'connect': {
        const from = { node: resolve(op.from.node), port: op.from.port };
        const to = { node: resolve(op.to.node), port: op.to.port };
        const refusal = validateConnection(next.nodes, next.edges, from, to);
        if (refusal) return refuse(i, refusal);
        if (op.edgeId && next.edges.some((e) => e.id === op.edgeId)) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'An edge with this id already exists.' });
        }
        next.edges.push({ id: op.edgeId ?? ids.edge(), from, to });
        markOutdated(next, to.node);
        break;
      }
      case 'disconnect': {
        const idx = next.edges.findIndex((e) => e.id === op.edgeId);
        if (idx < 0) return refuse(i, { code: 'EDGE_NOT_FOUND', message: 'This connection no longer exists.' });
        const [edge] = next.edges.splice(idx, 1);
        markOutdated(next, edge!.to.node);
        break;
      }
      case 'removeNode': {
        const node = findNode(op.nodeId);
        if (!node) return refuse(i, { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId: op.nodeId } });
        const downstream = next.edges.filter((e) => e.from.node === node.id).map((e) => e.to.node);
        next.nodes = next.nodes.filter((n) => n.id !== node.id);
        next.edges = next.edges.filter((e) => e.from.node !== node.id && e.to.node !== node.id);
        for (const g of next.groups) g.nodeIds = g.nodeIds.filter((id) => id !== node.id);
        next.groups = next.groups.filter((g) => g.nodeIds.length > 0);
        for (const d of downstream) markOutdated(next, d);
        break;
      }
      case 'group': {
        const members = op.nodeIds.map(resolve);
        if (!members.length) return refuse(i, { code: 'EMPTY_GROUP', message: 'Pick at least one node to group.' });
        const missing = members.find((id) => !next.nodes.some((n) => n.id === id));
        if (missing) return refuse(i, { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId: missing } });
        const group: GraphGroup = { id: op.groupId ?? ids.group(), title: op.title, nodeIds: members };
        for (const g of next.groups) g.nodeIds = g.nodeIds.filter((id) => !members.includes(id));
        next.groups = next.groups.filter((g) => g.nodeIds.length > 0);
        next.groups.push(group);
        for (const n of next.nodes) if (members.includes(n.id)) n.groupId = group.id;
        break;
      }
      case 'ungroup': {
        const group = next.groups.find((g) => g.id === op.groupId);
        if (!group) break;
        next.groups = next.groups.filter((g) => g.id !== op.groupId);
        for (const n of next.nodes) if (n.groupId === op.groupId) n.groupId = null;
        break;
      }
    }
  }
  next.revision = state.revision + 1;
  return { ok: true, revision: next.revision, idMap, state: next };
}

/**
 * Gives every new element a final id before the patch is applied or sent, so
 * the optimistic local state and the server end up with the same ids.
 */
export function normalizeOps(ops: LocalOp[], ids: IdFactory = defaultIds): LocalOp[] {
  const map: Record<string, string> = {};
  const r = (id: string) => map[id] ?? id;
  return ops.map((op) => {
    switch (op.op) {
      case 'addNode': {
        if (/^node_/.test(op.tempId)) return op;
        const id = ids.node();
        map[op.tempId] = id;
        return { ...op, tempId: id };
      }
      case 'updateNode':
        return { ...op, nodeId: r(op.nodeId) };
      case 'moveNode':
        return { ...op, nodeId: r(op.nodeId) };
      case 'removeNode':
        return { ...op, nodeId: r(op.nodeId) };
      case 'connect':
        return { ...op, from: { ...op.from, node: r(op.from.node) }, to: { ...op.to, node: r(op.to.node) }, edgeId: op.edgeId ?? ids.edge() };
      case 'group':
        return { ...op, nodeIds: op.nodeIds.map(r), groupId: op.groupId ?? ids.group() };
      default:
        return op;
    }
  });
}

/** Ops that turn `from` into `to` (used by undo/redo, which are forward patches). */
export function diffOps(from: GraphState, to: GraphState): LocalOp[] {
  const ops: LocalOp[] = [];
  const toEdges = new Map(to.edges.map((e) => [e.id, e]));
  const fromEdges = new Map(from.edges.map((e) => [e.id, e]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));

  for (const g of from.groups) if (!to.groups.some((t) => t.id === g.id)) ops.push({ op: 'ungroup', groupId: g.id });
  for (const e of from.edges) if (!toEdges.has(e.id)) ops.push({ op: 'disconnect', edgeId: e.id });
  for (const n of from.nodes) if (!toNodes.has(n.id)) ops.push({ op: 'removeNode', nodeId: n.id });
  for (const n of to.nodes) {
    const was = fromNodes.get(n.id);
    if (!was) {
      ops.push({ op: 'addNode', tempId: n.id, kind: n.kind, title: n.title, params: { ...n.params }, position: { ...n.position } });
      continue;
    }
    if (!sameParams(was.params, n.params) || was.title !== n.title) {
      ops.push({ op: 'updateNode', nodeId: n.id, params: { ...n.params }, ...(was.title !== n.title ? { title: n.title } : {}) });
    }
    if (was.position.x !== n.position.x || was.position.y !== n.position.y) {
      ops.push({ op: 'moveNode', nodeId: n.id, position: { ...n.position } });
    }
  }
  for (const e of to.edges) if (!fromEdges.has(e.id)) ops.push({ op: 'connect', from: { ...e.from }, to: { ...e.to }, edgeId: e.id });
  for (const g of to.groups) if (!from.groups.some((f) => f.id === g.id)) ops.push({ op: 'group', nodeIds: [...g.nodeIds], title: g.title, groupId: g.id });
  return ops;
}

interface HistoryEntry {
  before: GraphState;
  after: GraphState;
}

/**
 * Local graph store: applies GraphOps with revision numbers, validates port
 * types (refusals carry a reason), and keeps undo/redo. Runtime fields
 * (status, progress) come from job events and are not revisioned.
 */
export class GraphStore {
  private state: GraphState;
  private listeners = new Set<Listener>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Node ids added by the latest patches, for the build-in animation. */
  private fresh = new Map<string, number>();

  constructor(
    initial: GraphState,
    private readonly ids: IdFactory = defaultIds,
  ) {
    this.state = clone(initial);
  }

  getState = (): GraphState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Index in the most recent build batch (for the 150ms node stagger), or -1. */
  buildIndex(nodeId: string): number {
    return this.fresh.get(nodeId) ?? -1;
  }

  /** Dry run. */
  validate(ops: LocalOp[]): Refusal | null {
    const r = applyOps(this.state, ops, this.ids);
    return r.ok ? null : r.refusal;
  }

  apply(ops: LocalOp[], options: ApplyOptions = {}): ApplyResult {
    const { record = true, actor = 'user' } = options;
    const before = this.state;
    const result = applyOps(before, ops, this.ids, actor);
    if (!result.ok) return result;
    this.state = result.state;
    const added = Object.values(result.idMap);
    if (added.length) {
      this.fresh = new Map(added.map((id, i) => [id, i]));
    }
    if (record) {
      this.undoStack.push({ before, after: this.state });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit();
    return result;
  }

  /**
   * Resolves the right input port for a drag from `sourceId`'s output onto
   * `targetId`, or explains why it is refused.
   */
  planConnect(sourceId: string, targetId: string): { ok: true; op: GraphOp } | { ok: false; refusal: Refusal } {
    const source = this.state.nodes.find((n) => n.id === sourceId);
    const target = this.state.nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, refusal: { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.' } };
    if (source.id === target.id) return { ok: false, refusal: { code: 'SELF_CONNECTION', message: 'A node can’t feed itself.' } };
    if (!inputPorts(target).length) {
      return { ok: false, refusal: { code: 'PORT_TYPE_MISMATCH', message: 'This node has no inputs.', data: { kind: target.kind, type: 'none' } } };
    }
    const port = resolveInputPort(source, target);
    if ('refusal' in port) return { ok: false, refusal: port.refusal };
    const op: GraphOp = { op: 'connect', from: { node: source.id, port: OUT_PORT }, to: { node: target.id, port: port.port } };
    const refusal = validateConnection(this.state.nodes, this.state.edges, op.from, op.to);
    return refusal ? { ok: false, refusal } : { ok: true, op };
  }

  /** Moves to `target` with a forward patch; keeps runtime fields and group ids of `target`. */
  private restoreTo(target: GraphState): { ops: LocalOp[]; result: ApplyResult } {
    const ops = diffOps(this.state, target);
    const result = applyOps(this.state, ops, this.ids);
    if (!result.ok) return { ops, result };
    const byId = new Map(target.nodes.map((n) => [n.id, n]));
    result.state.nodes = result.state.nodes.map((n) => {
      const t = byId.get(n.id);
      return t
        ? { ...n, status: t.status, progress: t.progress, cost: t.cost, version: t.version, refunded: t.refunded, createdBy: t.createdBy, groupId: t.groupId }
        : n;
    });
    // Groups re-created by the patch get new ids; keep the original ones locally.
    result.state.groups = target.groups.map((g) => ({ ...g, nodeIds: [...g.nodeIds] }));
    this.state = result.state;
    this.fresh = new Map();
    this.emit();
    return { ops, result };
  }

  /** Reverts the last recorded patch as a new forward patch. Returns the ops to send. */
  undo(): { ops: LocalOp[]; result: ApplyResult } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const out = this.restoreTo(entry.before);
    (out.result.ok ? this.redoStack : this.undoStack).push(entry);
    return out;
  }

  redo(): { ops: LocalOp[]; result: ApplyResult } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const out = this.restoreTo(entry.after);
    (out.result.ok ? this.undoStack : this.redoStack).push(entry);
    return out;
  }

  /** Job events (`job.progress`, `job.done`, `job.failed`): not revisioned. */
  setRuntime(nodeId: string, patch: RuntimePatch) {
    let hit = false;
    const nodes = this.state.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      hit = true;
      return { ...n, ...patch };
    });
    if (!hit) return;
    this.state = { ...this.state, nodes };
    this.emit();
  }

  setStatus(nodeId: string, status: NodeStatus) {
    this.setRuntime(nodeId, { status });
  }

  /** Replaces everything (snapshot, conflict). Clears history: it no longer applies. */
  replace(state: GraphState) {
    this.state = clone(state);
    this.undoStack = [];
    this.redoStack = [];
    this.fresh = new Map();
    this.emit();
  }

  /** Replaces content but keeps undo history (remote patches, rebases). */
  rebase(state: GraphState) {
    this.state = state;
    this.emit();
  }

  /** Sets the confirmed revision after an ack without touching content. */
  setRevision(revision: number) {
    if (this.state.revision === revision) return;
    this.state = { ...this.state, revision };
    this.emit();
  }
}
