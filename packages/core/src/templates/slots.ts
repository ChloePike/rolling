/**
 * Templates (docs/api.md → Templates): a template is a canvas graph
 * (`{ nodes, edges, groups }`, applied through `core/project` `templateOps`)
 * plus slots the user fills when making a project from it. Slots are inferred
 * from the graph: every asset node (a picture, clip or voice track to supply)
 * and every text/script node (words to write) is one slot, keyed by node id.
 */
import { z } from 'zod';
import type { GraphEdge, GraphGroup, GraphNode, GraphState, NodeKind } from '../graph/types';
import { outputType } from '../graph/ports';

export interface TemplateGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}

export type SlotKind = 'image' | 'video' | 'audio' | 'text';

export interface TemplateSlot {
  /** The node id in the template graph. */
  id: string;
  kind: SlotKind;
  label: string;
  /** The node param a fill sets: `assetId` for media, `text` for words. */
  param: 'assetId' | 'text';
  /** A project made without filling it still works (text slots carry a default). */
  required: boolean;
  /** Default text / asset id already in the graph. */
  default?: string;
}

/** A fill per slot id: an asset for media slots, text for text slots. */
export const SlotFillSchema = z.record(
  z.string().max(80),
  z.union([z.object({ assetId: z.string().min(1).max(64) }), z.object({ text: z.string().max(8000) })]),
);
export type SlotFills = z.infer<typeof SlotFillSchema>;

export interface TemplateMeta {
  durationSec: number;
  /** e.g. `9:16`. */
  ratio: string;
  /** Characters to cast (picture slots of people / products). */
  roles: number;
  hasLines: boolean;
  nodeCount: number;
  tags: string[];
  featured?: boolean;
  /** Agent skill the template matches (Home inspiration → Agent mode). */
  skill?: string;
}

const TEXT_KINDS = new Set<NodeKind>(['text', 'script']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Slots of a graph: asset nodes and text/script nodes, in graph order. */
export function inferSlots(graph: Pick<TemplateGraph, 'nodes'>): TemplateSlot[] {
  const slots: TemplateSlot[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'asset') {
      const kind = (outputType(n) ?? 'image') as SlotKind;
      const assetId = str(n.params.assetId);
      slots.push({ id: n.id, kind, label: n.title, param: kind === 'text' ? 'text' : 'assetId', required: !assetId, ...(assetId && { default: assetId }) });
    } else if (TEXT_KINDS.has(n.kind)) {
      const text = str(n.params.text) ?? str(n.params.script) ?? str(n.params.prompt);
      slots.push({ id: n.id, kind: 'text', label: n.title, param: 'text', required: !text, ...(text && { default: text }) });
    }
  }
  return slots;
}

/** Listing facts derived from a graph (length of the video nodes, ratio, cast, lines). */
export function summarizeGraph(graph: TemplateGraph, extra: Partial<TemplateMeta> = {}): TemplateMeta {
  const videos = graph.nodes.filter((n) => n.kind === 'video');
  const seconds = (n: GraphNode) => {
    const v = n.params.length ?? n.params.seconds;
    const s = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
    return Number.isFinite(s) ? s : 5;
  };
  const ratio = graph.nodes.map((n) => str(n.params.ratio)).find((r) => r !== undefined) ?? '16:9';
  return {
    durationSec: videos.reduce((s, n) => s + seconds(n), 0),
    ratio,
    roles: graph.nodes.filter((n) => n.kind === 'asset' && (outputType(n) ?? 'image') === 'image').length,
    hasLines: graph.nodes.some((n) => n.kind === 'script') || graph.nodes.some((n) => n.kind === 'asset' && outputType(n) === 'audio'),
    nodeCount: graph.nodes.length,
    tags: [],
    ...extra,
  };
}

export class SlotFillError extends Error {
  override readonly name = 'SlotFillError';
  constructor(
    readonly slotId: string,
    message: string,
  ) {
    super(message);
  }
}

/** The graph with slot fills written into the node params. Unknown slot ids and kind mismatches throw `SlotFillError`. */
export function fillSlots(graph: TemplateGraph, fills: SlotFills = {}): TemplateGraph {
  const slots = new Map(inferSlots(graph).map((s) => [s.id, s]));
  for (const id of Object.keys(fills)) {
    const slot = slots.get(id);
    if (!slot) throw new SlotFillError(id, `Template has no slot “${id}”.`);
    const fill = fills[id]!;
    if (slot.param === 'assetId' && !('assetId' in fill)) throw new SlotFillError(id, `Slot “${slot.label}” takes a file.`);
    if (slot.param === 'text' && !('text' in fill)) throw new SlotFillError(id, `Slot “${slot.label}” takes text.`);
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const fill = fills[n.id];
      if (!fill) return n;
      if ('assetId' in fill) return { ...n, params: { ...n.params, assetId: fill.assetId } };
      const key = n.kind === 'script' && typeof n.params.script === 'string' ? 'script' : 'text';
      return { ...n, params: { ...n.params, [key]: fill.text } };
    }),
  };
}

/** Runtime fields a template never keeps. */
function cleanNode(n: GraphNode, dx: number, dy: number): GraphNode {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    params: n.params,
    position: { x: Math.round(n.position.x - dx), y: Math.round(n.position.y - dy) },
    groupId: n.groupId,
    status: 'idle',
    createdBy: 'user',
    ...(n.bypass && { bypass: true }),
    ...(n.collapsed && { collapsed: true }),
  };
}

/**
 * "Save selection as template": the selected nodes, the edges between them
 * and the groups wholly inside, moved to the origin, without versions or run
 * state. Asset ids stay as slot defaults (workspace templates are private).
 */
export function selectionGraph(state: Pick<GraphState, 'nodes' | 'edges' | 'groups'>, nodeIds: readonly string[]): TemplateGraph {
  const ids = new Set(nodeIds);
  const picked = state.nodes.filter((n) => ids.has(n.id));
  const dx = picked.length ? Math.min(...picked.map((n) => n.position.x)) : 0;
  const dy = picked.length ? Math.min(...picked.map((n) => n.position.y)) : 0;
  const groups = state.groups.filter((g) => g.nodeIds.length > 0 && g.nodeIds.every((id) => ids.has(id)));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    nodes: picked.map((n) => cleanNode({ ...n, groupId: n.groupId && groupIds.has(n.groupId) ? n.groupId : null }, dx, dy)),
    edges: state.edges
      .filter((e) => ids.has(e.from.node) && ids.has(e.to.node))
      .map((e) => ({ id: e.id, from: e.from, to: e.to, ...(e.reroutes && { reroutes: e.reroutes.map((p) => ({ x: p.x - dx, y: p.y - dy })) }) })),
    groups,
  };
}
