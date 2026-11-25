import { describe, expect, it } from 'vitest';
import { GraphStore } from './store';
import { ProjectSync, type ForwardedMessage } from './sync';
import type { Transport } from './transport';

/** A transport the test drives by hand, like the real project channel. */
function fake() {
  const sent: Array<{ type: string; id: string; payload: unknown }> = [];
  let listener: ((raw: string) => void) | null = null;
  const transport: Transport = {
    send: (raw) => sent.push(JSON.parse(raw)),
    onMessage: (l) => {
      listener = l;
      return () => (listener = null);
    },
    close: () => {},
  };
  const push = (type: string, payload: unknown, id = `s_${Math.random()}`) => listener?.(JSON.stringify({ type, id, payload }));
  return { transport, sent, push };
}

const row = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  canvas_id: 'cnv_1',
  kind,
  title: id,
  params: '{}',
  x: 0,
  y: 0,
  group_id: null,
  active_version_id: null,
  status: 'idle',
  created_by: 'user',
  updated_at: 0,
  ...extra,
});

function setup() {
  const t = fake();
  const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
  const forwarded: ForwardedMessage[] = [];
  let hello: boolean | null = null;
  const sync = new ProjectSync(store, t.transport, { onMessage: (m) => forwarded.push(m), onHello: (h) => (hello = h.canEdit) });
  t.push('snapshot', {
    projectId: 'prj_1',
    revision: 3,
    canvases: [{ id: 'cnv_1', title: 'Main', viewport: null }],
    nodes: [row('node_img', 'image', { status: 'done', version_n: 1, version_total: 1, asset_id: 'ast_1', active_version_id: 'ver_1', version_rating: 'suggestive' }), row('node_vid', 'video')],
    edges: [],
    groups: [],
  });
  return { ...t, store, sync, forwarded, hello: () => hello };
}

describe('ProjectSync on the real ProjectRoom protocol', () => {
  it('reads result assets and ratings from the snapshot', () => {
    const { sync, store } = setup();
    expect(store.getState().revision).toBe(3);
    expect(sync.getMedia('node_img')).toEqual({ assetId: 'ast_1', versionId: 'ver_1', rating: 'suggestive' });
    expect(sync.getMedia('node_vid')).toBeUndefined();
  });

  it('applies server statuses on ack and graph.patched', () => {
    const { sync, store, sent, push } = setup();
    sync.commit([{ op: 'updateNode', nodeId: 'node_img', params: { prompt: 'warmer' } }]);
    const patch = sent.at(-1)!;
    expect(patch).toMatchObject({ type: 'patch', payload: { baseRevision: 3 } });
    push('ack', { revision: 4, idMap: {}, statuses: { node_img: 'outdated', node_vid: 'idle' } }, patch.id);
    expect(store.getState().nodes.find((n) => n.id === 'node_img')!.status).toBe('outdated');
    push('graph.patched', { revision: 5, ops: [{ op: 'moveNode', nodeId: 'node_vid', position: { x: 10, y: 0 } }], actor: 'user', userId: 'u2', statuses: { node_img: 'done' } });
    expect(store.getState().revision).toBe(5);
    expect(store.getState().nodes.find((n) => n.id === 'node_img')!.status).toBe('done');
  });

  it('node.version updates the version, result asset, rating and statuses; null version resets the status', () => {
    const { sync, store, push } = setup();
    push('job.progress', { jobId: 'job_1', nodeId: 'node_vid', progress: 0, status: 'queued' });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.status).toBe('queued');
    push('job.progress', { jobId: 'job_1', nodeId: 'node_vid', progress: 0.5, status: 'generating' });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')).toMatchObject({ status: 'generating', progress: 0.5 });
    push('node.version', { nodeId: 'node_vid', version: { id: 'ver_9', n: 1, total: 1, assetId: 'ast_9', rating: 'safe', active: true, stale: false, createdAt: 1 }, statuses: { node_vid: 'done' } });
    expect(sync.getMedia('node_vid')).toEqual({ assetId: 'ast_9', versionId: 'ver_9', rating: 'safe' });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')).toMatchObject({ status: 'done', version: { n: 1, total: 1 } });
    push('job.progress', { jobId: 'job_2', nodeId: 'node_vid', progress: 0.2, status: 'generating' });
    push('node.version', { nodeId: 'node_vid', version: null, status: 'done', statuses: {}, reason: 'canceled' });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.status).toBe('done');
  });

  it('job.failed shows the refund', () => {
    const { store, push } = setup();
    push('job.failed', { jobId: 'job_1', nodeId: 'node_vid', refunded: 347, reason: 'The provider rejected the content.' });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')).toMatchObject({ status: 'failed', refunded: 347 });
  });

  it('forwards agent, proposal, timeline and unsolicited errors; read-only after hello canEdit=false', () => {
    const { sync, forwarded, push, hello } = setup();
    push('agent.delta', { threadId: 't', turnId: 'x', delta: 'hi' });
    push('timeline.patched', { canvasId: 'cnv_1', revision: 2, ops: [], actor: 'user', userId: 'u' });
    push('error', { code: 'PROJECT_DELETED', message: 'gone' });
    push('ack', { revision: 2, canvasId: 'cnv_1' }, 'timeline_req');
    expect(forwarded.map((m) => m.type)).toEqual(['agent.delta', 'timeline.patched', 'error', 'ack']);
    push('hello', { actor: 'u', canEdit: false });
    expect(hello()).toBe(false);
    const r = sync.commit([{ op: 'moveNode', nodeId: 'node_vid', position: { x: 1, y: 1 } }]);
    expect(r.ok).toBe(false);
  });

  it('keeps edits in flight across a reconnect snapshot', () => {
    const { sync, store, push } = setup();
    sync.setConnected(false);
    expect(sync.status).toBe('offline');
    sync.commit([{ op: 'moveNode', nodeId: 'node_vid', position: { x: 50, y: 0 } }]);
    push('snapshot', { projectId: 'prj_1', revision: 3, canvases: [], nodes: [row('node_img', 'image'), row('node_vid', 'video')], edges: [], groups: [] });
    expect(store.getState().nodes.find((n) => n.id === 'node_vid')!.position).toEqual({ x: 50, y: 0 });
    expect(sync.status).toBe('saving');
  });
});
