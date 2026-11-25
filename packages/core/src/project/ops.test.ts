import { describe, expect, it } from 'vitest';
import type { GraphState, LocalOp } from '../graph/types';
import { computeInputDigests, derivedStatus } from './digest';
import { applyGraphOps, diffGraph, parseOps, sameGraph } from './ops';

const empty: GraphState = { revision: 0, nodes: [], edges: [], groups: [] };

function seq() {
  let n = 0;
  return { node: () => `node_N${++n}`, edge: () => `edge_E${++n}`, group: () => `grp_G${++n}` };
}

function build(ops: LocalOp[], state = empty) {
  const r = applyGraphOps(state, ops, { ids: seq() });
  if (!r.ok) throw new Error(r.refusal.message);
  return r;
}

describe('applyGraphOps', () => {
  it('resolves temp ids, normalizes ops and assigns edge and group ids', () => {
    const r = build([
      { op: 'addNode', tempId: 't1', kind: 'text', title: 'Prompt', params: { text: 'a cat' } },
      { op: 'addNode', tempId: 'node_IMG', kind: 'image', title: 'Image', params: {} },
      { op: 'connect', from: { node: 't1', port: 'out' }, to: { node: 'node_IMG', port: 'prompt' } },
      { op: 'group', nodeIds: ['t1', 'node_IMG'], title: 'Shot 1' },
    ]);
    const textId = r.idMap.t1!;
    expect(textId).toMatch(/^node_/);
    expect(r.state.revision).toBe(1);
    expect(r.state.edges).toHaveLength(1);
    expect(r.ops[2]).toMatchObject({ op: 'connect', from: { node: textId }, edgeId: expect.stringMatching(/^edge_/) });
    expect(r.ops[3]).toMatchObject({ op: 'group', groupId: expect.stringMatching(/^grp_/), nodeIds: [textId, 'node_IMG'] });
    expect(r.state.nodes.every((n) => n.groupId === r.state.groups[0]!.id)).toBe(true);
  });

  it('refuses invalid connections with a reason and changes nothing', () => {
    const base = build([
      { op: 'addNode', tempId: 'node_A', kind: 'audio', title: 'Voice', params: {} },
      { op: 'addNode', tempId: 'node_I', kind: 'image', title: 'Image', params: {} },
    ]).state;
    const r = applyGraphOps(base, [{ op: 'connect', from: { node: 'node_A', port: 'out' }, to: { node: 'node_I', port: 'refs' } }]);
    expect(r).toMatchObject({ ok: false, refusal: { code: 'PORT_TYPE_MISMATCH', opIndex: 0 } });
  });

  it('refuses cycles, duplicate ids and bad prefixes', () => {
    const base = build([
      { op: 'addNode', tempId: 'node_I1', kind: 'image', title: 'A', params: {} },
      { op: 'addNode', tempId: 'node_V', kind: 'video', title: 'B', params: {} },
      { op: 'connect', from: { node: 'node_I1', port: 'out' }, to: { node: 'node_V', port: 'frame' }, edgeId: 'edge_1' },
    ]).state;
    expect(applyGraphOps(base, [{ op: 'addNode', tempId: 'node_I1', kind: 'text', title: 'x', params: {} }])).toMatchObject({
      ok: false,
      refusal: { code: 'DUPLICATE_ID' },
    });
    expect(parseOps([{ op: 'connect', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'x' }, edgeId: 'e1' }])).toMatchObject({
      ok: false,
      refusal: { code: 'INVALID_OP' },
    });
    expect(parseOps([{ op: 'nope' }])).toMatchObject({ ok: false });
  });

  it('removes nodes with their edges and empty groups', () => {
    const r = build([
      { op: 'addNode', tempId: 'node_T', kind: 'text', title: 'T', params: {} },
      { op: 'addNode', tempId: 'node_I', kind: 'image', title: 'I', params: {} },
      { op: 'connect', from: { node: 'node_T', port: 'out' }, to: { node: 'node_I', port: 'prompt' } },
      { op: 'group', nodeIds: ['node_T'], title: 'G' },
      { op: 'removeNode', nodeId: 'node_T' },
    ]);
    expect(r.state.nodes.map((n) => n.id)).toEqual(['node_I']);
    expect(r.state.edges).toEqual([]);
    expect(r.state.groups).toEqual([]);
  });
});

describe('diffGraph', () => {
  it('produces an exact inverse for every kind of change', () => {
    const before = build([
      { op: 'addNode', tempId: 'node_T', kind: 'text', title: 'T', params: { text: 'a', keep: 1 } },
      { op: 'addNode', tempId: 'node_I', kind: 'image', title: 'I', params: {} },
      { op: 'connect', from: { node: 'node_T', port: 'out' }, to: { node: 'node_I', port: 'prompt' }, edgeId: 'edge_X' },
      { op: 'group', nodeIds: ['node_T', 'node_I'], title: 'G', groupId: 'grp_G' },
    ]).state;
    const after = build(
      [
        { op: 'updateNode', nodeId: 'node_T', params: { text: 'b', added: true, keep: null }, title: 'T2' },
        { op: 'moveNode', nodeId: 'node_I', position: { x: 10, y: 20 } },
        { op: 'removeNode', nodeId: 'node_T' },
        { op: 'addNode', tempId: 'node_V', kind: 'video', title: 'V', params: {} },
      ],
      before,
    ).state;
    const undo = applyGraphOps(after, diffGraph(after, before));
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(sameGraph(undo.state, before)).toBe(true);
    const redo = applyGraphOps(before, diffGraph(before, after));
    expect(redo.ok && sameGraph(redo.state, after)).toBe(true);
  });
});

describe('input digests', () => {
  it('changes downstream when an upstream param changes and derives staleness', () => {
    const s1 = build([
      { op: 'addNode', tempId: 'node_T', kind: 'text', title: 'T', params: { text: 'a' } },
      { op: 'addNode', tempId: 'node_I', kind: 'image', title: 'I', params: { model: 'm' } },
      { op: 'connect', from: { node: 'node_T', port: 'out' }, to: { node: 'node_I', port: 'prompt' } },
    ]).state;
    const versions = new Map([['node_I', 'ver_1']]);
    const d1 = computeInputDigests(s1, versions);
    const moved = build([{ op: 'moveNode', nodeId: 'node_I', position: { x: 5, y: 5 } }], s1).state;
    expect(computeInputDigests(moved, versions).get('node_I')).toBe(d1.get('node_I'));
    const s2 = build([{ op: 'updateNode', nodeId: 'node_T', params: { text: 'b' } }], s1).state;
    const d2 = computeInputDigests(s2, versions);
    expect(d2.get('node_I')).not.toBe(d1.get('node_I'));
    expect(derivedStatus('done', d1.get('node_I')!, d2.get('node_I')!)).toBe('outdated');
    expect(derivedStatus('outdated', d1.get('node_I')!, d1.get('node_I')!)).toBe('done');
    expect(derivedStatus('generating', d1.get('node_I')!, d2.get('node_I')!)).toBe('generating');
  });
});

describe('layout', () => {
  it('places plan nodes left to right by dependency', () => {
    const r = build([
      { op: 'addNode', tempId: 's', kind: 'script', title: 'Script', params: {} },
      { op: 'addNode', tempId: 'p', kind: 'text', title: 'Prompt', params: {} },
      { op: 'addNode', tempId: 'k', kind: 'image', title: 'Keyframe', params: {} },
      { op: 'addNode', tempId: 'v', kind: 'video', title: 'Shot', params: {} },
      { op: 'connect', from: { node: 'p', port: 'out' }, to: { node: 'k', port: 'prompt' } },
      { op: 'connect', from: { node: 'k', port: 'out' }, to: { node: 'v', port: 'frame' } },
    ]);
    const pos = (t: string) => r.state.nodes.find((n) => n.id === r.idMap[t])!.position;
    expect(pos('p').x).toBeLessThan(pos('k').x);
    expect(pos('k').x).toBeLessThan(pos('v').x);
    expect(pos('s').x).toBe(pos('p').x);
    expect(pos('s').y).not.toBe(pos('p').y);
    const add = r.ops.find((o) => o.op === 'addNode' && o.tempId === r.idMap.v);
    expect(add).toMatchObject({ position: pos('v') });
  });
});
