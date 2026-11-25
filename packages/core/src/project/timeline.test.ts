import { describe, expect, it } from 'vitest';
import type { GraphState } from '../graph/types';
import { assembleFromGraph } from './timeline';

describe('assembleFromGraph', () => {
  it('builds the cut from the script rows with captions and the voiceover', () => {
    const state: GraphState = {
      revision: 1,
      nodes: [
        { id: 'node_S', kind: 'script', title: 'Script', params: { rows: [{ n: '01', visual: 'a', seconds: 4 }, { n: '02', visual: 'b', line: '“Pop it open.”', seconds: 5 }] }, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy: 'agent' },
        { id: 'node_V2', kind: 'video', title: 'B', params: {}, position: { x: 400, y: 300 }, groupId: null, status: 'done', createdBy: 'agent' },
        { id: 'node_V1', kind: 'video', title: 'A', params: {}, position: { x: 400, y: 0 }, groupId: null, status: 'done', createdBy: 'agent' },
        { id: 'node_A', kind: 'audio', title: 'Voice', params: { seconds: 8 }, position: { x: 0, y: 600 }, groupId: null, status: 'done', createdBy: 'agent' },
      ],
      edges: [],
      groups: [],
    };
    const assets: Record<string, string> = { node_V1: 'ast_1', node_A: 'ast_voice' };
    const edl = assembleFromGraph(state, (id) => assets[id] ?? null);
    const v = edl.tracks.find((t) => t.kind === 'video')!.clips as import('../timeline/types').MediaClip[];
    expect(v.map((c) => [c.nodeId, c.assetId, c.start])).toEqual([['node_V1', 'ast_1', 0], ['node_V2', null, 4]]);
    expect(edl.tracks.find((t) => t.kind === 'caption')!.clips).toMatchObject([{ text: 'Pop it open.', start: 4, end: 9 }]);
    expect(edl.tracks.find((t) => t.kind === 'voice')!.clips).toMatchObject([{ assetId: 'ast_voice', out: 8 }]);
  });
});
