/**
 * Graph model for the canvas, shaped like the ProjectRoom tables
 * (db/do-project.sql) and the GraphOp patch format (docs/harness.md §5).
 * Shared by the canvas (apps/web) and ProjectRoom (apps/api).
 */

export type NodeKind = 'text' | 'script' | 'image' | 'video' | 'audio' | 'asset' | 'render';

/** What flows along an edge. */
export type PortType = 'text' | 'image' | 'video' | 'audio';

/**
 * Run state of a node. `outdated` means a version exists but an input changed
 * since it was made ("Input changed").
 */
export type NodeStatus = 'idle' | 'outdated' | 'queued' | 'generating' | 'done' | 'failed';

export interface XY {
  x: number;
  y: number;
}

/** Free-form per-kind parameters (prompt, model, duration, rows, ...). */
export type NodeParams = Record<string, unknown>;

export interface GraphNode {
  id: string;
  kind: NodeKind;
  title: string;
  params: NodeParams;
  position: XY;
  groupId: string | null;
  status: NodeStatus;
  /** 0..1 while generating; real progress from `job.progress`. */
  progress?: number;
  /** Credits the next run will cost; shown as the cost chip only when it will run. */
  cost?: number;
  /** Credits refunded after a failure. */
  refunded?: number;
  /** Active version number and how many exist. */
  version?: { n: number; total: number };
  createdBy: 'user' | 'agent';
}

export interface PortRef {
  node: string;
  port: string;
}

export interface GraphEdge {
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface GraphGroup {
  id: string;
  title: string;
  nodeIds: string[];
}

export interface GraphState {
  revision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}

/**
 * Patch operations. The first six are docs/harness.md §5 verbatim; `moveNode`
 * is a client extension for user drags (the harness format has no position op),
 * and `connect` / `group` accept an optional fixed id (`addNode` uses a
 * `node_` tempId) so client and server create the same ids and undo can
 * restore the exact element it removed.
 */
export type GraphOp =
  | { op: 'addNode'; tempId: string; kind: NodeKind; title: string; params: NodeParams; position?: XY }
  | { op: 'updateNode'; nodeId: string; params: Partial<NodeParams>; title?: string }
  | { op: 'connect'; from: PortRef; to: PortRef; edgeId?: string }
  | { op: 'disconnect'; edgeId: string }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'group'; nodeIds: string[]; title: string; groupId?: string }
  | { op: 'moveNode'; nodeId: string; position: XY };

/** Ops the client may send: GraphOp plus `ungroup` (undo of `group`). */
export type LocalOp = GraphOp | { op: 'ungroup'; groupId: string };

export type RefusalCode =
  | 'NODE_NOT_FOUND'
  | 'EDGE_NOT_FOUND'
  | 'PORT_NOT_FOUND'
  | 'PORT_TYPE_MISMATCH'
  | 'SELF_CONNECTION'
  | 'DUPLICATE_EDGE'
  | 'CYCLE'
  | 'PORT_FULL'
  | 'DUPLICATE_ID'
  | 'EMPTY_GROUP';

export interface Refusal {
  code: RefusalCode;
  /** Human-readable reason, English. The UI maps `code` + `data` to a message id. */
  message: string;
  opIndex?: number;
  data?: Record<string, string>;
}
