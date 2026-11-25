import { describe, expect, it } from 'vitest';
import listing from './__fixtures__/hyperouter-models.json';
import { fixtureCatalog, fixtureModel as m } from './__fixtures__/catalog';
import { Catalog, defaultFromDescription, ListingParseError, parseListing, priceLines, usdCost } from './catalog';
import { MODEL_OVERLAY, mergeModel } from './overlay';

type Entry = Record<string, unknown> & { id: string };
const entries = (listing as { data: Entry[] }).data;
const entry = (id: string): Entry => structuredClone(entries.find((e) => e.id === id)!);

describe('parseListing on the real fixture', () => {
  const parsed = parseListing(listing);

  it('parses every entry without skipping', () => {
    expect(parsed.skipped).toEqual([]);
    expect(parsed.models).toHaveLength(entries.length);
    expect(parsed.models.filter((x) => x.kind === 'video')).toHaveLength(23);
    expect(parsed.models.filter((x) => x.kind === 'image')).toHaveLength(11);
  });

  it('derives Seedance 2.5 capabilities', () => {
    const s = m('bytedance/seedance-2.5');
    expect(s).toMatchObject({
      kind: 'video',
      operations: ['t2v', 'i2v', 'first_last_frame', 'refs'],
      seconds: { min: 4, max: 15 },
      defaultSeconds: 4,
      resolutions: ['480p', '720p', '1080p'],
      defaultResolution: '480p',
      audio: true,
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      params: { seed: false, negativePrompt: false, promptExtend: false, size: false },
      supportsModeration: false,
    });
    expect(s.ratios).toContain('adaptive');
    expect(s.exclusive).toEqual([[['first_frame', 'last_frame'], ['reference_images', 'reference_videos', 'reference_audios']]]);
    expect(s.acceptedParams).toEqual(expect.arrayContaining(['watermark', 'reference_audios', 'prompt_expand']));
  });

  it('derives other shapes from the parameter schema', () => {
    expect(m('minimax/minimax-h3')).toMatchObject({ audio: false, resolutions: ['768p', '2K'], defaultResolution: '768p', maxReferenceImages: 5 });
    expect(m('alibaba/wan3.0')).toMatchObject({ seconds: { min: 2, max: 30 }, params: { seed: true, promptExtend: true } });
    expect(m('lumina/wan2.2-i2v-spicy')).toMatchObject({
      operations: ['i2v', 'first_last_frame'],
      seconds: { min: 5, max: 8, allowed: [5, 8] },
      inputImageRequired: true,
    });
    expect(m('lumina/wan2.7-i2v-spicy')).toMatchObject({ operations: ['i2v', 'lip_sync'], lipSync: true, defaultSeconds: 2 });
    expect(m('lumina/wan-animate')).toMatchObject({ operations: ['motion_transfer'], defaultResolution: '720p' });
    expect(m('lumina/wan-animate').seconds).toBeUndefined();
    expect(m('lumina/video-face-swap').operations).toEqual(['face_swap']);
    expect(m('lumina/head-swap')).toMatchObject({ operations: ['head_swap'], minInputImages: 2, maxInputImages: 2 });
    expect(m('lumina/qwen-image-edit-spicy').operations).toEqual(['edit']);
    expect(m('bytedance/seedream-5.0-lite')).toMatchObject({
      operations: ['t2i', 'edit'],
      maxInputImages: 10,
      maxImagesPerRequest: 1,
      params: { seed: false, size: true },
    });
    expect(m('qwen/qwen-image-2.0')).toMatchObject({ maxImagesPerRequest: 6, supportsModeration: true, defaultSize: '2048x2048' });
    // grok-imagine-image lists `size` only to say it is ignored.
    expect(m('x-ai/grok-imagine-image').params.size).toBe(false);
    expect(m('x-ai/grok-imagine-video')).toMatchObject({ operations: ['t2v', 'refs', 'extend'], unmappedOperations: ['edit'] });
    expect(m('deepseek/deepseek-v4.1-flash').kind).toBe('chat');
  });

  it('records what it could not map', () => {
    expect(m('x-ai/grok-imagine-video-1.5').unmapped).toEqual(['param:keyframes', 'param:voices']);
    expect(m('lumina/face-detect').unmapped).toContain('meter:extra_face');
    expect(m('bytedance/seedance-2.5').unmapped).toEqual([]);
  });

  it('reads defaults from descriptions', () => {
    expect(defaultFromDescription(['480p', '720p'], 'Default `480p`.')).toBe('480p');
    expect(defaultFromDescription(['768p', '2K'], '`768p` (the default) or `2K`.')).toBe('768p');
    expect(defaultFromDescription(['1K', '2K'], 'Output resolution: 1K (default) or 2K.')).toBe('1K');
    expect(defaultFromDescription(['480p', '720p'], 'Default 720p.')).toBe('720p');
    expect(defaultFromDescription(['480p'], undefined)).toBeUndefined();
  });
});

describe('parseListing robustness', () => {
  it('ignores unknown fields and defaults missing optional ones', () => {
    const e = entry('bytedance/seedance-2.5');
    e.brand_new_field = { nested: true };
    delete e.supported_parameters;
    delete e.response_modes;
    (e.param_schema as Record<string, unknown>).future_rule = [1];
    const { models, skipped } = parseListing({ data: [e], object: 'list' });
    expect(skipped).toEqual([]);
    expect(models[0]!.responseModes).toEqual([]);
    expect(models[0]!.unmapped).toEqual(['field:brand_new_field', 'param_schema:future_rule']);
    expect(usdCost(models[0]!, { resolution: '720p', seconds: 5 })).toBeCloseTo(1.1556, 9);
  });

  it('skips unusable entries with a reason', () => {
    const noPrice = entry('bytedance/seedance-2.5');
    noPrice.id = 'acme/no-price';
    noPrice.prices = [];
    noPrice.pricing = {};
    const { models, skipped } = parseListing({
      data: [{ name: 'no id' }, { id: 'acme/speech', kind: 'speech' }, noPrice, entry('alibaba/wan3.0'), entry('alibaba/wan3.0')],
    });
    expect(models.map((x) => x.id)).toEqual(['alibaba/wan3.0']);
    expect(skipped).toEqual([
      { id: null, reason: expect.stringMatching(/^invalid entry: id/) },
      { id: 'acme/speech', reason: 'unsupported kind "speech"' },
      { id: 'acme/no-price', reason: 'no video_second price' },
      { id: 'alibaba/wan3.0', reason: 'duplicate id' },
    ]);
  });

  it('drops price rules it cannot read instead of making them unconditional', () => {
    const e = entry('bytedance/seedream-5.5');
    (e.prices as unknown[]).push({ meter: 'image', conditions: { region: { eu: true } }, usd: '9' }, { meter: 'image', usd: 'n/a' });
    const model = parseListing({ data: [e] }).models[0]!;
    expect(model.price.some((r) => r.usd === 9)).toBe(false);
    expect(model.unmapped).toContain('price:image:unreadable');
  });

  it('falls back to the flat pricing map when prices is missing', () => {
    const e = entry('bytedance/seedream-5.0-lite');
    delete e.prices;
    expect(usdCost(parseListing({ data: [e] }).models[0]!)).toBe(0.035);
  });

  it('throws only when there is no data array', () => {
    expect(() => parseListing({ models: [] })).toThrow(ListingParseError);
    expect(() => parseListing(null)).toThrow(ListingParseError);
  });
});

describe('price function', () => {
  it('prices Seedance 2.5 per resolution and second', () => {
    const s = m('bytedance/seedance-2.5');
    expect(usdCost(s, { resolution: '480p', seconds: 5 })).toBeCloseTo(0.537354, 9);
    expect(usdCost(s, { resolution: '720p', seconds: 5 })).toBeCloseTo(1.1556, 9);
    expect(usdCost(s, { resolution: '1080p', seconds: 10 })).toBeCloseTo(5.6862, 9);
    // Defaults: 480p, 4 s.
    expect(usdCost(s)).toBeCloseTo(0.4298832, 9);
    // Audio does not change the price on this listing.
    expect(usdCost(s, { resolution: '720p', seconds: 5, audio: true })).toBeCloseTo(1.1556, 9);
    // A resolution the model does not price cannot be quoted.
    expect(usdCost(s, { resolution: '4K', seconds: 5 })).toBeNull();
  });

  it('uses the reference-video rate plus the input charge only when the clip length is known', () => {
    const s = m('bytedance/seedance-2.5');
    expect(usdCost(s, { resolution: '720p', seconds: 5, referenceVideos: 1 })).toBeCloseTo(1.1556, 9);
    const lines = priceLines(s, { resolution: '720p', seconds: 5, referenceVideos: 1, inputVideoMs: 3000 })!;
    expect(lines.map((l) => [l.meter, l.usdPerUnit, l.units])).toEqual([
      ['input_video_ms', 0.00013824, 3000],
      ['video_second', 0.13824, 5],
    ]);
    expect(usdCost(s, { resolution: '720p', seconds: 5, inputVideoMs: 3000 })).toBeCloseTo(0.6912 + 0.41472, 9);
  });

  it('adds per-input-picture charges', () => {
    expect(usdCost(m('minimax/minimax-h3'), { seconds: 5, inputImages: 2 })).toBeCloseTo(0.4 + 0.08, 9);
    expect(usdCost(m('bytedance/seedream-5.5'), { inputImages: 3 })).toBeCloseTo(0.02 + 0.024, 9);
  });

  it('applies min_pixels, quality and input_images conditions', () => {
    const s55 = m('bytedance/seedream-5.5');
    expect(usdCost(s55, { size: '1024x1024' })).toBe(0.02);
    expect(usdCost(s55, { size: '2048x2048' })).toBe(0.035);
    expect(usdCost(s55)).toBe(0.02);
    const grok = m('x-ai/grok-imagine-image-2.0');
    expect(usdCost(grok)).toBe(0.04);
    expect(usdCost(grok, { resolution: '2K' })).toBe(0.06);
    expect(usdCost(grok, { resolution: '2K', quality: 'medium' })).toBe(0.08);
    const edit = m('lumina/qwen-image-edit-spicy');
    expect(usdCost(edit, { inputImages: 1 })).toBe(0.04);
    expect(usdCost(edit, { inputImages: 3 })).toBe(0.046);
    expect(usdCost(edit)).toBeNull();
  });

  it('prices unconditional base rules against resolution overrides', () => {
    const g = m('x-ai/grok-imagine-video');
    expect(usdCost(g, { seconds: 5 })).toBeCloseTo(0.25, 9);
    expect(usdCost(g, { seconds: 5, resolution: '720p' })).toBeCloseTo(0.35, 9);
    expect(usdCost(g, { seconds: 5, n: 3 })).toBeCloseTo(0.25, 9);
  });

  it('does not price chat models', () => {
    expect(usdCost(m('deepseek/deepseek-v4.1-flash'))).toBeNull();
  });
});

describe('overlay merge', () => {
  it('adds product fields and keeps listing fields', () => {
    const s = m('bytedance/seedance-2.5');
    expect(s).toMatchObject({ displayName: 'Seedance 2.5', default: true, auto: true, hidden: false, providerModelId: s.id });
    const listingOnly = parseListing({ data: [entry('bytedance/seedance-2.5')] }).models[0]!;
    // An overlay cannot change technical fields: spread order puts the listing first and mergeModel only adds product fields.
    const merged = mergeModel(listingOnly, { displayName: 'X', ...({ resolutions: ['8K'] } as object) });
    expect(merged.resolutions).toEqual(['480p', '720p', '1080p']);
    expect(merged.displayName).toBe('X');
  });

  it('marks substitutes and one default per kind', () => {
    expect(m('bytedance/seedance-2.0-mini').substituteFor).toBe('wan-2.2');
    expect(m('qwen/qwen-image-2.0').substituteFor).toBe('wan-2.7-image');
    expect(m('bytedance/seedream-5.5').substituteFor).toBe('seedream-5.0-pro');
    expect(fixtureCatalog.defaultFor('video')?.id).toBe('bytedance/seedance-2.5');
    expect(fixtureCatalog.defaultFor('image')?.id).toBe('bytedance/seedream-5.0-lite');
    expect(fixtureCatalog.defaultFor('chat')?.id).toBe('deepseek/deepseek-v4.1-flash');
    for (const kind of ['video', 'image', 'chat'] as const) {
      expect(fixtureCatalog.models.filter((x) => x.kind === kind && x.default)).toHaveLength(1);
    }
  });

  it('derives D-005 flags: spicy family and moderation are mature, identity models are not', () => {
    for (const id of ['lumina/z-image-spicy', 'lumina/z-image-spicy-pro', 'lumina/qwen-image-edit-spicy', 'qwen/qwen-image-2.0']) {
      expect(m(id).mature, id).toBe(true);
    }
    expect(m('lumina/z-image-spicy').matureOnly).toBe(true);
    expect(m('qwen/qwen-image-2.0').matureOnly).toBe(false);
    expect(m('bytedance/seedance-2.5').mature).toBe(false);
    expect(m('lumina/wan2.7-i2v-spicy')).toMatchObject({ mature: false, matureOnly: true, requiresIdentitySafety: true });
  });

  it('keeps new unknown models safe by default', () => {
    const e = entry('lumina/face-swap');
    e.id = 'lumina/face-swap-spicy';
    const swap = Catalog.fromListing({ data: [e] }, {}).catalog.get('lumina/face-swap-spicy')!;
    expect(swap).toMatchObject({ requiresIdentitySafety: true, matureRouting: 'never', mature: false, auto: false });
    const v = entry('bytedance/seedance-2.5');
    v.id = 'acme/new-video';
    const fresh = Catalog.fromListing({ data: [v] }, { 'acme/new-video': { auto: true, requiresIdentitySafety: true } }).catalog.get('acme/new-video')!;
    expect(fresh).toMatchObject({ displayName: 'Seedance 2.5', auto: false, requiresIdentitySafety: true });
  });

  it('every overlay id is in the fixture listing', () => {
    for (const id of Object.keys(MODEL_OVERLAY)) expect(fixtureCatalog.get(id), id).toBeDefined();
  });

  it('lists by kind and hides adult-only models unless asked', () => {
    const images = fixtureCatalog.list({ kind: 'image' });
    expect(images.every((x) => x.kind === 'image')).toBe(true);
    expect(images.some((x) => x.matureOnly)).toBe(false);
    expect(fixtureCatalog.list({ kind: 'image', includeMatureOnly: true }).some((x) => x.id === 'lumina/z-image-spicy')).toBe(true);
  });
});
