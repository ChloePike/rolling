import { describe, expect, it } from 'vitest';
import { fixtureModel } from '../../../__fixtures__/catalog';
import { InvalidGenerateRequestError } from '../../../errors';
import { MatureRoutingError } from '../../../capabilities';
import { createHyperouterGenerationProvider } from '../provider';
import { errorJson, json, mockFetch } from './mock-fetch';
import { generationToJobStatus, type HyperouterGeneration } from '../image';

describe('Hyperouter image provider', () => {
  it('reports no made-up progress while a generation runs (0 = none reported, docs/ux-audit.md #29)', () => {
    const running = generationToJobStatus({ id: 'gen_1', kind: 'image', status: 'running', usage: { cost: 0 }, error: null, outputs: [] } as HyperouterGeneration);
    expect(running).toMatchObject({ state: 'running', progress: 0 });
  });

  it('creates async (Prefer: respond-async) and polls the generation to done', async () => {
    const { client, calls } = mockFetch([
      json({ id: 'gen_1', status: 'queued' }, 202, { 'preference-applied': 'respond-async' }),
      json({ data: { id: 'gen_1', kind: 'image', status: 'queued', usage: { cost: 0 }, error: null, outputs: [] } }),
      json({ data: { id: 'gen_1', kind: 'image', status: 'running', usage: { cost: 0 }, error: null, outputs: [] } }),
      json({
        data: {
          id: 'gen_1',
          kind: 'image',
          status: 'done',
          usage: { cost: 0.035 },
          error: null,
          outputs: [{ url: 'https://cdn.example/img.png', expires_at: '2026-11-26T08:00:00Z' }],
        },
      }),
    ]);
    const provider = createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-lite'), client);
    const { externalId } = await provider.submit({ kind: 'image', mode: 't2i', prompt: 'A red bicycle' }, 'job_img');
    expect(externalId).toBe('gen_1');

    const req = calls[0]!;
    expect(req.url).toBe('https://api.hyperouter.app/v1/images/generations');
    expect(req.method).toBe('POST');
    expect(req.headers.prefer).toBe('respond-async');
    expect(req.headers['idempotency-key']).toBe('job_img');
    expect(req.body).toEqual({ model: 'bytedance/seedream-5.0-lite', prompt: 'A red bicycle', moderation: 'auto' });

    expect((await provider.status('gen_1')).state).toBe('queued');
    const running = await provider.status('gen_1');
    expect(running.state).toBe('running');
    const done = await provider.status('gen_1');
    expect(done).toMatchObject({
      state: 'succeeded',
      progress: 100,
      costUsd: 0.035,
      error: null,
      outputs: [{ kind: 'image', url: 'https://cdn.example/img.png', expiresAt: Date.parse('2026-11-26T08:00:00Z') }],
    });
    expect(calls[1]!.url).toBe('https://api.hyperouter.app/v1/generations/gen_1');
  });

  it('serves a synchronous 200 answer without polling', async () => {
    const { client, calls } = mockFetch([
      json({ id: 'gen_2', created: 1, data: [{ url: 'https://cdn.example/a.png' }], usage: { cost: 0.018 } }),
    ]);
    const provider = createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-flash'), client);
    const { externalId } = await provider.submit({ kind: 'image', mode: 't2i', prompt: 'x' }, 'job_sync');
    const status = await provider.status(externalId);
    expect(status.state).toBe('succeeded');
    expect(status.outputs[0]!.url).toBe('https://cdn.example/a.png');
    expect(calls).toHaveLength(1);
  });

  it('sends edits to /v1/images/edits with images', async () => {
    const { client, calls } = mockFetch([json({ id: 'gen_3', status: 'queued' }, 202)]);
    const provider = createHyperouterGenerationProvider(fixtureModel('qwen/qwen-image-2.0'), client);
    await provider.submit(
      { kind: 'image', mode: 'edit', prompt: 'make it night', inputImageUrls: ['https://x.example/p.png'], seed: 4 },
      'job_edit',
    );
    expect(calls[0]!.url).toBe('https://api.hyperouter.app/v1/images/edits');
    expect(calls[0]!.body).toMatchObject({ images: [{ image_url: 'https://x.example/p.png' }], seed: 4 });
  });

  it('maps a failed generation to a refundable job error', async () => {
    const { client } = mockFetch([
      json({
        data: {
          id: 'gen_4',
          kind: 'image',
          status: 'failed',
          usage: { cost: 0 },
          error: { code: 'content_rejected', message: 'Rejected by a content safety filter.' },
          outputs: [],
        },
      }),
    ]);
    const status = await createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-lite'), client).status('gen_4');
    expect(status.state).toBe('failed');
    expect(status.error).toEqual({
      code: 'content_rejected',
      message: 'Rejected by a content safety filter.',
      retryable: false,
      refundable: true,
    });
  });

  it('refuses parameters the model does not take, before any call', async () => {
    const { client, calls } = mockFetch([]);
    const provider = createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-lite'), client);
    await expect(provider.submit({ kind: 'image', mode: 't2i', prompt: 'x', seed: 1 }, 'job_x')).rejects.toBeInstanceOf(
      InvalidGenerateRequestError,
    );
    expect(calls).toHaveLength(0);
  });

  it('never routes a mature run to a non-mature model', async () => {
    const { client, calls } = mockFetch([]);
    const provider = createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-lite'), client);
    await expect(
      provider.submit({ kind: 'image', mode: 't2i', prompt: 'x', mature: true }, 'job_m'),
    ).rejects.toBeInstanceOf(InvalidGenerateRequestError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces 402 on create', async () => {
    const { client } = mockFetch([errorJson(402, { code: 'insufficient_credits' })]);
    const provider = createHyperouterGenerationProvider(fixtureModel('bytedance/seedream-5.0-lite'), client);
    await expect(provider.submit({ kind: 'image', mode: 't2i', prompt: 'x' }, 'job_402')).rejects.toMatchObject({
      code: 'insufficient_credits',
      retryable: false,
    });
  });

  it('exports MatureRoutingError for direct moderation checks', () => {
    expect(new MatureRoutingError('face-swap').message).toContain('face-swap');
  });
});
