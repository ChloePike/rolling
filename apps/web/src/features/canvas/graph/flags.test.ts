import { describe, expect, it } from 'vitest';
import { applyOps, GraphStore } from './store';
import { MockProjectRoom } from './mockRoom';
import { quoteRun } from '../api';
import type { GraphState } from '@rolling/core/graph';

const ids = { node: () => `node_F${Math.random().toString(36).slice(2, 8)}`, edge: () => 'edge_F1', group: () => 'grp_F1' };

function base(): GraphState {
  return {
    revision: 1,
    nodes: [
      { id: 'node_img', kind: 'image', title: 'Keyframe', params: { runCost: 11 }, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy: 'user' },
      { id: 'node_vid', kind: 'video', title: 'Shot A', params: { runCost: 347 }, position: { x: 300, y: 0 }, groupId: null, status: 'idle', createdBy: 'user' },
    ],
    edges: [{ id: 'edge_1', from: { node: 'node_img', port: 'out' }, to: { node: 'node_vid', port: 'frame' } }],
    groups: [],
  };
}

describe('flag ops in the canvas store', () => {
  it('setBypass, setCollapsed and reroutes apply, and undo restores them as forward patches', () => {
    const store = new GraphStore(base(), ids);
    expect(store.apply([{ op: 'setBypass', nodeId: 'node_img', bypass: true }]).ok).toBe(true);
    expect(store.apply([{ op: 'addReroute', edgeId: 'edge_1', index: 0, position: { x: 150, y: 40 } }]).ok).toBe(true);
    expect(store.apply([{ op: 'setCollapsed', nodeId: 'node_vid', collapsed: true }]).ok).toBe(true);
    expect(store.getState().edges[0]!.reroutes).toEqual([{ x: 150, y: 40 }]);
    const undo1 = store.undo()!;
    expect(undo1.ops).toEqual([{ op: 'setCollapsed', nodeId: 'node_vid', collapsed: false }]);
    const undo2 = store.undo()!;
    expect(undo2.ops).toEqual([{ op: 'removeReroute', edgeId: 'edge_1', index: 0 }]);
    store.undo();
    expect(store.getState().nodes.find((n) => n.id === 'node_img')!.bypass).toBeUndefined();
    store.redo();
    expect(store.getState().nodes.find((n) => n.id === 'node_img')!.bypass).toBe(true);
  });

  it('refuses a reroute on a missing edge atomically', () => {
    const r = applyOps(base(), [
      { op: 'setBypass', nodeId: 'node_img', bypass: true },
      { op: 'removeReroute', edgeId: 'edge_1', index: 0 },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('quotes with bypass', () => {
  it('skips a bypassed node and blocks what it cannot pass through to', () => {
    const g = base();
    g.nodes[0]!.bypass = true;
    const q = quoteRun(g.nodes, g.edges);
    expect(q.items.map((i) => i.action)).toEqual(['bypassed', 'blocked']);
    expect(q.total).toBe(0);
  });

  it('run up to here includes stale upstream nodes', () => {
    const g = base();
    const q = quoteRun(g.nodes, g.edges, ['node_vid'], 'upTo');
    expect(q.items.map((i) => [i.nodeId, i.action])).toEqual([
      ['node_img', 'run'],
      ['node_vid', 'run'],
    ]);
    expect(q.total).toBe(358);
  });
});

describe('mock ProjectRoom jobs', () => {
  it('holds credits, runs upstream first, then settles', () => {
    const room = new MockProjectRoom({ projectId: 'prj_t', initial: base(), frozen: true, credits: { balance: 1000, held: 0 } });
    expect(room.startJobs(['node_img', 'node_vid'], { costs: { node_img: 11, node_vid: 347 } })).toEqual({ ok: true });
    expect(room.credits).toEqual({ balance: 642, held: 358 });
    expect(room.state.nodes.find((n) => n.id === 'node_vid')!.status).toBe('queued');
    room.advance(1);
    expect(room.state.nodes.find((n) => n.id === 'node_img')!.status).toBe('done');
    room.advance(0.5);
    expect(room.state.nodes.find((n) => n.id === 'node_vid')!.status).toBe('generating');
    room.advance(1);
    expect(room.state.nodes.find((n) => n.id === 'node_vid')!.status).toBe('done');
    expect(room.credits).toEqual({ balance: 642, held: 0 });
    room.dispose();
  });

  it('a failed upstream job refunds itself and its queued dependents', () => {
    const room = new MockProjectRoom({ projectId: 'prj_t', initial: base(), frozen: true, credits: { balance: 1000, held: 0 } });
    room.startJobs(['node_img', 'node_vid'], { costs: { node_img: 11, node_vid: 347 }, fail: ['node_img'] });
    room.advance(0.5);
    expect(room.state.nodes.map((n) => n.status)).toEqual(['failed', 'failed']);
    expect(room.credits).toEqual({ balance: 1000, held: 0 });
    room.dispose();
  });

  it('refuses a run the balance cannot cover', () => {
    const room = new MockProjectRoom({ projectId: 'prj_t', initial: base(), frozen: true, credits: { balance: 100, held: 0 } });
    expect(room.startJobs(['node_vid'], { costs: { node_vid: 347 } })).toEqual({ ok: false, code: 'INSUFFICIENT_CREDITS', needed: 247 });
    room.dispose();
  });
});
