import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { Catalog } from '../models/catalog';
import { creditsFor, creditsForAll } from '../pricing/config';
import { moderationFor, validateRequest } from '../models/capabilities';
import { replanMature } from './plan';
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
    expect(upload.items[0]).toMatchObject({ action: 'blocked', code: 'mature_voice' });
    const platform = await planPromptSpec({ spec: spec({ kind: 'avatar', mature: true, inputs: { photoAssetId: 'ast_gen', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    // D-037: every voice today is an upload (no TTS yet), which may be a real person's: mature lip-sync is refused.
    expect(platform.items[0]).toMatchObject({ action: 'blocked', code: 'mature_voice' });
    const plain = await planPromptSpec({ spec: spec({ kind: 'avatar', inputs: { photoAssetId: 'ast_gen', audioAssetId: 'ast_voice' } }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(plain.items[0]).toMatchObject({ action: 'run', model: AVATAR_MODEL });
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

describe('D-005: explicit prompts of mature-allowed callers run mature automatically', () => {
  const EXPLICIT = 'nsfw scene between two consenting adults in a hotel room';

  it('Quick Create / Home (Auto, no toggle): the item is mature, on a mature-capable model, sent with moderation low', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    const item = plan.items[0]!;
    expect(item.action).toBe('run');
    expect(item.spec).toMatchObject({ mature: true, matureAuto: true, matureAccess: 'allowed' });
    const model = fixtureCatalog.get(item.model!)!;
    expect(model.matureRouting).toBe('allowed');
    const { req, problems } = request(item);
    expect(problems).toEqual([]);
    expect(req.mature).toBe(true);
    expect(moderationFor(model, req.mature, req)).toBe('low');
  });

  it('an explicitly chosen model that takes no mature runs falls back to a mature-capable one', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-lite', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    const item = plan.items[0]!;
    expect(item.action).toBe('run');
    expect(item.model).not.toBe('bytedance/seedream-5.0-lite');
    expect(fixtureCatalog.get(item.model!)!.matureRouting).toBe('allowed');
    expect(item.spec!.mature).toBe(true);
  });

  it('a text-only video no model takes as a mature run becomes the keyframe → animation chain (see the chain tests)', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'video', model: 'lumina/berry-1.0', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(plan.items.map((i) => [i.ref, i.action])).toEqual([
      ['keyframe', 'run'],
      ['spec', 'run'],
    ]);
  });

  it('a non-explicit prompt stays a normal run; callers without access keep the flag off with their access snapshot', async () => {
    const plain = await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: 'a bowl of ramen, studio light' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(plain.items[0]!.spec).toMatchObject({ mature: false, matureAccess: 'allowed' });
    expect(plain.items[0]!.spec!.matureAuto).toBeUndefined();
    const off = await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: { ...PLUS, matureAccess: 'preference_off' }, assetOrigins: assets });
    expect(off.items[0]!.spec).toMatchObject({ mature: false, matureAccess: 'preference_off' });
    const guest = await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: { plan: null, matureAllowed: false, matureAccess: 'no_plan' }, assetOrigins: assets });
    expect(guest.items[0]!.spec).toMatchObject({ mature: false, matureAccess: 'no_plan' });
  });

  it('replanMature (prepare): keeps a mature-capable model, else falls back within the hold, else fails', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-lite', prompt: 'two adults, adult category' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    const item = plan.items[0]!;
    expect(item.spec!.mature).toBe(false);
    const model = fixtureCatalog.get(item.model!)!;
    const moved = replanMature({ spec: item.spec!, model, catalog: fixtureCatalog, plan: 'plus', fits: () => true });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.spec).toMatchObject({ mature: true, matureAuto: true, matureAccess: 'allowed', modelId: moved.model.id });
      expect(moved.model.matureRouting).toBe('allowed');
      expect(moved.spec.fallbacks.every((id) => fixtureCatalog.get(id)!.matureRouting === 'allowed')).toBe(true);
    }
    const tooDear = replanMature({ spec: item.spec!, model, catalog: fixtureCatalog, plan: 'plus', fits: () => false });
    expect(tooDear).toMatchObject({ ok: false, code: 'no_capable_model' });
    const capable = fixtureCatalog.get('qwen/qwen-image-2.0')!;
    const kept = replanMature({ spec: { ...item.spec!, modelId: capable.id }, model: capable, catalog: fixtureCatalog, plan: 'plus', fits: () => true });
    expect(kept.ok && kept.model.id).toBe('qwen/qwen-image-2.0');
  });
});

describe('D-005: mature text-to-video as a keyframe → animation chain', () => {
  const EXPLICIT = 'nsfw scene between two consenting adults in a hotel room';
  const video = (extra: Record<string, unknown> = {}) => spec({ kind: 'video', model: 'auto', prompt: EXPLICIT, seconds: 5, resolution: '480p', ratio: '9:16', audio: true, ...extra });

  it('plans a mature keyframe at the video ratio, then the spicy image-to-video with it as the first frame; prices sum', async () => {
    const plan = await planPromptSpec({ spec: video(), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    const [kf, anim] = plan.items as [PlanItem, PlanItem];
    expect(plan.items).toHaveLength(2);
    expect(kf).toMatchObject({ ref: 'keyframe', kind: 'image', action: 'run', nodeId: null, dependsOn: [], title: 'Video · First frame' });
    expect(kf.spec).toMatchObject({ kind: 'image', mode: 't2i', mature: true, matureAuto: true, ratio: '9:16', resolution: '1K', inputs: [], chain: { step: 'keyframe', with: 'spec' } });
    expect(kf.spec!.prompt).toContain(EXPLICIT);
    // The cheapest mature text-to-image model.
    expect(kf.model).toBe('lumina/z-image-spicy');
    expect(kf.priceRequest).toMatchObject({ size: '768x1344' });

    expect(anim).toMatchObject({ ref: 'spec', kind: 'video', action: 'run', dependsOn: ['keyframe'], title: 'Video' });
    expect(anim.spec).toMatchObject({ mode: 'i2v', mature: true, seconds: 5, resolution: '480p', prompt: EXPLICIT, chain: { step: 'animate', with: 'keyframe' } });
    expect(anim.spec!.inputs).toEqual([{ role: 'frame', media: 'image', from: { item: 'keyframe' } }]);
    expect(anim.spec!.audio).toBeUndefined();
    expect(anim.model).toBe('lumina/wan2.2-i2v-spicy');

    // Both requests fit their models and go out with moderation low (the keyframe is a platform picture).
    for (const item of [kf, anim]) {
      const { req, problems } = request(item);
      expect(problems, item.ref).toEqual([]);
      expect(moderationFor(fixtureCatalog.get(item.model!)!, req.mature, req)).toBe('low');
    }
    // One price for the run: the two steps' credits.
    const credits = plan.items.map((i) => creditsFor(fixtureCatalog.get(i.model!)!, i.priceRequest!));
    expect(credits.every((c) => c > 0)).toBe(true);
    expect(creditsForAll(plan.items.map((i) => ({ model: fixtureCatalog.get(i.model!)!, request: i.priceRequest! })))).toBe(credits[0]! + credits[1]!);
  });

  it('keeps the requested length and resolution when a model takes them, else snaps to the nearest within the plan', async () => {
    const long = await planPromptSpec({ spec: video({ seconds: 10, resolution: '720p' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    const anim = long.items[1]!;
    expect(anim.model).toBe('lumina/wan2.7-i2v-spicy');
    expect(anim.spec).toMatchObject({ seconds: 10, resolution: '720p' });
    expect(request(anim).problems).toEqual([]);
    // Nothing takes 1080p on Plus (720p cap): the highest it allows.
    const capped = await planPromptSpec({ spec: video({ seconds: 5, resolution: '4K' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(capped.items[1]).toMatchObject({ action: 'run' });
    expect(capped.items[1]!.spec!.resolution).not.toBe('4K');
    expect(request(capped.items[1]!).problems).toEqual([]);
  });

  it('Auto prefers the chain only for mature text-only video: plain videos, pictures and images are unchanged', async () => {
    const plain = await planPromptSpec({ spec: video({ prompt: 'a cat on a sunny porch' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0]).toMatchObject({ ref: 'spec', action: 'run' });
    expect(plain.items[0]!.spec).toMatchObject({ mature: false, mode: 't2v' });
    expect(plain.items[0]!.spec!.chain).toBeUndefined();
    const guest = await planPromptSpec({ spec: video(), catalog: fixtureCatalog, ctx: { ...PLUS, matureAccess: 'preference_off' }, assetOrigins: assets });
    expect(guest.items).toHaveLength(1);
    expect(guest.items[0]!.spec).toMatchObject({ mature: false });
    const image = await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: EXPLICIT }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(image.items).toHaveLength(1);
    // A platform picture as the first frame: one item (no keyframe step).
    const framed = await planPromptSpec({ spec: video({ inputs: { firstFrameAssetId: 'ast_gen' } }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets });
    expect(framed.items.map((i) => i.ref)).toEqual(['spec']);
  });

  it('asks the quote-time classifier only for text-only videos the rules see nothing in, and chains when it says explicit', async () => {
    const asked: string[] = [];
    const explicit = async (p: string) => (asked.push(p), true);
    const plan = await planPromptSpec({ spec: video({ prompt: 'two adults, an adult category the rules cannot see' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets, explicit });
    expect(asked).toEqual(['two adults, an adult category the rules cannot see']);
    expect(plan.items.map((i) => i.ref)).toEqual(['keyframe', 'spec']);
    expect(plan.items[1]!.spec).toMatchObject({ mature: true, matureAuto: true });
    // Rules already explicit, an image, or a caller without access: not asked.
    asked.length = 0;
    await planPromptSpec({ spec: video(), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets, explicit });
    await planPromptSpec({ spec: spec({ kind: 'image', model: 'auto', prompt: 'two adults' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets, explicit });
    await planPromptSpec({ spec: video({ prompt: 'two adults' }), catalog: fixtureCatalog, ctx: PLUS, assetOrigins: assets, explicit });
    expect(asked).toEqual([]);
    // A classifier error plans the ordinary run.
    const err = await planPromptSpec({ spec: video({ prompt: 'two adults' }), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets, explicit: async () => { throw new Error('down'); } });
    expect(err.items.map((i) => i.ref)).toEqual(['spec']);
  });

  it('fails at quote with a clear reason when a step has no model', async () => {
    const noImage = new Catalog(fixtureCatalog.models.filter((m) => !(m.kind === 'image' && m.matureRouting === 'allowed')));
    const a = await planPromptSpec({ spec: video(), catalog: noImage, ctx: MATURE, assetOrigins: assets });
    expect(a.items).toEqual([expect.objectContaining({ ref: 'spec', action: 'blocked', code: 'no_capable_model', reason: 'No picture model that takes mature content is available to make the first frame.' })]);
    const noSpicy = new Catalog(fixtureCatalog.models.filter((m) => !/-spicy/.test(m.id) || m.kind === 'image'));
    const b = await planPromptSpec({ spec: video(), catalog: noSpicy, ctx: MATURE, assetOrigins: assets });
    expect(b.items).toEqual([expect.objectContaining({ ref: 'spec', action: 'blocked', code: 'no_capable_model', reason: 'No model that takes mature content fits these settings.' })]);
  });

  it('a retry of the animation alone reuses the earlier keyframe as a platform picture', async () => {
    const plan = await planPromptSpec({ spec: video(), catalog: fixtureCatalog, ctx: MATURE, assetOrigins: assets, onlyRefs: ['spec'], priorAssets: { keyframe: 'ast_kf' } });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ ref: 'spec', action: 'run', dependsOn: [] });
    expect(plan.items[0]!.spec!.inputs).toEqual([{ role: 'frame', media: 'image', from: { assetId: 'ast_kf', origin: 'generated' } }]);
  });
});
