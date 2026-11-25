import { describe, expect, it } from 'vitest';
import { pollUntilDone } from '../../../poll';
import { createHyperouterGenerationProvider } from '../provider';
import { errorJson, json, mockFetch, redirect } from './mock-fetch';

const base = { id: 'vid_1', object: 'video', model: 'bytedance/seedance-2.0-mini', seconds: '5', size: '', error: null };

describe('Hyperouter video provider', () => {
  it('goes queued → in_progress → completed and returns signed content URLs', async () => {
    const { client, calls, remaining } = mockFetch([
      json({ ...base, status: 'queued', progress: 0, usage: null }),
      json({ ...base, status: 'queued', progress: 0, usage: null }),
      json({ ...base, status: 'in_progress', progress: 42, usage: null }),
      json({ ...base, status: 'completed', progress: 100, usage: { cost: 0.17577, seconds: 5 } }),
      redirect('https://media.example/v.mp4?sig=1'),
      redirect('https://media.example/v.jpg?sig=1'),
    ]);
    const provider = createHyperouterGenerationProvider('seedance-2.0-mini', client);
    const { externalId } = await provider.submit(
      { kind: 'video', mode: 't2v', prompt: 'A paper boat on a river', seconds: 5, resolution: '480p', ratio: '16:9', audio: false },
      'job_vid',
    );
    expect(externalId).toBe('vid_1');
    expect(calls[0]!.url).toBe('https://api.hyperouter.app/v1/videos');
    expect(calls[0]!.headers['idempotency-key']).toBe('job_vid');
    expect(calls[0]!.body).toEqual({
      model: 'bytedance/seedance-2.0-mini',
      prompt: 'A paper boat on a river',
      seconds: 5,
      resolution: '480p',
      ratio: '16:9',
      audio: false,
      moderation: 'auto',
    });

    const seen: string[] = [];
    const final = await pollUntilDone(provider, externalId, {
      intervalMs: 1,
      sleep: async () => undefined,
      onStatus: (s) => seen.push(`${s.state}:${s.progress}`),
    });
    expect(seen).toEqual(['queued:0', 'running:42', 'succeeded:100']);
    expect(final.costUsd).toBe(0.17577);
    expect(final.outputs).toEqual([
      { kind: 'video', url: 'https://media.example/v.mp4?sig=1', expiresAt: 1_760_000_000_000 + 15 * 60 * 1000 },
      { kind: 'thumbnail', url: 'https://media.example/v.jpg?sig=1', expiresAt: 1_760_000_000_000 + 15 * 60 * 1000 },
    ]);
    expect(calls[4]!.url).toBe('https://api.hyperouter.app/v1/videos/vid_1/content?variant=video');
    expect(calls[4]!.redirect).toBe('manual');
    expect(remaining()).toBe(0);
  });

  it('keeps polling when completed but content is not served yet (404)', async () => {
    const { client } = mockFetch([
      json({ ...base, status: 'completed', progress: 100, usage: { cost: 0.1, seconds: 5 } }),
      errorJson(404, { code: 'not_found' }),
    ]);
    const status = await createHyperouterGenerationProvider('seedance-2.0-mini', client).status('vid_1');
    expect(status.state).toBe('running');
    expect(status.outputs).toEqual([]);
  });

  it('works without a thumbnail', async () => {
    const { client } = mockFetch([
      json({ ...base, status: 'completed', progress: 100, usage: { cost: 0.1, seconds: 5 } }),
      redirect('https://media.example/v.mp4'),
      errorJson(404, { code: 'not_found' }),
    ]);
    const status = await createHyperouterGenerationProvider('seedance-2.0-mini', client).status('vid_1');
    expect(status.state).toBe('succeeded');
    expect(status.outputs.map((o) => o.kind)).toEqual(['video']);
  });

  it('maps a failed video to a refundable, non-retryable error', async () => {
    const { client } = mockFetch([
      json({
        ...base,
        status: 'failed',
        progress: 0,
        usage: null,
        error: { code: 'content_rejected', message: 'The request was rejected by a content safety filter.' },
      }),
    ]);
    const status = await createHyperouterGenerationProvider('seedance-2.0-mini', client).status('vid_1');
    expect(status).toMatchObject({
      state: 'failed',
      costUsd: null,
      outputs: [],
      error: { code: 'content_rejected', retryable: false, refundable: true },
    });
  });

  it('marks an upstream failure as retryable and refundable', async () => {
    const { client } = mockFetch([
      json({ ...base, status: 'failed', progress: 10, usage: null, error: { code: 'upstream_error', message: 'Provider: boom' } }),
    ]);
    const status = await createHyperouterGenerationProvider('seedance-2.0-mini', client).status('vid_1');
    expect(status.error).toMatchObject({ code: 'upstream_error', retryable: true, refundable: true });
  });

  it('maps keyframes and references', async () => {
    const { client, calls } = mockFetch([json({ ...base, status: 'queued' }), json({ ...base, id: 'vid_2', status: 'queued' })]);
    const provider = createHyperouterGenerationProvider('seedance-2.5', client);
    await provider.submit(
      {
        kind: 'video',
        mode: 'first_last_frame',
        prompt: 'p',
        firstFrameUrl: 'https://x.example/a.png',
        lastFrameUrl: 'https://x.example/b.png',
      },
      'job_a',
    );
    await provider.submit(
      { kind: 'video', mode: 'refs', prompt: 'p', referenceImageUrls: ['https://x.example/r.png'], referenceVideoUrls: ['https://x.example/r.mp4'] },
      'job_b',
    );
    expect(calls[0]!.body).toMatchObject({ first_frame: 'https://x.example/a.png', last_frame: 'https://x.example/b.png' });
    expect(calls[1]!.body).toMatchObject({ reference_images: ['https://x.example/r.png'], reference_videos: ['https://x.example/r.mp4'] });
  });

  it('refuses keyframes combined with reference media and out-of-range seconds', async () => {
    const { client, calls } = mockFetch([]);
    const provider = createHyperouterGenerationProvider('seedance-2.5', client);
    await expect(
      provider.submit(
        { kind: 'video', mode: 'i2v', prompt: 'p', firstFrameUrl: 'https://x/a.png', referenceImageUrls: ['https://x/r.png'] },
        'job_c',
      ),
    ).rejects.toThrow(/keyframes/);
    await expect(provider.submit({ kind: 'video', mode: 't2v', prompt: 'p', seconds: 30 }, 'job_d')).rejects.toThrow(/seconds/);
    expect(calls).toHaveLength(0);
  });
});
