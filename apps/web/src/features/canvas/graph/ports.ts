import type { GraphEdge, GraphNode, NodeKind, PortType, Refusal } from './types';

export interface PortSpec {
  name: string;
  type: PortType;
  /** How many edges may end here (inputs) — outputs are unlimited. */
  max?: number;
}

interface KindPorts {
  inputs: PortSpec[];
  output: PortType | null;
}

/** Typed ports per node kind. Outputs are a single `out` port. */
const PORTS: Record<Exclude<NodeKind, 'asset'>, KindPorts> = {
  text: { inputs: [], output: 'text' },
  // Scripts and voiceovers hold their own text (written by the user or the agent).
  script: { inputs: [], output: 'text' },
  image: {
    inputs: [
      { name: 'prompt', type: 'text', max: 1 },
      { name: 'refs', type: 'image', max: 8 },
    ],
    output: 'image',
  },
  video: {
    inputs: [
      { name: 'prompt', type: 'text', max: 1 },
      { name: 'frame', type: 'image', max: 2 },
      { name: 'audio', type: 'audio', max: 1 },
    ],
    output: 'video',
  },
  audio: { inputs: [], output: 'audio' },
  render: {
    inputs: [
      { name: 'clips', type: 'video', max: 64 },
      { name: 'audio', type: 'audio', max: 8 },
    ],
    output: 'video',
  },
};

export const OUT_PORT = 'out';

/** Media of an uploaded asset node (`params.media`), defaults to image. */
function assetMedia(node: Pick<GraphNode, 'params'>): PortType {
  const m = node.params.media;
  return m === 'video' || m === 'audio' || m === 'text' ? m : 'image';
}

export function inputPorts(node: Pick<GraphNode, 'kind'>): PortSpec[] {
  return node.kind === 'asset' ? [] : PORTS[node.kind].inputs;
}

export function outputType(node: Pick<GraphNode, 'kind' | 'params'>): PortType | null {
  return node.kind === 'asset' ? assetMedia(node) : PORTS[node.kind].output;
}

export function hasInputs(node: Pick<GraphNode, 'kind'>): boolean {
  return inputPorts(node).length > 0;
}

const KIND_LABEL: Record<NodeKind, string> = {
  text: 'Text',
  script: 'Script',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  asset: 'Asset',
  render: 'Render',
};

/** Picks the input port of `target` that accepts what `source` outputs. */
export function resolveInputPort(source: GraphNode, target: GraphNode): { port: string } | { refusal: Refusal } {
  const type = outputType(source);
  const ports = inputPorts(target);
  const match = type ? ports.find((p) => p.type === type) : undefined;
  if (!type || !match) {
    return {
      refusal: {
        code: 'PORT_TYPE_MISMATCH',
        message: `${KIND_LABEL[target.kind]} nodes don’t take ${type ?? 'this'} input.`,
        data: { kind: target.kind, type: type ?? 'none' },
      },
    };
  }
  return { port: match.name };
}

function reaches(edges: GraphEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from.node === id) stack.push(e.to.node);
  }
  return false;
}

/**
 * Port type validation for one edge (core/graph/validate on the server):
 * ids exist, the output feeds a port of the same type, no self edge, no
 * duplicate, the port has room, and no cycle.
 */
export function validateConnection(
  nodes: GraphNode[],
  edges: GraphEdge[],
  from: { node: string; port: string },
  to: { node: string; port: string },
): Refusal | null {
  const source = nodes.find((n) => n.id === from.node);
  const target = nodes.find((n) => n.id === to.node);
  if (!source || !target) {
    return { code: 'NODE_NOT_FOUND', message: 'One end of this connection no longer exists.', data: { nodeId: source ? to.node : from.node } };
  }
  if (source.id === target.id) return { code: 'SELF_CONNECTION', message: 'A node can’t feed itself.' };
  if (from.port !== OUT_PORT) return { code: 'PORT_NOT_FOUND', message: `No output port “${from.port}”.`, data: { port: from.port } };
  const spec = inputPorts(target).find((p) => p.name === to.port);
  if (!spec) {
    if (!hasInputs(target)) {
      return { code: 'PORT_TYPE_MISMATCH', message: `${KIND_LABEL[target.kind]} nodes have no inputs.`, data: { kind: target.kind, type: 'none' } };
    }
    return { code: 'PORT_NOT_FOUND', message: `No input port “${to.port}”.`, data: { port: to.port } };
  }
  const type = outputType(source);
  if (type !== spec.type) {
    return {
      code: 'PORT_TYPE_MISMATCH',
      message: `${KIND_LABEL[target.kind]} nodes don’t take ${type ?? 'this'} input.`,
      data: { kind: target.kind, type: type ?? 'none' },
    };
  }
  if (edges.some((e) => e.from.node === from.node && e.to.node === to.node && e.to.port === to.port)) {
    return { code: 'DUPLICATE_EDGE', message: 'These nodes are already connected.' };
  }
  const used = edges.filter((e) => e.to.node === to.node && e.to.port === to.port).length;
  if (spec.max !== undefined && used >= spec.max) {
    return { code: 'PORT_FULL', message: `This ${spec.name} input is already connected.`, data: { port: spec.name } };
  }
  if (reaches(edges, target.id, source.id)) {
    return { code: 'CYCLE', message: 'That would make a loop.' };
  }
  return null;
}
