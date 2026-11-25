/**
 * Placement of nodes the agent adds (docs/harness.md section 5): left to right
 * by dependency, never the model's guessed coordinates. `core/graph` has no
 * layout module yet; when one lands, this can delegate to it.
 */
import type { GraphState, LocalOp, XY } from '@rolling/core/graph';

export const LAYOUT = { originX: 96, originY: 96, colWidth: 340, rowHeight: 260 } as const;

interface Box {
  id: string;
  position: XY;
}

/**
 * Returns `ops` with every `addNode` given a position. Existing nodes keep
 * theirs. A new node goes one column right of its rightmost input, or in the
 * first column when it has none; within a column it goes below what is there.
 */
export function layoutNewNodes(state: Pick<GraphState, 'nodes' | 'edges'>, ops: readonly LocalOp[]): LocalOp[] {
  const added = ops.filter((o): o is Extract<LocalOp, { op: 'addNode' }> => o.op === 'addNode');
  if (!added.length) return [...ops];
  const removed = new Set(ops.filter((o) => o.op === 'removeNode').map((o) => (o as { nodeId: string }).nodeId));
  const placed: Box[] = state.nodes.filter((n) => !removed.has(n.id)).map((n) => ({ id: n.id, position: n.position }));
  const byId = new Map(placed.map((b) => [b.id, b]));
  const preds = new Map<string, string[]>();
  for (const e of state.edges) preds.set(e.to.node, [...(preds.get(e.to.node) ?? []), e.from.node]);
  for (const o of ops) if (o.op === 'connect') preds.set(o.to.node, [...(preds.get(o.to.node) ?? []), o.from.node]);

  const minX = placed.length ? Math.min(...placed.map((b) => b.position.x)) : LAYOUT.originX;
  const newIds = new Set(added.map((a) => a.tempId));
  const positions = new Map<string, XY>();
  const visiting = new Set<string>();

  const columnBottom = (x: number): number | null => {
    let bottom: number | null = null;
    for (const b of byId.values()) {
      if (Math.abs(b.position.x - x) < LAYOUT.colWidth / 2) bottom = Math.max(bottom ?? -Infinity, b.position.y);
    }
    return bottom;
  };

  const place = (id: string): XY | undefined => {
    const known = byId.get(id);
    if (known) return known.position;
    if (!newIds.has(id) || visiting.has(id)) return undefined;
    visiting.add(id);
    let x = minX;
    for (const p of preds.get(id) ?? []) {
      const pos = place(p);
      if (pos) x = Math.max(x, pos.x + LAYOUT.colWidth);
    }
    const bottom = columnBottom(x);
    const pos = { x, y: bottom === null ? LAYOUT.originY : bottom + LAYOUT.rowHeight };
    visiting.delete(id);
    positions.set(id, pos);
    const box = { id, position: pos };
    byId.set(id, box);
    return pos;
  };

  for (const a of added) place(a.tempId);
  return ops.map((o) => (o.op === 'addNode' ? { ...o, position: positions.get(o.tempId) ?? { x: minX, y: LAYOUT.originY } } : o));
}
