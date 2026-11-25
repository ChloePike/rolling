/**
 * ProjectRoom WebSocket protocol (D-003): typed messages over the envelope in
 * `./envelope`. A patch is answered with `ack { revision }` or
 * `conflict { snapshot }` carrying the patch's id.
 */
import type { TypedEnvelope as WsEnvelope } from './envelope';
import type { GraphGroup, GraphNode, GraphState, LocalOp, NodeKind, NodeStatus } from './types';

/** Node row as stored in ProjectRoom (`nodes` table) plus runtime columns. */
export interface NodeRow {
  id: string;
  canvas_id: string;
  kind: NodeKind;
  title: string;
  params: string;
  x: number;
  y: number;
  group_id: string | null;
  active_version_id: string | null;
  status: NodeStatus;
  created_by: string;
  updated_at: number;
  /** Runtime, not a column: progress 0..1, quoted credits, version n/total, refund. */
  progress?: number;
  cost?: number;
  version_n?: number;
  version_total?: number;
  refunded?: number;
  /** Columns `bypass` / `collapsed` (0/1); absent means off. */
  bypass?: number;
  collapsed?: number;
}

export interface EdgeRow {
  id: string;
  canvas_id: string;
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
  ord: number;
  pinned_version_id: string | null;
  /** JSON `[{x,y}, …]` reroute points, or absent. */
  reroutes?: string | null;
}

export interface GroupRow {
  id: string;
  canvas_id: string;
  title: string;
  color: string | null;
}

export interface ProjectSnapshot {
  projectId: string | null;
  revision: number;
  canvases: Array<{ id: string; title: string; viewport: string | null }>;
  nodes: NodeRow[];
  edges: EdgeRow[];
  groups?: GroupRow[];
}

export interface GraphPatch {
  baseRevision: number;
  ops: LocalOp[];
}

export type ServerMessage =
  | WsEnvelope<'snapshot', ProjectSnapshot>
  | WsEnvelope<'hello', { actor: string }>
  | WsEnvelope<'ack', { revision: number }>
  | WsEnvelope<'conflict', { snapshot: ProjectSnapshot }>
  | WsEnvelope<'error', { code: string; message: string; data?: unknown }>
  | WsEnvelope<'pong', null>
  | WsEnvelope<'graph.patched', { revision: number; ops: LocalOp[]; actor: string }>
  /** The job waits for upstream jobs of the same run (keyframes before the videos they feed). */
  | WsEnvelope<'job.queued', { jobId: string; nodeId: string }>
  | WsEnvelope<'job.progress', { jobId: string; nodeId: string; progress: number }>
  /** The node's active version changed (switch, or another tab picked one). */
  | WsEnvelope<'node.version', { nodeId: string; version: { n: number; total: number } }>
  | WsEnvelope<'job.done', { jobId: string; nodeId: string; version: { n: number; total: number } }>
  | WsEnvelope<'job.failed', { jobId: string; nodeId: string; refunded: number; reason: string }>
  | WsEnvelope<'credits.changed', { balance: number; held: number }>;

export type ClientMessage = WsEnvelope<'patch', GraphPatch> | WsEnvelope<'ping', null>;

const CANVAS_ID = 'cnv_main';

export function toSnapshot(projectId: string, state: GraphState): ProjectSnapshot {
  const order = new Map<string, number>();
  return {
    projectId,
    revision: state.revision,
    canvases: [{ id: CANVAS_ID, title: 'Main', viewport: null }],
    nodes: state.nodes.map((n) => ({
      id: n.id,
      canvas_id: CANVAS_ID,
      kind: n.kind,
      title: n.title,
      params: JSON.stringify(n.params),
      x: n.position.x,
      y: n.position.y,
      group_id: n.groupId,
      active_version_id: null,
      status: n.status,
      created_by: n.createdBy,
      updated_at: 0,
      ...(n.progress !== undefined ? { progress: n.progress } : {}),
      ...(n.cost !== undefined ? { cost: n.cost } : {}),
      ...(n.version ? { version_n: n.version.n, version_total: n.version.total } : {}),
      ...(n.refunded !== undefined ? { refunded: n.refunded } : {}),
      ...(n.bypass ? { bypass: 1 } : {}),
      ...(n.collapsed ? { collapsed: 1 } : {}),
    })),
    edges: state.edges.map((e) => {
      const k = `${e.to.node}:${e.to.port}`;
      const ord = order.get(k) ?? 0;
      order.set(k, ord + 1);
      return {
        id: e.id,
        canvas_id: CANVAS_ID,
        from_node: e.from.node,
        from_port: e.from.port,
        to_node: e.to.node,
        to_port: e.to.port,
        ord,
        pinned_version_id: null,
        ...(e.reroutes?.length ? { reroutes: JSON.stringify(e.reroutes) } : {}),
      };
    }),
    groups: state.groups.map((g) => ({ id: g.id, canvas_id: CANVAS_ID, title: g.title, color: null })),
  };
}

export function fromSnapshot(s: ProjectSnapshot): GraphState {
  const nodes: GraphNode[] = s.nodes.map((r) => {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(r.params) as Record<string, unknown>;
    } catch {
      params = {};
    }
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      params,
      position: { x: r.x, y: r.y },
      groupId: r.group_id,
      status: r.status,
      createdBy: r.created_by === 'agent' ? 'agent' : 'user',
      ...(r.progress !== undefined ? { progress: r.progress } : {}),
      ...(r.cost !== undefined ? { cost: r.cost } : {}),
      ...(r.version_n !== undefined ? { version: { n: r.version_n, total: r.version_total ?? r.version_n } } : {}),
      ...(r.refunded !== undefined ? { refunded: r.refunded } : {}),
      ...(r.bypass ? { bypass: true } : {}),
      ...(r.collapsed ? { collapsed: true } : {}),
    };
  });
  const groups: GraphGroup[] = (s.groups ?? []).map((g) => ({ id: g.id, title: g.title, nodeIds: nodes.filter((n) => n.groupId === g.id).map((n) => n.id) }));
  const edges = [...s.edges]
    .sort((a, b) => a.ord - b.ord)
    .map((e) => {
      let reroutes: Array<{ x: number; y: number }> | undefined;
      try {
        reroutes = e.reroutes ? (JSON.parse(e.reroutes) as Array<{ x: number; y: number }>) : undefined;
      } catch {
        reroutes = undefined;
      }
      return { id: e.id, from: { node: e.from_node, port: e.from_port }, to: { node: e.to_node, port: e.to_port }, ...(reroutes?.length ? { reroutes } : {}) };
    });
  // Keep the row order for edges (stable rendering).
  const rowOrder = new Map(s.edges.map((e, i) => [e.id, i]));
  edges.sort((a, b) => rowOrder.get(a.id)! - rowOrder.get(b.id)!);
  return { revision: s.revision, nodes, edges, groups };
}

let seq = 0;
export function messageId(): string {
  seq += 1;
  return `m_${Date.now().toString(36)}_${seq}`;
}
