import { describe, expect, it } from 'vitest';
import { channelEnvelope, ClientMessageType, GatewayPatchPayload, parseEnvelope, ServerMessageType, SubscribePayload, TimelinePatchPayload } from './envelope';

describe('WS envelope (D-014 global socket)', () => {
  it('carries channel, projectId and seq on gateway messages', () => {
    const raw = channelEnvelope('graph.patched', { revision: 3 }, { channel: 'project', projectId: 'prj_1', seq: 7 }, 'm1');
    const parsed = parseEnvelope(raw);
    expect(parsed).toEqual({ ok: true, message: { type: 'graph.patched', id: 'm1', payload: { revision: 3 }, channel: 'project', projectId: 'prj_1', seq: 7 } });
    expect(JSON.parse(channelEnvelope('credits.changed', {}, { channel: 'user' }))).not.toHaveProperty('projectId');
    expect(parseEnvelope(JSON.stringify({ type: 'x', id: 'a', payload: null, channel: 'nope' })).ok).toBe(false);
  });

  it('validates the gateway client payloads', () => {
    expect(SubscribePayload.safeParse({ channel: 'project', projectId: 'prj_1', lastRevision: 4 }).success).toBe(true);
    expect(SubscribePayload.safeParse({ channel: 'user', projectId: 'prj_1' }).success).toBe(false);
    expect(GatewayPatchPayload.safeParse({ projectId: 'prj_1', baseRevision: 0, ops: [] }).success).toBe(true);
    expect(GatewayPatchPayload.safeParse({ baseRevision: 0, ops: [] }).success).toBe(false);
    expect(TimelinePatchPayload.safeParse({ canvasId: 'cnv_1', baseRevision: 1, ops: [] }).success).toBe(true);
    expect(ClientMessageType.options).toEqual(expect.arrayContaining(['subscribe', 'unsubscribe', 'patch', 'undo', 'redo', 'timeline.patch']));
    expect(ServerMessageType.options).toEqual(expect.arrayContaining(['subscribed', 'unsubscribed']));
  });
});
