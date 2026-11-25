import { describe, expect, it } from 'vitest';
import { handleHyperouterWebhook } from '../provider';
import { bytesToBase64, signWebhook, timingSafeEqual, verifyWebhook, WebhookVerificationError } from '../webhooks';
import { json, mockFetch, redirect } from './mock-fetch';

const SECRET = `whsec_${bytesToBase64(new TextEncoder().encode('test-secret-0123456789abcdef'))}`;
const OTHER_SECRET = `whsec_${bytesToBase64(new TextEncoder().encode('another-secret-xyz'))}`;
const NOW_MS = 1_761_300_000_000;
const TS = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({
  id: 'evt_1',
  object: 'event',
  type: 'video.completed',
  created_at: TS,
  data: { id: 'vid_1' },
});

async function headersFor(body: string, opts: { id?: string; ts?: number; secret?: string; signature?: string } = {}) {
  const id = opts.id ?? 'msg_1';
  const ts = opts.ts ?? TS;
  return {
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': opts.signature ?? (await signWebhook(opts.secret ?? SECRET, id, ts, body)),
  };
}

async function reason(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WebhookVerificationError);
  return (err as WebhookVerificationError).reason;
}

describe('verifyWebhook (Standard Webhooks)', () => {
  it('accepts a valid signature', async () => {
    const res = await verifyWebhook({ body: BODY, headers: await headersFor(BODY), secret: SECRET, now: NOW_MS });
    expect(res.webhookId).toBe('msg_1');
    expect(res.event.type).toBe('video.completed');
    expect(res.event.data.id).toBe('vid_1');
  });

  it('accepts a secret without the whsec_ prefix and a Headers object', async () => {
    const h = new Headers(await headersFor(BODY));
    const res = await verifyWebhook({ body: BODY, headers: h, secret: SECRET.slice(6), now: NOW_MS });
    expect(res.event.id).toBe('evt_1');
  });

  it('rejects a bad signature', async () => {
    const headers = await headersFor(BODY, { secret: OTHER_SECRET });
    expect(await reason(verifyWebhook({ body: BODY, headers, secret: SECRET, now: NOW_MS }))).toBe('no_valid_signature');
  });

  it('rejects a tampered body', async () => {
    const headers = await headersFor(BODY);
    const tampered = BODY.replace('vid_1', 'vid_2');
    expect(await reason(verifyWebhook({ body: tampered, headers, secret: SECRET, now: NOW_MS }))).toBe('no_valid_signature');
  });

  it('rejects a stale timestamp (older than 5 minutes) and one too far ahead', async () => {
    const old = await headersFor(BODY, { ts: TS - 301 });
    expect(await reason(verifyWebhook({ body: BODY, headers: old, secret: SECRET, now: NOW_MS }))).toBe('stale_timestamp');
    const future = await headersFor(BODY, { ts: TS + 301 });
    expect(await reason(verifyWebhook({ body: BODY, headers: future, secret: SECRET, now: NOW_MS }))).toBe('stale_timestamp');
    const edge = await headersFor(BODY, { ts: TS - 300 });
    await expect(verifyWebhook({ body: BODY, headers: edge, secret: SECRET, now: NOW_MS })).resolves.toBeTruthy();
  });

  it('accepts a multi-signature header when any v1 signature matches', async () => {
    const good = await signWebhook(SECRET, 'msg_1', TS, BODY);
    const bad = await signWebhook(OTHER_SECRET, 'msg_1', TS, BODY);
    const signature = `v2,abc ${bad} v1,!!notbase64 ${good}`;
    const res = await verifyWebhook({ body: BODY, headers: await headersFor(BODY, { signature }), secret: SECRET, now: NOW_MS });
    expect(res.webhookId).toBe('msg_1');
    const onlyBad = `${bad} v1,${good.slice(3, 10)}`;
    expect(
      await reason(verifyWebhook({ body: BODY, headers: await headersFor(BODY, { signature: onlyBad }), secret: SECRET, now: NOW_MS })),
    ).toBe('no_valid_signature');
  });

  it('rejects missing headers, malformed timestamp, malformed secret and malformed payload', async () => {
    expect(await reason(verifyWebhook({ body: BODY, headers: {}, secret: SECRET, now: NOW_MS }))).toBe('missing_headers');
    const h = await headersFor(BODY);
    expect(
      await reason(verifyWebhook({ body: BODY, headers: { ...h, 'webhook-timestamp': '12abc' }, secret: SECRET, now: NOW_MS })),
    ).toBe('invalid_timestamp');
    expect(await reason(verifyWebhook({ body: BODY, headers: h, secret: 'whsec_%%%', now: NOW_MS }))).toBe('invalid_secret');
    const notJson = 'not json';
    expect(
      await reason(verifyWebhook({ body: notJson, headers: await headersFor(notJson), secret: SECRET, now: NOW_MS })),
    ).toBe('malformed_payload');
    const noData = JSON.stringify({ id: 'evt', type: 'video.completed' });
    expect(
      await reason(verifyWebhook({ body: noData, headers: await headersFor(noData), secret: SECRET, now: NOW_MS })),
    ).toBe('malformed_payload');
    expect(
      await reason(verifyWebhook({ body: BODY, headers: { ...h, 'webhook-signature': 'garbage' }, secret: SECRET, now: NOW_MS })),
    ).toBe('no_valid_signature');
  });

  it('gives the same webhook id on a redelivery so callers can dedupe', async () => {
    const seen = new Set<string>();
    let processed = 0;
    for (let i = 0; i < 2; i++) {
      const res = await verifyWebhook({ body: BODY, headers: await headersFor(BODY), secret: SECRET, now: NOW_MS });
      if (seen.has(res.webhookId)) continue;
      seen.add(res.webhookId);
      processed++;
    }
    expect(processed).toBe(1);
  });

  it('timingSafeEqual compares content and length', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
  });
});

describe('handleHyperouterWebhook', () => {
  it('verifies, then fetches the video it names', async () => {
    const { client, calls } = mockFetch([
      json({ id: 'vid_1', status: 'completed', progress: 100, usage: { cost: 0.2, seconds: 5 }, error: null }),
      redirect('https://media.example/v.mp4'),
      redirect('https://media.example/v.jpg'),
    ]);
    const req = new Request('https://app.example/api/hooks/hyperouter', {
      method: 'POST',
      body: BODY,
      headers: await headersFor(BODY),
    });
    const res = await handleHyperouterWebhook(req, client, SECRET, { now: NOW_MS });
    expect(res).toMatchObject({ eventId: 'msg_1', eventType: 'video.completed', externalId: 'vid_1', status: { state: 'succeeded' } });
    expect(calls[0]!.url).toBe('https://api.hyperouter.app/v1/videos/vid_1');
  });

  it('returns no status for webhook.test', async () => {
    const body = JSON.stringify({ id: 'evt_t', object: 'event', type: 'webhook.test', data: { id: 'we_1' } });
    const { client, calls } = mockFetch([]);
    const req = new Request('https://app.example/h', { method: 'POST', body, headers: await headersFor(body) });
    const res = await handleHyperouterWebhook(req, client, SECRET, { now: NOW_MS });
    expect(res).toMatchObject({ eventType: 'webhook.test', status: null });
    expect(calls).toHaveLength(0);
  });

  it('throws on a bad signature without calling the API', async () => {
    const { client, calls } = mockFetch([]);
    const req = new Request('https://app.example/h', {
      method: 'POST',
      body: BODY,
      headers: await headersFor(BODY, { secret: OTHER_SECRET }),
    });
    await expect(handleHyperouterWebhook(req, client, SECRET, { now: NOW_MS })).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(calls).toHaveLength(0);
  });
});
