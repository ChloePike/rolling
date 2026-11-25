/**
 * Node and edge flag ops shared by the canvas store and ProjectRoom
 * (`setBypass`, `setCollapsed`, reroutes), bypass pass-through, and run
 * scopes ("Run up to here" / "Run from here"). Pure; callers apply them to a
 * cloned state inside their atomic patch.
 */
import { z } from 'zod';
import { outputType } from './ports';
import type { GraphEdge, GraphNode, GraphOp, GraphState, Refusal } from './types';

/** Most reroute points one edge may carry. */
export const MAX_REROUTES = 16;

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const XYSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const Index = z.number().int().min(0).max(MAX_REROUTES);

/** Zod schemas of the ops in this file, for the server's op union. */
export const FlagOpSchemas = [
  z.object({ op: z.literal('setBypass'), nodeId: Id, bypass: z.boolean() }),
  z.object({ op: z.literal('setCollapsed'), nodeId: Id, collapsed: z.boolean() }),
  z.object({ op: z.literal('addReroute'), edgeId: Id, index: Index, position: XYSchema }),
  z.object({ op: z.literal('removeReroute'), edgeId: Id, index: Index }),
  z.object({ op: z.literal('moveReroute'), edgeId: Id, index: Index, position: XYSchema }),
] as const;

export type FlagOp = Extract<GraphOp, { op: 'setBypass' | 'setCollapsed' | 'addReroute' | 'removeReroute' | 'moveReroute' }>;

export function isFlagOp(op: { op: string }): op is FlagOp {
  return op.op === 'setBypass' || op.op === 'setCollapsed' || op.op === 'addReroute' || op.op === 'removeReroute' || op.op === 'moveReroute';
}

/**
 * Applies one flag op to `state` in place (the caller passes its working
 * copy). Returns a refusal and leaves `state` unchanged when it does not apply.
 */
export function applyFlagOp(state: GraphState, op: FlagOp, resolve: (id: string) => string = (id) => id): Refusal | null {
  if (op.op === 'setBypass' || op.op === 'setCollapsed') {
    const id = resolve(op.nodeId);
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.', data: { nodeId: op.nodeId } };
    if (op.op === 'setBypass') {
      if (op.bypass) node.bypass = true;
      else delete node.bypass;
    } else if (op.collapsed) node.collapsed = true;
    else delete node.collapsed;
    return null;
  }
  const edge = state.edges.find((e) => e.id === op.edgeId);
  if (!edge) return { code: 'EDGE_NOT_FOUND', message: 'This connection no longer exists.' };
  const points = [...(edge.reroutes ?? [])];
  if (op.op === 'addReroute') {
    if (points.length >= MAX_REROUTES) return { code: 'TOO_MANY_REROUTES', message: `A connection can have at most ${MAX_REROUTES} reroute points.` };
    if (op.index > points.length) return { code: 'REROUTE_NOT_FOUND', message: 'That reroute point no longer exists.' };
    points.splice(op.index, 0, { x: op.position.x, y: op.position.y });
  } else {
    if (op.index >= points.length) return { code: 'REROUTE_NOT_FOUND', message: 'That reroute point no longer exists.' };
    if (op.op === 'removeReroute') points.splice(op.index, 1);
    else points[op.index] = { x: op.position.x, y: op.position.y };
  }
  if (points.length) edge.reroutes = points;
  else delete edge.reroutes;
  return null;
}

/** Where to put a new reroute point at `p` on an edge: the index between the closest pair of points. */
export function rerouteIndex(from: { x: number; y: number }, to: { x: number; y: number }, reroutes: readonly { x: number; y: number }[], p: { x: number; y: number }): number {
  const pts = [from, ...reroutes, to];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export type BypassResult = { ok: true; source: string } | { ok: false; reason: Refusal };

/**
 * What a bypassed node hands to its dependents: the first input of the same
 * type as its output (followed through further bypassed nodes), or a refusal
 * that blocks dependents.
 */
export function bypassSource(state: Pick<GraphState, 'nodes' | 'edges'>, nodeId: string, seen = new Set<string>()): BypassResult {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: { code: 'NODE_NOT_FOUND', message: 'This node no longer exists.' } };
  if (!node.bypass) return { ok: true, source: node.id };
  seen.add(node.id);
  const type = outputType(node);
  for (const e of state.edges) {
    if (e.to.node !== node.id || seen.has(e.from.node)) continue;
    const src = state.nodes.find((n) => n.id === e.from.node);
    if (!src || outputType(src) !== type) continue;
    const r = bypassSource(state, src.id, seen);
    if (r.ok) return r;
  }
  return {
    ok: false,
    reason: { code: 'PORT_TYPE_MISMATCH', message: `“${node.title}” is bypassed and has no ${type ?? 'matching'} input to pass through.`, data: { nodeId: node.id, type: type ?? 'none' } },
  };
}

/** The first bypassed upstream node that blocks `nodeId`, if any (direct inputs only; pass-through is followed). */
export function blockedByBypass(state: Pick<GraphState, 'nodes' | 'edges'>, nodeId: string): Refusal | null {
  for (const e of state.edges) {
    if (e.to.node !== nodeId) continue;
    const r = bypassSource(state, e.from.node);
    if (!r.ok) return r.reason;
  }
  return null;
}

function walk(edges: readonly GraphEdge[], start: string, dir: 'up' | 'down'): string[] {
  const out: string[] = [];
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      const next = dir === 'up' ? (e.to.node === id ? e.from.node : null) : e.from.node === id ? e.to.node : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        out.push(next);
        stack.push(next);
      }
    }
  }
  return out;
}

export type RunScope = 'all' | 'node' | 'upTo' | 'from';

/** Nodes that need a run: never generated, input changed, or failed. */
export function needsRun(node: GraphNode): boolean {
  return node.status === 'idle' || node.status === 'outdated' || node.status === 'failed';
}

/**
 * Node ids a run with `scope` covers for `nodeId`:
 * - `node`: just the node;
 * - `upTo`: the node plus every upstream node that still needs a run;
 * - `from`: the node plus everything downstream of it.
 */
export function runScopeNodes(state: Pick<GraphState, 'nodes' | 'edges'>, nodeId: string, scope: Exclude<RunScope, 'all'>): string[] {
  if (scope === 'node') return [nodeId];
  if (scope === 'from') return [nodeId, ...walk(state.edges, nodeId, 'down')];
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  return [...walk(state.edges, nodeId, 'up').filter((id) => {
    const n = byId.get(id);
    return !!n && needsRun(n);
  }), nodeId];
}
