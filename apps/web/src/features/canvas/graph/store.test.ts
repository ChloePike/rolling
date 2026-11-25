import { describe, expect, it } from 'vitest';
import { applyOps, GraphStore, normalizeOps } from './store';
import type { GraphState } from './types';

let n = 0;
const ids = { node: () => `node_T${++n}`, edge: () => `edge_T${++n}`, group: () => `grp_T${++n}` };

function base(): GraphState {
  return {
    revision: 3,
    nodes: [
      { id: 'node_script', kind: 'script', title: 'Script', params: {}, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy: 'user' },
      { id: 'node_img', kind: 'image', title: 'Keyframe', params: { prompt: 'a' }, position: { x: 300, y: 0 }, groupId: null, status: 'done', createdBy: 'user' },
      { id: 'node_vid', kind: 'video', title: 'Shot A', params: {}, position: { x: 600, y: 0 }, groupId: null, status: 'done', createdBy: 'user' },
      { id: 'node_aud', kind: 'audio', title: 'Voiceover', params: {}, position: { x: 0, y: 300 }, groupId: null, status: 'idle', createdBy: 'user' },
    ],
    edges: [{ id: 'edge_1', from: { node: 'node_img', port: 'out' }, to: { node: 'node_vid', port: 'frame' } }],
    groups: [],
  };
}

describe('applyOps', () => {
  it('adds a node, resolves its temp id in later ops and bumps the revision once', () => {
    const r = applyOps(base(), [
      { op: 'addNode', tempId: 't1', kind: 'text', title: 'Brief', params: {} },
      { op: 'connect', from: { node: 't1', port: 'out' }, to: { node: 'node_img', port: 'prompt' } },
    ], ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.revision).toBe(4);
    const id = r.idMap.t1!;
    expect(r.state.nodes.find((x) => x.id === id)?.kind).toBe('text');
    expect(r.state.edges.some((e) => e.from.node === id && e.to.port === 'prompt')).toBe(true);
  });

  it('refuses a connection whose types do not match, with a reason, and changes nothing', () => {
    const state = base();
    const r = applyOps(state, [{ op: 'connect', from: { node: 'node_aud', port: 'out' }, to: { node: 'node_img', port: 'refs' } }], ids);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('PORT_TYPE_MISMATCH');
    expect(r.refusal.message).toBe('Image nodes don’t take audio input.');
    expect(r.refusal.opIndex).toBe(0);
    expect(state.edges).toHaveLength(1);
  });

  it('refuses cycles, self edges, duplicates and full ports', () => {
    const s = base();
    const cyc = applyOps(s, [
      { op: 'connect', from: { node: 'node_vid', port: 'out' }, to: { node: 'node_img', port: 'refs' } },
    ], ids);
    // video output does not feed an image port
    expect(!cyc.ok && cyc.refusal.code).toBe('PORT_TYPE_MISMATCH');
    const self = applyOps(s, [{ op: 'connect', from: { node: 'node_img', port: 'out' }, to: { node: 'node_img', port: 'refs' } }], ids);
    expect(!self.ok && self.refusal.code).toBe('SELF_CONNECTION');
    const dup = applyOps(s, [{ op: 'connect', from: { node: 'node_img', port: 'out' }, to: { node: 'node_vid', port: 'frame' } }], ids);
    expect(!dup.ok && dup.refusal.code).toBe('DUPLICATE_EDGE');
    const loop = applyOps(
      s,
      [
        { op: 'addNode', tempId: 'a', kind: 'image', title: 'A', params: {} },
        { op: 'connect', from: { node: 'node_img', port: 'out' }, to: { node: 'a', port: 'refs' } },
        { op: 'connect', from: { node: 'a', port: 'out' }, to: { node: 'node_img', port: 'refs' } },
      ],
      ids,
    );
    expect(!loop.ok && loop.refusal.code).toBe('CYCLE');
  });

  it('marks downstream done nodes as outdated when an input changes', () => {
    const r = applyOps(base(), [{ op: 'updateNode', nodeId: 'node_img', params: { prompt: 'b' } }], ids);
    expect(r.ok && r.state.nodes.find((x) => x.id === 'node_vid')?.status).toBe('outdated');
    expect(r.ok && r.state.nodes.find((x) => x.id === 'node_img')?.status).toBe('outdated');
  });

  it('removeNode drops its edges; group sets membership', () => {
    const r = applyOps(base(), [{ op: 'group', nodeIds: ['node_img', 'node_vid'], title: 'Shot A' }, { op: 'removeNode', nodeId: 'node_img' }], ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.edges).toHaveLength(0);
    expect(r.state.groups[0]!.nodeIds).toEqual(['node_vid']);
    expect(r.state.nodes.find((x) => x.id === 'node_vid')!.groupId).toBe(r.state.groups[0]!.id);
  });

  it('normalizeOps gives final ids to new nodes, edges and groups', () => {
    const ops = normalizeOps([
      { op: 'addNode', tempId: 'x', kind: 'text', title: 'T', params: {} },
      { op: 'connect', from: { node: 'x', port: 'out' }, to: { node: 'node_img', port: 'prompt' } },
      { op: 'group', nodeIds: ['x'], title: 'G' },
    ], ids);
    expect(ops[0]).toMatchObject({ tempId: expect.stringMatching(/^node_/) });
    expect(ops[1]).toMatchObject({ edgeId: expect.stringMatching(/^edge_/), from: { node: (ops[0] as { tempId: string }).tempId } });
    expect(ops[2]).toMatchObject({ groupId: expect.stringMatching(/^grp_/) });
  });
});

describe('GraphStore', () => {
  it('plans a connection by picking the matching input port, or refuses with a reason', () => {
    const store = new GraphStore(base(), ids);
    const ok = store.planConnect('node_aud', 'node_vid');
    expect(ok.ok && ok.op).toMatchObject({ to: { node: 'node_vid', port: 'audio' } });
    const bad = store.planConnect('node_aud', 'node_img');
    expect(!bad.ok && bad.refusal.message).toBe('Image nodes don’t take audio input.');
    const none = store.planConnect('node_vid', 'node_script');
    expect(!none.ok && none.refusal.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('undo and redo restore exact ids and statuses as forward patches', () => {
    const store = new GraphStore(base(), ids);
    store.apply([{ op: 'removeNode', nodeId: 'node_img' }]);
    expect(store.getState().revision).toBe(4);
    expect(store.getState().nodes.find((x) => x.id === 'node_vid')!.status).toBe('outdated');
    const u = store.undo();
    expect(u?.result.ok).toBe(true);
    expect(store.getState().revision).toBe(5);
    expect(store.getState().nodes.find((x) => x.id === 'node_img')!.status).toBe('done');
    expect(store.getState().nodes.find((x) => x.id === 'node_vid')!.status).toBe('done');
    expect(store.getState().edges.map((e) => e.id)).toEqual(['edge_1']);
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(store.getState().nodes.some((x) => x.id === 'node_img')).toBe(false);
    expect(store.canUndo).toBe(true);
  });

  it('a new edit clears redo; runtime updates do not touch the revision', () => {
    const store = new GraphStore(base(), ids);
    store.apply([{ op: 'moveNode', nodeId: 'node_aud', position: { x: 10, y: 10 } }]);
    store.undo();
    store.apply([{ op: 'updateNode', nodeId: 'node_aud', params: { voice: 'Clear female' } }]);
    expect(store.canRedo).toBe(false);
    const rev = store.getState().revision;
    store.setRuntime('node_vid', { status: 'generating', progress: 0.5 });
    expect(store.getState().revision).toBe(rev);
    expect(store.getState().nodes.find((x) => x.id === 'node_vid')!.progress).toBe(0.5);
  });
});
