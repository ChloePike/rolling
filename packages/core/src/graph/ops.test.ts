import { describe, expect, it } from 'vitest';
import { applyFlagOp, blockedByBypass, bypassSource, FlagOpSchemas, MAX_REROUTES, rerouteIndex, runScopeNodes } from './ops';
import type { GraphNode, GraphState } from './types';

const node = (id: string, kind: GraphNode['kind'], status: GraphNode['status'] = 'idle', extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind,
  title: id,
  params: {},
  position: { x: 0, y: 0 },
  groupId: null,
  status,
  createdBy: 'user',
  ...extra,
});

function graph(): GraphState {
  return {
    revision: 1,
    nodes: [node('t', 'text', 'done'), node('a', 'asset', 'done'), node('k', 'image', 'outdated'), node('k2', 'image', 'done'), node('v', 'video'), node('r', 'render')],
    edges: [
      { id: 'e1', from: { node: 't', port: 'out' }, to: { node: 'k', port: 'prompt' } },
      { id: 'e2', from: { node: 'a', port: 'out' }, to: { node: 'k', port: 'refs' } },
      { id: 'e3', from: { node: 'k', port: 'out' }, to: { node: 'v', port: 'frame' } },
      { id: 'e4', from: { node: 'k2', port: 'out' }, to: { node: 'v', port: 'frame' } },
      { id: 'e5', from: { node: 'v', port: 'out' }, to: { node: 'r', port: 'clips' } },
    ],
    groups: [],
  };
}

describe('setBypass / setCollapsed', () => {
  it('sets and clears the flags', () => {
    const g = graph();
    expect(applyFlagOp(g, { op: 'setBypass', nodeId: 'k', bypass: true })).toBeNull();
    expect(g.nodes.find((n) => n.id === 'k')!.bypass).toBe(true);
    applyFlagOp(g, { op: 'setBypass', nodeId: 'k', bypass: false });
    expect('bypass' in g.nodes.find((n) => n.id === 'k')!).toBe(false);
    applyFlagOp(g, { op: 'setCollapsed', nodeId: 'v', collapsed: true });
    expect(g.nodes.find((n) => n.id === 'v')!.collapsed).toBe(true);
  });

  it('refuses unknown nodes', () => {
    expect(applyFlagOp(graph(), { op: 'setBypass', nodeId: 'nope', bypass: true })?.code).toBe('NODE_NOT_FOUND');
  });

  it('validates op shapes', () => {
    const [bypass] = FlagOpSchemas;
    expect(bypass.safeParse({ op: 'setBypass', nodeId: 'node_1', bypass: true }).success).toBe(true);
    expect(bypass.safeParse({ op: 'setBypass', nodeId: 'node 1', bypass: 'yes' }).success).toBe(false);
  });
});

describe('bypass pass-through', () => {
  it('a bypassed image node passes its image input through', () => {
    const g = graph();
    g.nodes.find((n) => n.id === 'k')!.bypass = true;
    expect(bypassSource(g, 'k')).toEqual({ ok: true, source: 'a' });
    expect(blockedByBypass(g, 'v')).toBeNull();
  });

  it('a bypassed node without a matching input blocks dependents with a reason', () => {
    const g = graph();
    g.nodes.find((n) => n.id === 'v')!.bypass = true;
    const r = bypassSource(g, 'v');
    expect(r.ok).toBe(false);
    expect(blockedByBypass(g, 'r')?.message).toMatch(/bypassed/);
  });

  it('follows chains of bypassed nodes', () => {
    const g = graph();
    g.nodes.find((n) => n.id === 'k')!.bypass = true;
    g.nodes.find((n) => n.id === 'a')!.bypass = true;
    // The asset has no inputs, so the chain ends without a source.
    expect(bypassSource(g, 'k').ok).toBe(false);
  });
});

describe('reroutes', () => {
  it('adds, moves and removes points in order', () => {
    const g = graph();
    expect(applyFlagOp(g, { op: 'addReroute', edgeId: 'e3', index: 0, position: { x: 10, y: 10 } })).toBeNull();
    expect(applyFlagOp(g, { op: 'addReroute', edgeId: 'e3', index: 1, position: { x: 20, y: 20 } })).toBeNull();
    applyFlagOp(g, { op: 'moveReroute', edgeId: 'e3', index: 0, position: { x: 5, y: 5 } });
    expect(g.edges.find((e) => e.id === 'e3')!.reroutes).toEqual([{ x: 5, y: 5 }, { x: 20, y: 20 }]);
    applyFlagOp(g, { op: 'removeReroute', edgeId: 'e3', index: 0 });
    applyFlagOp(g, { op: 'removeReroute', edgeId: 'e3', index: 0 });
    expect('reroutes' in g.edges.find((e) => e.id === 'e3')!).toBe(false);
  });

  it('refuses missing points, missing edges and too many points', () => {
    const g = graph();
    expect(applyFlagOp(g, { op: 'removeReroute', edgeId: 'e3', index: 0 })?.code).toBe('REROUTE_NOT_FOUND');
    expect(applyFlagOp(g, { op: 'addReroute', edgeId: 'x', index: 0, position: { x: 0, y: 0 } })?.code).toBe('EDGE_NOT_FOUND');
    for (let i = 0; i < MAX_REROUTES; i++) applyFlagOp(g, { op: 'addReroute', edgeId: 'e1', index: 0, position: { x: i, y: 0 } });
    expect(applyFlagOp(g, { op: 'addReroute', edgeId: 'e1', index: 0, position: { x: 0, y: 0 } })?.code).toBe('TOO_MANY_REROUTES');
  });

  it('picks the segment closest to the click', () => {
    expect(rerouteIndex({ x: 0, y: 0 }, { x: 100, y: 0 }, [{ x: 50, y: 50 }], { x: 80, y: 30 })).toBe(1);
    expect(rerouteIndex({ x: 0, y: 0 }, { x: 100, y: 0 }, [], { x: 50, y: 3 })).toBe(0);
  });
});

describe('run scopes', () => {
  it('upTo: the node plus upstream nodes that need a run', () => {
    expect(runScopeNodes(graph(), 'v', 'upTo').sort()).toEqual(['k', 'v']);
  });

  it('from: the node plus everything downstream', () => {
    expect(runScopeNodes(graph(), 'k', 'from').sort()).toEqual(['k', 'r', 'v']);
  });

  it('node: only the node', () => {
    expect(runScopeNodes(graph(), 'k', 'node')).toEqual(['k']);
  });
});
