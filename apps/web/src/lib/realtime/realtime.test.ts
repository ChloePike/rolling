import { describe, expect, it } from 'vitest';
import { backoffDelay, Connection } from './connection';
import { RealtimeHub } from './hub';
import type { HubMessage } from './protocol';

/** Minimal WebSocket double: records sends, lets the test open/close/push. */
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  envelopes() {
    return this.sent.filter((s) => s !== 'ping').map((s) => JSON.parse(s) as { type: string; id: string; payload: Record<string, unknown> });
  }
}

function setup() {
  FakeWS.all = [];
  const conn = new Connection({ url: () => 'ws://test/api/ws', WebSocketImpl: FakeWS as unknown as typeof WebSocket, baseDelayMs: 1, maxDelayMs: 2, pingEveryMs: 1e9 });
  const hub = new RealtimeHub({ connection: conn });
  const tab = () => {
    const got: HubMessage[] = [];
    const handle = hub.connect({ postMessage: (m) => got.push(m) });
    return { got, handle, msgs: () => got.filter((m): m is Extract<HubMessage, { t: 'msg' }> => m.t === 'msg') };
  };
  return { conn, hub, tab, ws: () => FakeWS.all[FakeWS.all.length - 1]! };
}

describe('realtime', () => {
  it('backoff is exponential with equal jitter and a cap', () => {
    expect(backoffDelay(1, 500, 30_000, () => 0)).toBe(250);
    expect(backoffDelay(1, 500, 30_000, () => 1)).toBe(500);
    expect(backoffDelay(4, 500, 30_000, () => 1)).toBe(4000);
    expect(backoffDelay(20, 500, 30_000, () => 1)).toBe(30_000);
  });

  it('one socket for every tab; user messages go to every tab', () => {
    const { tab, ws } = setup();
    const a = tab();
    const b = tab();
    a.handle({ t: 'start' });
    b.handle({ t: 'start' });
    expect(FakeWS.all).toHaveLength(1);
    ws().open();
    ws().push({ type: 'credits.changed', id: 'x1', payload: { balance: 10, held: 0 } });
    expect(a.msgs().map((m) => m.type)).toEqual(['credits.changed']);
    expect(b.msgs().map((m) => m.channel)).toEqual(['user']);
  });

  it('project subscriptions are ref-counted across tabs and routed to subscribers only', () => {
    const { tab, ws } = setup();
    const a = tab();
    const b = tab();
    const c = tab();
    a.handle({ t: 'start' });
    ws().open();
    a.handle({ t: 'subscribe', sub: 'sa', projectId: 'prj_1', lastRevision: 4, req: 'ra' });
    b.handle({ t: 'subscribe', sub: 'sb', projectId: 'prj_1', req: 'rb' });
    const subs = ws().envelopes().filter((e) => e.type === 'subscribe');
    expect(subs.map((e) => [e.id, e.payload])).toEqual([
      ['ra', { channel: 'project', projectId: 'prj_1', lastRevision: 4 }],
      ['rb', { channel: 'project', projectId: 'prj_1' }],
    ]);
    // The answer to b's subscribe goes to b only.
    ws().push({ type: 'subscribed', id: 'rb', channel: 'project', projectId: 'prj_1', payload: { projectId: 'prj_1', snapshot: { revision: 7 } } });
    expect(b.msgs().map((m) => m.type)).toEqual(['subscribed']);
    expect(a.msgs()).toHaveLength(0);
    // Broadcasts reach both subscribers, never the third tab.
    ws().push({ type: 'graph.patched', id: 'g1', channel: 'project', projectId: 'prj_1', payload: { revision: 8, ops: [], actor: 'u' } });
    expect(a.msgs().map((m) => m.subs)).toEqual([['sa']]);
    expect(b.msgs().at(-1)!.type).toBe('graph.patched');
    expect(c.msgs()).toHaveLength(0);
    // Leaving: unsubscribe only after the last tab.
    a.handle({ t: 'unsubscribe', sub: 'sa' });
    expect(ws().envelopes().some((e) => e.type === 'unsubscribe')).toBe(false);
    b.handle({ t: 'unsubscribe', sub: 'sb' });
    expect(ws().envelopes().filter((e) => e.type === 'unsubscribe').map((e) => e.payload)).toEqual([{ projectId: 'prj_1' }]);
  });

  it('acks and conflicts go back to the sending tab by message id', () => {
    const { tab, ws } = setup();
    const a = tab();
    const b = tab();
    a.handle({ t: 'subscribe', sub: 'sa', projectId: 'prj_1', req: 'ra' });
    b.handle({ t: 'subscribe', sub: 'sb', projectId: 'prj_1', req: 'rb' });
    ws().open();
    b.handle({ t: 'send', type: 'patch', id: 'm1', sub: 'sb', payload: { projectId: 'prj_1', baseRevision: 3, ops: [] } });
    expect(ws().envelopes().at(-1)).toMatchObject({ type: 'patch', id: 'm1' });
    ws().push({ type: 'ack', id: 'srv1', channel: 'project', projectId: 'prj_1', payload: { id: 'm1', revision: 4 } });
    expect(b.msgs().map((m) => m.type)).toContain('ack');
    expect(a.msgs().map((m) => m.type)).not.toContain('ack');
  });

  it('the sender gets ack; sibling tabs on the same socket get a synthetic graph.patched', () => {
    const { tab, ws } = setup();
    const a = tab();
    const b = tab();
    a.handle({ t: 'start' });
    ws().open();
    a.handle({ t: 'subscribe', sub: 'sa', projectId: 'prj_1', req: 'ra' });
    b.handle({ t: 'subscribe', sub: 'sb', projectId: 'prj_1', req: 'rb' });
    const ops = [{ op: 'moveNode', nodeId: 'n1', x: 1, y: 2 }];
    a.handle({ t: 'send', type: 'patch', id: 'm1', sub: 'sa', payload: { projectId: 'prj_1', baseRevision: 3, ops } });
    ws().push({ type: 'ack', id: 'm1', channel: 'project', projectId: 'prj_1', payload: { revision: 4, idMap: {}, statuses: {} } });
    expect(a.msgs().map((m) => m.type)).toEqual(['ack']);
    expect(b.msgs().at(-1)).toMatchObject({ type: 'graph.patched', synthetic: true, subs: ['sb'], payload: { revision: 4, ops } });
    // Undo acks carry the ops they applied.
    a.handle({ t: 'send', type: 'undo', id: 'm2', sub: 'sa', payload: { projectId: 'prj_1' } });
    ws().push({ type: 'ack', id: 'm2', channel: 'project', projectId: 'prj_1', payload: { revision: 5, ops: [{ op: 'x' }], statuses: {} } });
    expect(b.msgs().at(-1)).toMatchObject({ type: 'graph.patched', payload: { revision: 5, ops: [{ op: 'x' }] } });
  });

  it('reconnects with backoff and re-subscribes with lastSeq and the lowest revision the tabs reported', async () => {
    const { tab, ws } = setup();
    const a = tab();
    const b = tab();
    a.handle({ t: 'start' });
    ws().open();
    a.handle({ t: 'subscribe', sub: 'sa', projectId: 'prj_1', lastRevision: 9, req: 'ra' });
    b.handle({ t: 'subscribe', sub: 'sb', projectId: 'prj_1', lastRevision: 5, req: 'rb' });
    a.handle({ t: 'revision', sub: 'sa', revision: 12 });
    ws().push({ type: 'job.done', id: 'j', channel: 'project', projectId: 'prj_1', seq: 41, payload: { jobId: 'j', nodeId: 'n' } });
    expect(a.msgs().at(-1)!.seq).toBe(41);
    const first = ws();
    first.drop(1006);
    expect(a.got.some((m) => m.t === 'event' && m.event === 'failure')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(ws()).not.toBe(first);
    ws().open();
    const re = ws().envelopes().filter((e) => e.type === 'subscribe');
    expect(re).toHaveLength(1);
    expect(re[0]!.payload).toEqual({ channel: 'project', projectId: 'prj_1', lastSeq: 41, lastRevision: 5 });
    // The catch-up answer goes to every subscriber.
    ws().push({ type: 'subscribed', id: re[0]!.id, channel: 'project', projectId: 'prj_1', payload: { projectId: 'prj_1', patches: [] } });
    expect(a.msgs().at(-1)!.type).toBe('subscribed');
    expect(b.msgs().at(-1)!.type).toBe('subscribed');
  });

  it('4401 stops reconnecting and tells every tab; 4402/4403/4404 close for good', async () => {
    const { tab, ws } = setup();
    const a = tab();
    a.handle({ t: 'start' });
    ws().open();
    ws().drop(4401);
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.all).toHaveLength(1);
    expect(a.got.some((m) => m.t === 'event' && m.event === 'unauthorized')).toBe(true);
    a.handle({ t: 'start', restart: true });
    expect(FakeWS.all).toHaveLength(2);
    ws().open();
    ws().drop(4403);
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.all).toHaveLength(2);
    expect(a.got.some((m) => m.t === 'event' && m.event === 'closed' && m.code === 4403)).toBe(true);
  });

  it('a send while disconnected is reported back as unsent', () => {
    const { tab } = setup();
    const a = tab();
    a.handle({ t: 'send', type: 'undo', id: 'm9', payload: {} });
    expect(a.got).toContainEqual({ t: 'unsent', id: 'm9' });
  });
});

describe('RealtimeClient over the hub', () => {
  it('subscribeProject: typed events, patch → ack / conflict, unsubscribe', async () => {
    const { RealtimeClient } = await import('./client');
    const { hub, ws } = setup();
    let deliver: ((m: HubMessage) => void) | null = null;
    let handle: ((m: import('./protocol').TabMessage) => void) | null = null;
    const client = new RealtimeClient({
      transport: () => {
        handle = hub.connect({ postMessage: (m) => queueMicrotask(() => deliver?.(m)) });
        return { mode: 'main', post: (m) => handle!(m), onMessage: (cb) => (deliver = cb), close: () => {} };
      },
    });
    const ch = client.subscribeProject('prj_1', { lastRevision: 2 });
    const seen: number[] = [];
    ch.on('graph.patched', (p) => seen.push(p.revision));
    ws().open();
    const sub = ws().envelopes().find((e) => e.type === 'subscribe')!;
    expect(sub.payload).toEqual({ channel: 'project', projectId: 'prj_1', lastRevision: 2 });
    ws().push({ type: 'graph.patched', id: 'g', channel: 'project', projectId: 'prj_1', payload: { revision: 3, ops: [], actor: 'x' } });
    await Promise.resolve();
    expect(seen).toEqual([3]);

    const p = ch.patch(3, []);
    const sent = ws().envelopes().at(-1)!;
    expect(sent).toMatchObject({ type: 'patch', payload: { projectId: 'prj_1', baseRevision: 3, ops: [] } });
    ws().push({ type: 'ack', id: sent.id, channel: 'project', projectId: 'prj_1', payload: { revision: 4 } });
    await expect(p).resolves.toEqual({ ok: true, revision: 4 });

    const q = ch.patch(1, []);
    const sent2 = ws().envelopes().at(-1)!;
    ws().push({ type: 'conflict', id: sent2.id, channel: 'project', projectId: 'prj_1', payload: { snapshot: { revision: 4 } } });
    await expect(q).resolves.toMatchObject({ ok: false, conflict: { revision: 4 } });

    const r = ch.undo();
    const sent3 = ws().envelopes().at(-1)!;
    ws().push({ type: 'error', id: sent3.id, channel: 'project', projectId: 'prj_1', payload: { code: 'NOTHING_TO_UNDO', message: 'x' } });
    await expect(r).resolves.toMatchObject({ type: 'error' });

    ch.unsubscribe();
    expect(ws().envelopes().at(-1)).toMatchObject({ type: 'unsubscribe', payload: { projectId: 'prj_1' } });
  });
});
