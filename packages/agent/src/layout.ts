/**
 * Placement of nodes the agent adds (docs/harness.md section 5): left to right
 * by dependency, never the model's guessed coordinates. `core/graph` has no
 * layout module yet; when one lands, this can delegate to it.
 */
import type { GraphState, LocalOp, XY } from '@rolling/core/graph';

export const LAYOUT = { originX: 96, originY: 96, colWidth: 340, rowHeight: 260, gap: 40 } as const;

interface Box {
  id: string;
  position: XY;
  /** Estimated rendered height (card plus its title line), so a tall node never hides the one placed below it. */
  height: number;
}

/** Characters per line of a script row's visual at the node's width (13px text in a ~170px column). */
const SCRIPT_CHARS_PER_LINE = 28;

/**
 * Rough rendered height of a node card on the canvas: a script grows with its
 * rows (each visual wraps), the others are fixed-size cards on the regular
 * grid (row height minus the gap).
 */
export function estimatedHeight(kind: string, params: Record<string, unknown> | undefined): number {
  if (kind === 'script') {
    const rows = Array.isArray(params?.rows) ? (params.rows as Array<{ visual?: unknown }>) : [];
    const body = rows.reduce((h, r) => h + Math.max(1, Math.ceil((typeof r.visual === 'string' ? r.visual.length : 0) / SCRIPT_CHARS_PER_LINE)) * 18 + 16, 0);
    // Title line, column header, rows, the action row under the table.
    return Math.max(LAYOUT.rowHeight - LAYOUT.gap, 24 + 36 + body + 52);
  }
  return LAYOUT.rowHeight - LAYOUT.gap;
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
  const placed: Box[] = state.nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => ({ id: n.id, position: n.position, height: estimatedHeight(n.kind, n.params as Record<string, unknown>) }));
  const byId = new Map(placed.map((b) => [b.id, b]));
  const preds = new Map<string, string[]>();
  for (const e of state.edges) preds.set(e.to.node, [...(preds.get(e.to.node) ?? []), e.from.node]);
  for (const o of ops) if (o.op === 'connect') preds.set(o.to.node, [...(preds.get(o.to.node) ?? []), o.from.node]);

  const minX = placed.length ? Math.min(...placed.map((b) => b.position.x)) : LAYOUT.originX;
  const newIds = new Set(added.map((a) => a.tempId));
  const positions = new Map<string, XY>();
  const visiting = new Set<string>();

  const addedById = new Map(added.map((a) => [a.tempId, a]));
  /** The y where the next node in column `x` starts: below the lowest node there, with its estimated height. */
  const columnNext = (x: number): number | null => {
    let next: number | null = null;
    for (const b of byId.values()) {
      if (Math.abs(b.position.x - x) < LAYOUT.colWidth / 2) next = Math.max(next ?? -Infinity, b.position.y + Math.max(LAYOUT.rowHeight, b.height + LAYOUT.gap));
    }
    return next;
  };
  const isText = (id: string) => {
    const k = addedById.get(id)?.kind;
    return k === 'script' || k === 'text';
  };

  const place = (id: string): XY | undefined => {
    const known = byId.get(id);
    if (known) return known.position;
    if (!newIds.has(id) || visiting.has(id)) return undefined;
    visiting.add(id);
    let x = minX;
    const inputs = preds.get(id) ?? [];
    for (const p of inputs) {
      const pos = place(p);
      if (pos) x = Math.max(x, pos.x + LAYOUT.colWidth);
    }
    // A generation node with no inputs (a text-to-video shot) sits right of the script it belongs to, not under it.
    if (!inputs.length && !isText(id) && added.some((a) => isText(a.tempId) && a.tempId !== id)) x = Math.max(x, minX + LAYOUT.colWidth);
    const next = columnNext(x);
    const pos = { x, y: next === null ? LAYOUT.originY : next };
    visiting.delete(id);
    positions.set(id, pos);
    const op = addedById.get(id);
    const box = { id, position: pos, height: estimatedHeight(op?.kind ?? '', op?.params as Record<string, unknown> | undefined) };
    byId.set(id, box);
    return pos;
  };

  for (const a of added) place(a.tempId);
  return ops.map((o) => (o.op === 'addNode' ? { ...o, position: positions.get(o.tempId) ?? { x: minX, y: LAYOUT.originY } } : o));
}
