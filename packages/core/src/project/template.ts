/**
 * Template graphs (D1 `templates.graph`) to the ops that build them in a new
 * project. Accepts `{ ops: LocalOp[] }` or a graph `{ nodes, edges, groups }`
 * (GraphState shape). Every id is replaced so each project gets fresh ids.
 */
import type { GraphState } from '../graph/types';
import { diffGraph, type RoomOp } from './ops';

export function templateOps(graph: unknown): RoomOp[] {
  if (!graph || typeof graph !== 'object') return [];
  const g = graph as { ops?: unknown; nodes?: unknown; edges?: unknown; groups?: unknown };
  let ops: RoomOp[];
  if (Array.isArray(g.ops)) ops = g.ops as RoomOp[];
  else if (Array.isArray(g.nodes)) {
    const state: GraphState = {
      revision: 0,
      nodes: g.nodes as GraphState['nodes'],
      edges: Array.isArray(g.edges) ? (g.edges as GraphState['edges']) : [],
      groups: Array.isArray(g.groups) ? (g.groups as GraphState['groups']) : [],
    };
    ops = diffGraph({ revision: 0, nodes: [], edges: [], groups: [] }, state);
  } else return [];

  // Node ids become temp ids (fresh ids on apply); edge and group ids are dropped.
  const temp = new Map<string, string>();
  const t = (id: string) => {
    let v = temp.get(id);
    if (!v) {
      v = `t${temp.size + 1}`;
      temp.set(id, v);
    }
    return v;
  };
  return ops.map((op): RoomOp => {
    switch (op.op) {
      case 'addNode':
        return { ...op, tempId: t(op.tempId) };
      case 'updateNode':
      case 'moveNode':
      case 'removeNode':
      case 'setBypass':
      case 'setCollapsed':
        return { ...op, nodeId: t(op.nodeId) };
      case 'connect': {
        const { edgeId: _e, ...rest } = op;
        return { ...rest, from: { ...op.from, node: t(op.from.node) }, to: { ...op.to, node: t(op.to.node) } };
      }
      case 'group': {
        const { groupId: _g, ...rest } = op;
        return { ...rest, nodeIds: op.nodeIds.map(t) };
      }
      default:
        return op;
    }
  });
}
