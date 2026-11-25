import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProjectRoom } from './mockRoom';
import { GraphStore } from './store';
import { ProjectSync } from './sync';
import type { GraphState, Refusal } from '@rolling/core/graph';

function initial(): GraphState {
  return {
    revision: 7,
    nodes: [
      { id: 'node_img', kind: 'image', title: 'Keyframe', params: {}, position: { x: 0, y: 0 }, groupId: null, status: 'done', createdBy: 'user', version: { n: 2, total: 2 } },
      { id: 'node_vid', kind: 'video', title: 'Shot B', params: {}, position: { x: 300, y: 0 }, groupId: null, status: 'idle', createdBy: 'user', cost: 8 },
    ],
    edges: [],
    groups: [],
  };
}

describe('ProjectSync over the mock ProjectRoom', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const room = new MockProjectRoom({ projectId: 'prj_test', initial: initial(), latency: 5, tick: 100, step: 0.5 });
    const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
    const refusals: Refusal[] = [];
    const failed: Array<[string, number]> = [];
    const sync = new ProjectSync(store, room.connect(), { onRefused: (r) => refusals.push(r), onJobFailed: (id, n) => failed.push([id, n]) });
    return { room, store, sync, refusals, failed };
  }

  it('loads the snapshot, applies a patch optimistically and confirms it with ack', async () => {
    const { room, store, sync } = setup();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getState().revision).toBe(7);
    expect(sync.status).toBe('saved');
    const r = sync.commit([{ op: 'connect', from: { node: 'node_img', port: 'out' }, to: { node: 'node_vid', port: 'frame' } }]);
    expect(r.ok).toBe(true);
    expect(store.getState().edges).toHaveLength(1);
    expect(sync.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(20);
    expect(sync.status).toBe('saved');
    expect(room.state.revision).toBe(8);
    expect(store.getState().revision).toBe(8);
    expect(room.state.edges[0]!.id).toBe(store.getState().edges[0]!.id);
  });

  it('rebases on conflict: takes the server snapshot and replays the pending edit', async () => {
    const { room, store, sync } = setup();
    await vi.advanceTimersByTimeAsync(10);
    // Someone else edits first; our patch arrives with a stale base revision.
    room.state = { ...room.state, revision: 8, nodes: room.state.nodes.map((n) => (n.id === 'node_vid' ? { ...n, title: 'Shot B: Cap pop' } : n)) };
    sync.commit([{ op: 'moveNode', nodeId: 'node_img', position: { x: 40, y: 40 } }]);
    await vi.advanceTimersByTimeAsync(40);
    expect(room.state.revision).toBe(9);
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.title).toBe('Shot B: Cap pop');
    expect(store.getState().nodes.find((n) => n.id === 'node_img')!.position).toEqual({ x: 40, y: 40 });
    expect(sync.status).toBe('saved');
  });

  it('receives graph.patched from others and job progress / failure with refund', async () => {
    const { room, store, failed } = setup();
    await vi.advanceTimersByTimeAsync(10);
    room.remotePatch([{ op: 'addNode', tempId: 'node_new', kind: 'text', title: 'Brief', params: {} }], 'agent');
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getState().nodes.find((n) => n.id === 'node_new')?.createdBy).toBe('agent');
    expect(store.buildIndex('node_new')).toBe(0);

    room.startJobs(['node_vid'], { fail: ['node_vid'] });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.status).toBe('generating');
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.status).toBe('failed');
    expect(failed).toEqual([['node_vid', 8]]);
  });

  it('a job that finishes sets done and bumps the version', async () => {
    const { room, store } = setup();
    await vi.advanceTimersByTimeAsync(10);
    room.startJobs(['node_img']);
    await vi.advanceTimersByTimeAsync(250);
    const img = store.getState().nodes.find((n) => n.id === 'node_img')!;
    expect(img.status).toBe('done');
    expect(img.version).toEqual({ n: 3, total: 3 });
  });

  it('undo goes out as a forward patch', async () => {
    const { room, sync } = setup();
    await vi.advanceTimersByTimeAsync(10);
    sync.commit([{ op: 'removeNode', nodeId: 'node_vid' }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(room.state.nodes).toHaveLength(1);
    sync.undo();
    await vi.advanceTimersByTimeAsync(20);
    expect(room.state.nodes.map((n) => n.id)).toContain('node_vid');
    expect(room.state.revision).toBe(9);
  });
});
