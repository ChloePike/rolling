/**
 * Server-side GraphOp application for ProjectRoom. Same rules as the canvas
 * (`apps/web/.../graph/store.ts`): ports, types and cycles come from
 * `@rolling/core/graph` (`validateConnection`), the patch is atomic and temp
 * ids from `addNode` can be referenced by later ops of the same patch.
 *
 * Differences that only make the server stricter or deterministic:
 * - every op is schema-checked (Zod) first;
 * - client-chosen ids must carry their prefix (`node_`, `edge_`, `grp_`) and be unique;
 * - the returned `ops` are normalized (final ids everywhere) so every client
 *   applies exactly the same patch;
 * - `updateNode` params set to `null` remove the key (needed for exact undo).
 */
import { z } from 'zod';
import { validateConnection } from '../graph/ports';
import type { GraphGroup, GraphNode, GraphState, LocalOp, NodeKind, Refusal, RefusalCode } from '../graph/types';
import { newId } from '../ids';

/**
 * Node flags that are not params (ComfyUI-style): `bypass` passes the node's
 * input through (or blocks dependents when types differ); `collapsed` is view
 * only. Stored as ProjectRoom node columns; never part of input digests
 * except that a bypassed upstream changes its dependents' inputs.
 */
export interface NodeFlags {
  bypass?: boolean;
  collapsed?: boolean;
}

/** Ops ProjectRoom applies: the canvas `LocalOp` plus the node-flag extensions. */
export type RoomOp = LocalOp | { op: 'setBypass'; nodeId: string; bypass: boolean } | { op: 'setCollapsed'; nodeId: string; collapsed: boolean };

export function nodeFlags(node: GraphNode): NodeFlags {
  return node as GraphNode & NodeFlags;
}

export type ServerRefusalCode = RefusalCode | 'INVALID_OP' | 'TOO_LARGE';

export interface ServerRefusal extends Omit<Refusal, 'code'> {
  code: ServerRefusalCode;
}

const NODE_KINDS = ['text', 'script', 'image', 'video', 'audio', 'asset', 'render'] as const satisfies readonly NodeKind[];

/** Max serialized size of one node's params. */
export const MAX_PARAMS_BYTES = 32 * 1024;
/** Max nodes in one project graph. */
export const MAX_NODES = 2000;

const Ref = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const NodeId = Ref;
const EdgeId = z.string().regex(/^edge_[A-Za-z0-9]{1,40}$/, 'edge ids start with edge_');
const GroupId = z.string().regex(/^grp_[A-Za-z0-9]{1,40}$/, 'group ids start with grp_');
const XY = z.object({ x: z.number().finite(), y: z.number().finite() });
const PortRef = z.object({ node: NodeId, port: z.string().min(1).max(32) });
const Params = z.record(z.unknown());
const Title = z.string().max(200);

export const LocalOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addNode'), tempId: Ref, kind: z.enum(NODE_KINDS), title: Title, params: Params, position: XY.optional() }),
  z.object({ op: z.literal('updateNode'), nodeId: NodeId, params: Params, title: Title.optional() }),
  z.object({ op: z.literal('connect'), from: PortRef, to: PortRef, edgeId: EdgeId.optional() }),
  z.object({ op: z.literal('disconnect'), edgeId: Ref }),
  z.object({ op: z.literal('removeNode'), nodeId: NodeId }),
  z.object({ op: z.literal('group'), nodeIds: z.array(NodeId).max(500), title: Title, groupId: GroupId.optional() }),
  z.object({ op: z.literal('moveNode'), nodeId: NodeId, position: XY }),
  z.object({ op: z.literal('ungroup'), groupId: Ref }),
  z.object({ op: z.literal('setBypass'), nodeId: NodeId, bypass: z.boolean() }),
  z.object({ op: z.literal('setCollapsed'), nodeId: NodeId, collapsed: z.boolean() }),
]);

export interface GraphIds {
  node(): string;
  edge(): string;
  group(): string;
}

export const serverIds: GraphIds = {
  node: () => newId('node'),
  edge: () => newId('edge'),
  group: () => newId('group'),
};

export type GraphApplyResult =
  | { ok: true; state: GraphState; ops: RoomOp[]; idMap: Record<string, string> }
  | { ok: false; refusal: ServerRefusal };

/** Schema check of raw ops (from a socket or REST body). */
export function parseOps(raw: readonly unknown[]): { ok: true; ops: RoomOp[] } | { ok: false; refusal: ServerRefusal } {
  const ops: RoomOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = LocalOpSchema.safeParse(raw[i]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        refusal: {
          code: 'INVALID_OP',
          message: `Op ${i} is invalid: ${issue ? `${issue.path.join('.') || 'op'} ${issue.message}` : 'unknown shape'}`,
          opIndex: i,
        },
      };
    }
    ops.push(parsed.data as RoomOp);
  }
  return { ok: true, ops };
}

function clone(state: GraphState): GraphState {
  return {
    revision: state.revision,
    nodes: state.nodes.map((n) => ({ ...n, params: { ...n.params }, position: { ...n.position } })),
    edges: state.edges.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })),
    groups: state.groups.map((g) => ({ ...g, nodeIds: [...g.nodeIds] })),
  };
}

function mergeParams(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const refuse = (opIndex: number, refusal: Omit<ServerRefusal, 'opIndex'>): GraphApplyResult => ({
  ok: false,
  refusal: { ...refusal, opIndex },
});

/**
 * Applies `ops` to a copy of `state`. Atomic: the first invalid op refuses the
 * whole patch. Node statuses are left alone (ProjectRoom recomputes staleness
 * from input digests after applying).
 */
export function applyGraphOps(
  state: GraphState,
  ops: readonly RoomOp[],
  options: { actor?: 'user' | 'agent'; ids?: GraphIds } = {},
): GraphApplyResult {
  const ids = options.ids ?? serverIds;
  const actor = options.actor ?? 'user';
  const next = clone(state);
  const idMap: Record<string, string> = {};
  const out: RoomOp[] = [];
  /** Nodes added without a position in this patch: placed by `layoutNewNodes` at the end. */
  const unplaced = new Set<string>();
  const resolve = (id: string) => idMap[id] ?? id;
  const findNode = (id: string) => next.nodes.find((n) => n.id === resolve(id));
  const notFound = (i: number, nodeId: string) =>
    refuse(i, { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId } });

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op.op) {
      case 'addNode': {
        const fixed = op.tempId.startsWith('node_');
        if (fixed && next.nodes.some((n) => n.id === op.tempId)) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'A node with this id already exists.', data: { nodeId: op.tempId } });
        }
        if (!fixed && idMap[op.tempId]) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'This temp id is used twice in the patch.', data: { nodeId: op.tempId } });
        }
        if (JSON.stringify(op.params).length > MAX_PARAMS_BYTES) {
          return refuse(i, { code: 'TOO_LARGE', message: 'Node parameters are too large.' });
        }
        if (next.nodes.length >= MAX_NODES) return refuse(i, { code: 'TOO_LARGE', message: 'This project has too many nodes.' });
        const id = fixed ? op.tempId : ids.node();
        if (!fixed) idMap[op.tempId] = id;
        const position = op.position ? { ...op.position } : { x: 0, y: 0 };
        if (!op.position) unplaced.add(id);
        next.nodes.push({ id, kind: op.kind, title: op.title, params: { ...op.params }, position, groupId: null, status: 'idle', createdBy: actor });
        out.push({ op: 'addNode', tempId: id, kind: op.kind, title: op.title, params: { ...op.params }, position });
        break;
      }
      case 'updateNode': {
        const node = findNode(op.nodeId);
        if (!node) return notFound(i, op.nodeId);
        const params = mergeParams(node.params, op.params);
        if (JSON.stringify(params).length > MAX_PARAMS_BYTES) {
          return refuse(i, { code: 'TOO_LARGE', message: 'Node parameters are too large.' });
        }
        node.params = params;
        if (op.title !== undefined) node.title = op.title;
        out.push({ op: 'updateNode', nodeId: node.id, params: { ...op.params }, ...(op.title !== undefined ? { title: op.title } : {}) });
        break;
      }
      case 'moveNode': {
        const node = findNode(op.nodeId);
        if (!node) return notFound(i, op.nodeId);
        node.position = { ...op.position };
        unplaced.delete(node.id);
        out.push({ op: 'moveNode', nodeId: node.id, position: { ...op.position } });
        break;
      }
      case 'connect': {
        const from = { node: resolve(op.from.node), port: op.from.port };
        const to = { node: resolve(op.to.node), port: op.to.port };
        const refusal = validateConnection(next.nodes, next.edges, from, to);
        if (refusal) return refuse(i, refusal);
        if (op.edgeId && next.edges.some((e) => e.id === op.edgeId)) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'An edge with this id already exists.', data: { edgeId: op.edgeId } });
        }
        const edgeId = op.edgeId ?? ids.edge();
        next.edges.push({ id: edgeId, from, to });
        out.push({ op: 'connect', from, to, edgeId });
        break;
      }
      case 'disconnect': {
        const idx = next.edges.findIndex((e) => e.id === op.edgeId);
        if (idx < 0) return refuse(i, { code: 'EDGE_NOT_FOUND', message: 'This connection no longer exists.', data: { edgeId: op.edgeId } });
        next.edges.splice(idx, 1);
        out.push({ op: 'disconnect', edgeId: op.edgeId });
        break;
      }
      case 'removeNode': {
        const node = findNode(op.nodeId);
        if (!node) return notFound(i, op.nodeId);
        next.nodes = next.nodes.filter((n) => n.id !== node.id);
        unplaced.delete(node.id);
        next.edges = next.edges.filter((e) => e.from.node !== node.id && e.to.node !== node.id);
        for (const g of next.groups) g.nodeIds = g.nodeIds.filter((id) => id !== node.id);
        next.groups = next.groups.filter((g) => g.nodeIds.length > 0);
        out.push({ op: 'removeNode', nodeId: node.id });
        break;
      }
      case 'group': {
        const members = [...new Set(op.nodeIds.map(resolve))];
        if (!members.length) return refuse(i, { code: 'EMPTY_GROUP', message: 'Pick at least one node to group.' });
        const missing = members.find((id) => !next.nodes.some((n) => n.id === id));
        if (missing) return notFound(i, missing);
        if (op.groupId && next.groups.some((g) => g.id === op.groupId)) {
          return refuse(i, { code: 'DUPLICATE_ID', message: 'A group with this id already exists.', data: { groupId: op.groupId } });
        }
        const group: GraphGroup = { id: op.groupId ?? ids.group(), title: op.title, nodeIds: members };
        for (const g of next.groups) g.nodeIds = g.nodeIds.filter((id) => !members.includes(id));
        next.groups = next.groups.filter((g) => g.nodeIds.length > 0);
        next.groups.push(group);
        for (const n of next.nodes) if (members.includes(n.id)) n.groupId = group.id;
        out.push({ op: 'group', nodeIds: members, title: op.title, groupId: group.id });
        break;
      }
      case 'setBypass':
      case 'setCollapsed': {
        const node = findNode(op.nodeId);
        if (!node) return notFound(i, op.nodeId);
        const flags = node as GraphNode & NodeFlags;
        if (op.op === 'setBypass') flags.bypass = op.bypass;
        else flags.collapsed = op.collapsed;
        out.push(op.op === 'setBypass' ? { op: 'setBypass', nodeId: node.id, bypass: op.bypass } : { op: 'setCollapsed', nodeId: node.id, collapsed: op.collapsed });
        break;
      }
      case 'ungroup': {
        // Unknown groups are ignored, as on the canvas (the group may already be gone).
        if (!next.groups.some((g) => g.id === op.groupId)) break;
        next.groups = next.groups.filter((g) => g.id !== op.groupId);
        for (const n of next.nodes) if (n.groupId === op.groupId) n.groupId = null;
        out.push({ op: 'ungroup', groupId: op.groupId });
        break;
      }
    }
  }
  if (unplaced.size) {
    const positions = layoutNewNodes(next, unplaced);
    for (const n of next.nodes) {
      const p = positions.get(n.id);
      if (p) n.position = p;
    }
    for (const op of out) if (op.op === 'addNode' && positions.has(op.tempId)) op.position = { ...positions.get(op.tempId)! };
  }
  next.revision = state.revision + 1;
  return { ok: true, state: next, ops: out, idMap };
}

/** Column and row pitch of the automatic layout (canvas units). */
export const LAYOUT = { x: 352, y: 264, origin: { x: 96, y: 96 } } as const;

/**
 * Places nodes added without a position left to right by dependency
 * (docs/harness.md: new nodes are placed by layout, never by guessed
 * coordinates): column = longest path from a source among the new nodes,
 * stacked top to bottom in add order. The block goes to the right of the
 * existing graph, top-aligned with it.
 */
export function layoutNewNodes(state: GraphState, newIds: ReadonlySet<string>): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const incoming = (id: string) => state.edges.filter((e) => e.to.node === id && newIds.has(e.from.node)).map((e) => e.from.node);
  const visit = (id: string, seen: Set<string>): number => {
    const hit = depth.get(id);
    if (hit !== undefined) return hit;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...incoming(id).map((p) => visit(p, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const fresh = state.nodes.filter((n) => newIds.has(n.id));
  for (const n of fresh) visit(n.id, new Set());
  const existing = state.nodes.filter((n) => !newIds.has(n.id));
  const originX = existing.length ? Math.max(...existing.map((n) => n.position.x)) + LAYOUT.x : LAYOUT.origin.x;
  const originY = existing.length ? Math.min(...existing.map((n) => n.position.y)) : LAYOUT.origin.y;
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const n of fresh) {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(n.id, { x: originX + col * LAYOUT.x, y: originY + row * LAYOUT.y });
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Forward ops that turn `from` into `to`. Used for undo/redo (the inverse of a
 * patch is `diffGraph(after, before)`) and to instantiate templates. Params
 * removed between the two states are sent as `null`.
 */
export function diffGraph(from: GraphState, to: GraphState): RoomOp[] {
  const ops: RoomOp[] = [];
  const toEdges = new Map(to.edges.map((e) => [e.id, e]));
  const fromEdges = new Map(from.edges.map((e) => [e.id, e]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toGroups = new Map(to.groups.map((g) => [g.id, g]));
  const fromGroups = new Map(from.groups.map((g) => [g.id, g]));
  const sameGroup = (a: GraphGroup, b: GraphGroup) => a.title === b.title && sameJson([...a.nodeIds].sort(), [...b.nodeIds].sort());

  for (const g of from.groups) {
    const t = toGroups.get(g.id);
    if (!t || !sameGroup(g, t)) ops.push({ op: 'ungroup', groupId: g.id });
  }
  for (const e of from.edges) {
    const t = toEdges.get(e.id);
    if (!t || !sameJson(t, e)) ops.push({ op: 'disconnect', edgeId: e.id });
  }
  for (const n of from.nodes) if (!toNodes.has(n.id)) ops.push({ op: 'removeNode', nodeId: n.id });
  for (const n of to.nodes) {
    const was = fromNodes.get(n.id);
    if (!was || was.kind !== n.kind) {
      if (was) ops.push({ op: 'removeNode', nodeId: n.id });
      ops.push({ op: 'addNode', tempId: n.id, kind: n.kind, title: n.title, params: { ...n.params }, position: { ...n.position } });
      continue;
    }
    if (!sameJson(was.params, n.params) || was.title !== n.title) {
      const params: Record<string, unknown> = { ...n.params };
      for (const k of Object.keys(was.params)) if (!(k in n.params)) params[k] = null;
      ops.push({ op: 'updateNode', nodeId: n.id, params, ...(was.title !== n.title ? { title: n.title } : {}) });
    }
    if (was.position.x !== n.position.x || was.position.y !== n.position.y) {
      ops.push({ op: 'moveNode', nodeId: n.id, position: { ...n.position } });
    }
  }
  // Flags last: re-added nodes start without them.
  for (const n of to.nodes) {
    const was = fromNodes.get(n.id);
    const f = nodeFlags(n);
    const w = was && was.kind === n.kind ? nodeFlags(was) : {};
    if (!!f.bypass !== !!w.bypass) ops.push({ op: 'setBypass', nodeId: n.id, bypass: !!f.bypass });
    if (!!f.collapsed !== !!w.collapsed) ops.push({ op: 'setCollapsed', nodeId: n.id, collapsed: !!f.collapsed });
  }
  for (const e of to.edges) {
    const was = fromEdges.get(e.id);
    if (!was || !sameJson(was, e)) ops.push({ op: 'connect', from: { ...e.from }, to: { ...e.to }, edgeId: e.id });
  }
  for (const g of to.groups) {
    const was = fromGroups.get(g.id);
    if (!was || !sameGroup(was, g)) ops.push({ op: 'group', nodeIds: [...g.nodeIds], title: g.title, groupId: g.id });
  }
  return ops;
}

/** Same graph content (ignores revision, statuses and runtime fields). */
export function sameGraph(a: GraphState, b: GraphState): boolean {
  return diffGraph(a, b).length === 0;
}
