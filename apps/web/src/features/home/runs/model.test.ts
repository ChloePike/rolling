import { describe, expect, it } from 'vitest';
import type { RunView } from '@/features/overlays/runs';
import { applyProgress, applyRunView, cardErrorText, cardStatus, clock, isActive, MAX_CARDS, parseStored, remainingSeconds, upsertCard, type HomeRunCard } from './model';

const card = (over: Partial<HomeRunCard> = {}): HomeRunCard => ({
  key: 'k1',
  runId: 'run_1',
  kind: 'video',
  prompt: 'A lamp',
  title: 'A lamp',
  modelName: 'Seedance 2.0 Fast',
  meta: 'Seedance 2.0 Fast · 9:16 · 720p · 10s',
  aspect: '9/16',
  params: [],
  credits: 363,
  status: 'queued',
  progress: null,
  createdAt: 1000,
  finishedAt: null,
  assetIds: [],
  spent: 0,
  refunded: 0,
  error: null,
  retryable: false,
  ...over,
});

const view = (over: Partial<RunView> = {}): RunView => ({
  id: 'run_1',
  ref: 'R-1',
  name: 'A lamp',
  source: 'quickCreate',
  projectId: null,
  projectTitle: null,
  params: '',
  status: 'running',
  progress: 0.4,
  credits: 363,
  quoted: 363,
  spent: 0,
  refunded: 0,
  error: null,
  createdAt: 1000,
  finishedAt: null,
  items: [],
  ...over,
});

describe('home run cards', () => {
  it('maps server statuses (partial shows what it made)', () => {
    expect(cardStatus('queued')).toBe('queued');
    expect(cardStatus('running')).toBe('running');
    expect(cardStatus('partial')).toBe('done');
    expect(cardStatus('canceled')).toBe('canceled');
    expect(isActive({ status: 'starting' })).toBe(true);
    expect(isActive({ status: 'done' })).toBe(false);
  });

  it('D-020: a finished run shows the prompt the gateway rendered ("Enhanced prompt")', () => {
    const item = { ref: 'spec', nodeId: null, title: 'A lamp', kind: 'image', model: 'm', modelName: 'M', status: 'succeeded' as const, jobId: 'job_1', progress: 1, credits: 2, spent: 2, refunded: 0, assetId: 'ast_1', error: null, errorCode: null };
    const done = applyRunView(card(), view({ status: 'done', items: [{ ...item, promptExpand: true, expandedPrompt: 'A brass desk lamp, warm light' }] }));
    expect(done.expandedPrompt).toBe('A brass desk lamp, warm light');
    expect(applyRunView(card(), view({ status: 'done', items: [item] }))).not.toHaveProperty('expandedPrompt');
    // A chain: the animation's rewrite, not the first frame's.
    const chain = applyRunView(card(), view({ status: 'done', items: [{ ...item, ref: 'kf', step: 'keyframe', expandedPrompt: 'first frame' }, { ...item, ref: 'spec', step: 'animate', kind: 'video', expandedPrompt: 'second by second' }] }));
    expect(chain.expandedPrompt).toBe('second by second');
  });

  it('applies a run view: progress while running, assets and charge when done', () => {
    const running = applyRunView(card(), view());
    expect(running).toMatchObject({ status: 'running', progress: 0.4, credits: 363 });
    const done = applyRunView(
      running,
      view({ status: 'done', progress: null, spent: 363, finishedAt: 5000, items: [{ assetId: 'ast_1', status: 'succeeded' } as RunView['items'][number]] }),
    );
    expect(done).toMatchObject({ status: 'done', progress: 1, spent: 363, assetIds: ['ast_1'], finishedAt: 5000, error: null });
  });

  it('a failure keeps the item reason and the refund', () => {
    const failed = applyRunView(
      card(),
      view({ status: 'failed', refunded: 363, items: [{ assetId: null, status: 'failed', error: 'The provider timed out.' } as RunView['items'][number]], retryable: true }),
    );
    expect(failed).toMatchObject({ status: 'failed', refunded: 363, error: 'The provider timed out.', retryable: true, progress: null });
  });

  it('live progress only moves forward and only on active cards', () => {
    expect(applyProgress(card({ progress: 0.5, status: 'running' }), 0.3).progress).toBe(0.5);
    expect(applyProgress(card(), 0.3)).toMatchObject({ status: 'running', progress: 0.3 });
    expect(applyProgress(card(), 1).progress).toBe(0.99);
    const done = card({ status: 'done', progress: 1 });
    expect(applyProgress(done, 0.2)).toBe(done);
  });

  it('time left: extrapolates real progress, else the typical wait, else nothing', () => {
    expect(remainingSeconds({ kind: 'video', progress: 0.5, status: 'running' }, 30)).toBe(30);
    expect(remainingSeconds({ kind: 'video', progress: null, status: 'queued' }, 20)).toBe(100);
    expect(remainingSeconds({ kind: 'image', progress: null, status: 'queued' }, 25)).toBeNull();
    expect(remainingSeconds({ kind: 'video', progress: 0.5, status: 'done' }, 30)).toBeNull();
    expect(clock(0)).toBe('0:00');
    expect(clock(65.7)).toBe('1:05');
  });

  it('upsert keeps one card per key or run, newest first, capped', () => {
    let list: HomeRunCard[] = [];
    list = upsertCard(list, card({ key: 'a', runId: null }));
    list = upsertCard(list, card({ key: 'b', runId: 'run_b' }));
    expect(list.map((c) => c.key)).toEqual(['b', 'a']);
    list = upsertCard(list, card({ key: 'a', runId: 'run_a', status: 'running' }));
    expect(list.map((c) => [c.key, c.status])).toEqual([
      ['b', 'queued'],
      ['a', 'running'],
    ]);
    for (let i = 0; i < 20; i++) list = upsertCard(list, card({ key: `n${i}`, runId: `run_n${i}` }));
    expect(list).toHaveLength(MAX_CARDS);
    expect(list[0]!.key).toBe('n19');
  });

  it('stored cards: malformed and never-started ones are dropped', () => {
    expect(parseStored(null)).toEqual([]);
    expect(parseStored('{oops')).toEqual([]);
    expect(parseStored(JSON.stringify([card({ key: 'x', status: 'starting' }), { nope: 1 }, card({ key: 'y', status: 'done' })])).map((c) => c.key)).toEqual(['y']);
  });
});

describe('home run cards: mature text-to-video chain (D-005)', () => {
  const item = (over: Partial<RunView['items'][number]>): RunView['items'][number] => ({
    ref: 'spec',
    nodeId: null,
    title: 'A lamp',
    kind: 'video',
    model: 'lumina/wan2.2-i2v-spicy',
    modelName: 'Wan 2.2 I2V Spicy',
    status: 'pending',
    jobId: null,
    progress: null,
    credits: 100,
    spent: null,
    refunded: 0,
    assetId: null,
    error: null,
    errorCode: null,
    step: 'animate',
    ...over,
  });
  const keyframe = (over: Partial<RunView['items'][number]> = {}) => item({ ref: 'keyframe', kind: 'image', step: 'keyframe', title: 'A lamp · First frame', credits: 5, ...over });

  it('is one card that says which step runs', () => {
    const first = applyRunView(card(), view({ items: [keyframe({ status: 'running' }), item({})] }));
    expect(first.chain).toEqual({ step: 'keyframe', keyframeAssetId: null });
    const second = applyRunView(card(), view({ items: [keyframe({ status: 'succeeded', assetId: 'ast_kf' }), item({ status: 'running' })] }));
    expect(second.chain).toEqual({ step: 'animate', keyframeAssetId: 'ast_kf' });
    expect(second.assetIds).toEqual([]);
  });

  it('done: the video is the result, not the first frame', () => {
    const done = applyRunView(card(), view({ status: 'done', items: [keyframe({ status: 'succeeded', assetId: 'ast_kf' }), item({ status: 'succeeded', assetId: 'ast_vid' })] }));
    expect(done.status).toBe('done');
    expect(done.assetIds).toEqual(['ast_vid']);
    expect(done.chain?.step).toBeNull();
  });

  it('the animation failed: a failed card with the refund and the first frame kept', () => {
    const failed = applyRunView(
      card(),
      view({ status: 'partial', refunded: 100, items: [keyframe({ status: 'succeeded', assetId: 'ast_kf' }), item({ status: 'failed', error: 'The provider rejected the content.' })] }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('The provider rejected the content.');
    expect(failed.refunded).toBe(100);
    expect(failed.assetIds).toEqual([]);
    expect(failed.chain?.keyframeAssetId).toBe('ast_kf');
  });
});

describe('failed card text (no duplicate “No credits were charged”)', () => {
  it('drops the sentence the cost line already says', () => {
    expect(cardErrorText('Forced failure for testing. No credits were charged.')).toBe('Forced failure for testing.');
    expect(cardErrorText('The provider did not finish in time. No credits were charged.')).toBe('The provider did not finish in time.');
    expect(cardErrorText('The model timed out.')).toBe('The model timed out.');
    expect(cardErrorText('No credits were charged.')).toBe('');
    expect(cardErrorText(null)).toBe('');
  });
});
