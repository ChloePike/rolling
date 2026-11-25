import { describe, expect, it } from 'vitest';
import { HyperouterClient, HyperouterError, parseRetryAfter } from '../client';
import { createHyperouterGenerationProvider } from '../provider';
import { errorJson, json, mockFetch } from './mock-fetch';

const videoReq = { kind: 'video' as const, mode: 't2v' as const, prompt: 'A lighthouse at dusk', seconds: 5, resolution: '480p' };

async function submitExpectingError(responses: Response[]): Promise<{ err: HyperouterError; calls: ReturnType<typeof mockFetch>['calls'] }> {
  const { client, calls } = mockFetch(responses);
  const provider = createHyperouterGenerationProvider('seedance-2.0-mini', client);
  const err = await provider.submit(videoReq, 'job_01').then(
    () => {
      throw new Error('expected an error');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HyperouterError);
  return { err: err as HyperouterError, calls };
}

describe('HyperouterClient error mapping', () => {
  it('maps 402 insufficient_credits to a non-retryable error', async () => {
    const { err } = await submitExpectingError([
      errorJson(402, { code: 'insufficient_credits', type: 'insufficient_credits', message: 'Balance too low.' }),
    ]);
    expect(err.status).toBe(402);
    expect(err.code).toBe('insufficient_credits');
    expect(err.isInsufficientCredits).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it('maps 429 rate_limited with Retry-After seconds', async () => {
    const { err } = await submitExpectingError([
      errorJson(429, { code: 'rate_limited', type: 'rate_limit_error' }, { 'retry-after': '7' }),
    ]);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(7000);
  });

  it('defaults Retry-After on a 429 without the header', async () => {
    const { err } = await submitExpectingError([errorJson(429, { code: 'venue_busy' })]);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('honors x-should-retry: false on a 503', async () => {
    const { err } = await submitExpectingError([
      errorJson(503, { code: 'timeout', type: 'upstream_error', generation_id: 'gen_1' }, {
        'x-should-retry': 'false',
        'x-upstream-status': '504',
      }),
    ]);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(false);
    expect(err.shouldRetryHeader).toBe(false);
    expect(err.upstreamStatus).toBe(504);
    expect(err.generationId).toBe('gen_1');
  });

  it('treats a plain 503 upstream error as retryable', async () => {
    const { err } = await submitExpectingError([
      errorJson(503, { code: 'all_venues_failed' }, { 'x-upstream-status': '502' }),
    ]);
    expect(err.retryable).toBe(true);
    expect(err.upstreamStatus).toBe(502);
  });

  it('handles a non-JSON error page', async () => {
    const { err } = await submitExpectingError([new Response('<html>bad gateway</html>', { status: 500 })]);
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
  });

  it('marks content_rejected as final', async () => {
    const { err } = await submitExpectingError([errorJson(400, { code: 'content_rejected' })]);
    expect(err.isContentRejected).toBe(true);
    expect(err.retryable).toBe(false);
  });

  describe('idempotency 409s', () => {
    it('idempotency_key_reused is final', async () => {
      const { err } = await submitExpectingError([
        errorJson(409, { code: 'idempotency_key_reused', type: 'conflict' }, { 'x-should-retry': 'false' }),
      ]);
      expect(err.code).toBe('idempotency_key_reused');
      expect(err.retryable).toBe(false);
    });

    it('idempotency_key_in_use is retryable with the same key', async () => {
      const { err, calls } = await submitExpectingError([errorJson(409, { code: 'idempotency_key_in_use', type: 'conflict' })]);
      expect(err.retryable).toBe(true);
      expect(calls[0]?.headers['idempotency-key']).toBe('job_01');
    });

    it('idempotency_key_replayed carries the first generation id', async () => {
      const { err } = await submitExpectingError([
        errorJson(
          409,
          { code: 'idempotency_key_replayed', type: 'conflict', generation_id: '019a1f3c-5b7e' },
          { 'x-should-retry': 'false' },
        ),
      ]);
      expect(err.retryable).toBe(false);
      expect(err.generationId).toBe('019a1f3c-5b7e');
    });

    it('a repeat with the same key returns the first job', async () => {
      const video = { id: 'vid_1', status: 'queued', progress: 0 };
      const { client, calls } = mockFetch([json(video), json(video)]);
      const provider = createHyperouterGenerationProvider('seedance-2.0-mini', client);
      const a = await provider.submit(videoReq, 'job_same');
      const b = await provider.submit(videoReq, 'job_same');
      expect(a.externalId).toBe(b.externalId);
      expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['job_same', 'job_same']);
    });
  });

  it('wraps network failures as retryable', async () => {
    const failing = new HyperouterClient({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const err = await failing.json('/v1/models').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HyperouterError);
    expect((err as HyperouterError).code).toBe('network_error');
    expect((err as HyperouterError).retryable).toBe(true);
  });

  it('refuses a submit without an idempotency key', async () => {
    const { client, calls } = mockFetch([]);
    const provider = createHyperouterGenerationProvider('seedance-2.0-mini', client);
    await expect(provider.submit(videoReq, '')).rejects.toThrow(/idempotency key/);
    expect(calls).toHaveLength(0);
  });

  it('sends auth and idempotency headers', async () => {
    const { client, calls } = mockFetch([json({ id: 'vid_1', status: 'queued' })]);
    await createHyperouterGenerationProvider('seedance-2.0-mini', client).submit(videoReq, 'job_hdr');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-hr-v1-test');
    expect(calls[0]?.headers['idempotency-key']).toBe('job_hdr');
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
