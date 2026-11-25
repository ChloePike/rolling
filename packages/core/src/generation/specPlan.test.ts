import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { validateRequest } from '../models/capabilities';
import { buildGenerateRequest, type ResolvedInput } from './request';
import { PromptSpecSchema, specAssetIds } from './spec';
import { AVATAR_MODEL, planPromptSpec, remixShotTimes, type SpecAsset } from './specPlan';
import type { PlanContext, PlanItem } from './types';

const PLUS: PlanContext = { plan: 'plus', matureAllowed: false };
const MATURE: PlanContext = { plan: 'plus', matureAllowed: true };

const assets = new Map<string, SpecAsset>([
  ['ast_photo', { origin: 'upload', media: 'image' }],
  ['ast_gen', { origin: 'generated', media: 'image' }],
  ['ast_voice', { origin: 'upload', media: 'audio', durationSec: 6.2 }],
  ['ast_long', { origin: 'upload', media: 'audio', durationSec: 42 }],
  ['ast_clip', { origin: 'upload', media: 'video', durationSec: 12, poster: true }],
  ['ast_outfit', { origin: 'public', media: 'image' }],
  ['ast_frame', { origin: 'upload', media: 'image' }],
  ['ast_cuts', { origin: 'upload', media: 'video', durationSec: 12, poster: true, sceneCuts: [3.2, 7.9, 11.9] }],
]);

const spec = (raw: unknown) => PromptSpecSchema.parse(raw);

/** Builds the provider request for a planned item with fake signed URLs (item outputs resolve to a generated picture). */
function request(item: PlanItem) {
  const model = fixtureCatalog.get(item.model!)!;
  const resolved: ResolvedInput[] = item.spec!.inputs.map((input, i) => ({
    input,
    url: `https://media.test/${i}.${input.media === 'audio' ? 'mp3' : input.media === 'video' ? 'mp4' : 'png'}`,
    origin: 'assetId' in input.from ? input.from.origin : 'generated',
  }));
  const req = buildGenerateRequest(item.spec!, model, resolved);
  return { req, problems: validateRequest(model, req) };
}

describe('tool specs: avatar', () => {
  it('plans a lip-sync run on the D-009 model with the photo as first frame and the voice as audio_url', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'avatar', inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_voice' }, resolution: '720p' }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    const item = plan.items[0]!;
    expect(item).toMatchObject({ ref: 'avatar', action: 'run', kind: 'video', model: AVATAR_MODEL });
    // Seconds follow the voice track (6.2 s → 7 s).
    expect(item.spec).toMatchObject({ seconds: 7, audio: true, mode: 'i2v' });
    const { req, problems } = request(item);
    expect(problems).toEqual([]);
    expect(req).toMatchObject({ firstFrameUrl: 'https://media.test/0.png', audioUrl: 'https://media.test/1.mp3', audio: true });
    expect(req.referenceAudioUrls).toBeUndefined();
    expect(req.prompt.length).toBeGreaterThan(0);
  });

  it('clamps the length to the model range and requires an uploaded voice track', async () => {
    const long = await planPromptSpec({ spec: spec({ kind: 'avatar', inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_long' } }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(long.items[0]!.spec!.seconds).toBe(15);
    const none = await planPromptSpec({ spec: spec({ kind: 'avatar', inputs: { photoAssetId: 'ast_photo' } }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(none.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input', reason: 'Upload a voice track.' });
    const notAudio = await planPromptSpec({ spec: spec({ kind: 'avatar', inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_clip' } }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(notAudio.items[0]).toMatchObject({ action: 'blocked', code: 'unsupported' });
  });

  it('D-005: a mature avatar takes only platform pictures; a model without lip sync is refused', async () => {
    const upload = await planPromptSpec({ spec: spec({ kind: 'avatar', mature: true, inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(upload.items[0]).toMatchObject({ action: 'blocked', code: 'identity_requires_platform_assets' });
    const platform = await planPromptSpec({ spec: spec({ kind: 'avatar', mature: true, inputs: { photoAssetId: 'ast_gen', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(platform.items[0]).toMatchObject({ action: 'run', model: AVATAR_MODEL });
    expect(platform.items[0]!.spec!.mature).toBe(true);
    const notAllowed = await planPromptSpec({ spec: spec({ kind: 'avatar', mature: true, inputs: { photoAssetId: 'ast_gen', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(notAllowed.items[0]).toMatchObject({ action: 'blocked', code: 'mature_not_allowed' });
    const wrong = await planPromptSpec({ spec: spec({ kind: 'avatar', model: 'Seedance 2.5', inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(wrong.items[0]).toMatchObject({ action: 'blocked', code: 'unsupported' });
  });

  it('D-006: the resolution cap applies (1080p needs Plus)', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'avatar', resolution: '1080p', inputs: { photoAssetId: 'ast_photo', audioAssetId: 'ast_voice' } }),
      catalog: fixtureCatalog,
      ctx: { plan: 'starter', matureAllowed: false },
      assetOrigins: assets,
    });
    expect(plan.items[0]).toMatchObject({ action: 'blocked', code: 'resolution_locked', lowestPlan: 'plus' });
  });
});

describe('tool specs: remix', () => {
  it('plans one refs-mode video per shot with the reference video, the shot frame and the new looks', async () => {
    const plan = await planPromptSpec({
      spec: spec({
        kind: 'remix',
        prompt: 'Two friends in streetwear',
        resolution: '480p',
        ratio: '16:9',
        shots: [{ prompt: 'They walk in', seconds: 5, frameAssetId: 'ast_frame', startSec: 0 }, { prompt: 'They wave' }],
        inputs: { videoAssetId: 'ast_clip', referenceAssetIds: ['ast_outfit'] },
      }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    expect(plan.items.map((i) => i.ref)).toEqual(['shot-1', 'shot-2']);
    const [one, two] = plan.items as [PlanItem, PlanItem];
    expect(one).toMatchObject({ action: 'run', kind: 'video', title: 'Remix · Shot 1' });
    expect(one.spec).toMatchObject({ mode: 'refs', seconds: 5, inputVideoMs: 12_000 });
    // The second shot gets half of the 12 s clip.
    expect(two.spec!.seconds).toBe(6);
    expect(one.spec!.prompt).toContain('Shot 1 (from 0s in the reference video): They walk in');
    expect(one.priceRequest).toMatchObject({ referenceVideos: 1, inputVideoMs: 12_000 });
    const { req, problems } = request(one);
    expect(problems).toEqual([]);
    expect(req.referenceVideoUrls).toEqual(['https://media.test/0.mp4']);
    expect(req.referenceImageUrls).toEqual(['https://media.test/1.png', 'https://media.test/2.png']);
  });

  it('blocks without a reference video and plans only the retried shots', async () => {
    const none = await planPromptSpec({ spec: spec({ kind: 'remix', prompt: 'x' }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(none.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input' });
    const retry = await planPromptSpec({
      spec: spec({ kind: 'remix', shots: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], resolution: '480p', inputs: { videoAssetId: 'ast_clip' } }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
      onlyRefs: ['shot-2'],
    });
    expect(retry.items.map((i) => [i.ref, i.action])).toEqual([['shot-2', 'run']]);
  });

  it('gives shots without a frame picture their own frame of the reference video at the shot start', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'remix', resolution: '480p', shots: [{ prompt: 'a', frameAssetId: 'ast_frame' }, { prompt: 'b' }, { prompt: 'c', startSec: 9 }], inputs: { videoAssetId: 'ast_clip' } }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    const [one, two, three] = plan.items as [PlanItem, PlanItem, PlanItem];
    expect(one.spec!.inputs.map((i) => i.from)).toEqual([
      { assetId: 'ast_clip', origin: 'upload' },
      { assetId: 'ast_frame', origin: 'upload' },
    ]);
    // A user-set start on one shot: the others without one have no known start, so their frame is the clip's first one.
    expect(two.spec!.inputs[1]!.from).toEqual({ assetId: 'ast_clip', origin: 'upload', frameAt: 0, poster: true, optional: true });
    expect(three.spec!.inputs[1]!.from).toMatchObject({ assetId: 'ast_clip', frameAt: 9, optional: true });
    expect(three.spec!.prompt).toContain('Shot 3 (from 9s in the reference video): c');
    const { req, problems } = request(three);
    expect(problems).toEqual([]);
    expect(req.referenceImageUrls).toEqual(['https://media.test/1.png']);
  });

  it('uses detected scene cuts as shot boundaries when the user set none', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'remix', resolution: '480p', shots: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], inputs: { videoAssetId: 'ast_cuts' } }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    expect(plan.items.map((i) => (i.spec!.inputs[1]!.from as { frameAt?: number }).frameAt)).toEqual([0, 3.2, 7.9]);
    expect(plan.items.map((i) => i.spec!.seconds)).toEqual([3, 5, 4]);
    expect(plan.items[1]!.spec!.prompt).toContain('Shot 2 (from 3.2s in the reference video): b');
  });

  it('remixShotTimes: user starts win, then scene cuts, then an even split', () => {
    expect(remixShotTimes([{}, {}], 10)).toEqual([
      { start: 0, length: 5, via: 'even' },
      { start: 5, length: 5, via: 'even' },
    ]);
    expect(remixShotTimes([{}, {}, {}], 12, [0.2, 4, 4.1, 8])).toEqual([
      { start: 0, length: 4, via: 'scene' },
      { start: 4, length: 4, via: 'scene' },
      { start: 8, length: 4, via: 'scene' },
    ]);
    // Too few cuts: even split.
    expect(remixShotTimes([{}, {}, {}], 9, [4]).map((t) => t.start)).toEqual([0, 3, 6]);
    expect(remixShotTimes([{ startSec: 2 }, {}], 10)).toEqual([{ start: 2, length: 8, via: 'user' }, {}]);
    expect(remixShotTimes([{}], undefined)).toEqual([{ start: 0, via: 'even' }]);
  });

  it('uses the poster frame when the chosen model takes no reference video', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'remix', model: 'x-ai/grok-imagine-video-1.5', resolution: '480p', inputs: { videoAssetId: 'ast_clip' } }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    const item = plan.items[0]!;
    expect(item.action).toBe('run');
    expect(item.spec!.inputs[0]).toMatchObject({ media: 'image', from: { assetId: 'ast_clip', poster: true } });
  });
});

describe('tool specs: character', () => {
  it('makes the full body first, then the face from it, with the reference pictures', async () => {
    const plan = await planPromptSpec({
      spec: spec({ kind: 'character', name: 'Mira', prompt: 'A cyclist in a yellow jacket', resolution: '2K', inputs: { referenceAssetIds: ['ast_photo'] } }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
    });
    const [body, face] = plan.items as [PlanItem, PlanItem];
    expect(body).toMatchObject({ ref: 'body', action: 'run', kind: 'image', title: 'Mira · Full body', dependsOn: [] });
    expect(face).toMatchObject({ ref: 'face', action: 'run', kind: 'image', title: 'Mira · Face', dependsOn: ['body'] });
    expect(body.spec).toMatchObject({ mode: 'edit', ratio: '3:4' });
    expect(face.spec!.inputs[0]).toEqual({ role: 'edit', media: 'image', from: { item: 'body' } });
    expect(face.spec!.prompt).toContain('Mira.');
    const { problems } = request(face);
    expect(problems).toEqual([]);
  });

  it('text-only characters generate, and a retry of the face uses the earlier body picture', async () => {
    const t2i = await planPromptSpec({ spec: spec({ kind: 'character', prompt: 'An old sailor' }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(t2i.items[0]!.spec!.mode).toBe('t2i');
    const retry = await planPromptSpec({
      spec: spec({ kind: 'character', prompt: 'An old sailor' }),
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: assets,
      onlyRefs: ['face'],
      priorAssets: { body: 'ast_body1' },
    });
    expect(retry.items).toHaveLength(1);
    expect(retry.items[0]!.spec!.inputs[0]).toEqual({ role: 'edit', media: 'image', from: { assetId: 'ast_body1', origin: 'generated' } });
    const empty = await planPromptSpec({ spec: spec({ kind: 'character' }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets });
    expect(empty.items[0]).toMatchObject({ action: 'blocked', code: 'empty_prompt' });
  });
});

describe('specAssetIds', () => {
  it('collects every input and shot frame once', () => {
    expect(
      specAssetIds(spec({ kind: 'remix', shots: [{ frameAssetId: 'a' }, { frameAssetId: 'b' }], inputs: { videoAssetId: 'v', referenceAssetIds: ['a', 'c'], photoAssetId: 'p', audioAssetId: 'au' } })).sort(),
    ).toEqual(['a', 'au', 'b', 'c', 'p', 'v']);
  });
});
