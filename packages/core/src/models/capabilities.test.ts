import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureModel as m } from './__fixtures__/catalog';
import {
  estimateUsd,
  isMatureRoutable,
  MatureRoutingError,
  matureRunProblem,
  moderationFor,
  pickAuto,
  validateRequest,
} from './capabilities';
import { Catalog } from './catalog';
import type { GenerateRequest } from './types';

describe('pickAuto over the catalog', () => {
  it('picks the cheapest video model that fits', () => {
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v' })?.id).toBe('bytedance/seedance-2.0-mini');
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v', seconds: 20 })?.id).toBe('alibaba/wan3.0');
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v', resolution: '1080p' })?.id).toBe('alibaba/wan3.0');
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v', resolution: '2K' })?.id).toBe('minimax/minimax-h3');
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 'refs', referenceImages: 10 })?.id).toBe('alibaba/wan3.0');
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v', audio: true, resolution: '720p' })?.id).toBe(
      'bytedance/seedance-2.0-mini',
    );
  });

  it('picks the cheapest image model that fits', () => {
    expect(pickAuto(fixtureCatalog, { kind: 'image', mode: 't2i' })?.id).toBe('bytedance/seedream-5.0-flash');
    expect(pickAuto(fixtureCatalog, { kind: 'image', mode: 't2i', n: 4 })?.id).toBe('qwen/qwen-image-2.0');
  });

  it('never picks identity, non-auto or hidden models and returns null when nothing fits', () => {
    expect(pickAuto(fixtureCatalog, { kind: 'image', mode: 'face_swap' })).toBeNull();
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 'lip_sync' })).toBeNull();
    // Only grok-imagine-video lists `extend`, and it has no overlay entry (not Auto).
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 'extend' })).toBeNull();
    const hidden = new Catalog(fixtureCatalog.models.map((x) => (x.id === 'bytedance/seedance-2.0-mini' ? { ...x, hidden: true } : x)));
    expect(pickAuto(hidden, { kind: 'video', mode: 't2v' })?.id).toBe('alibaba/wan3.0');
  });

  it('routes mature runs only to mature models', () => {
    // No Auto video model is in the mature family.
    expect(pickAuto(fixtureCatalog, { kind: 'video', mode: 't2v', mature: true })).toBeNull();
    // qwen-image-2.0 accepts `moderation`, so it is mature-routable (D-005).
    expect(pickAuto(fixtureCatalog, { kind: 'image', mode: 't2i', mature: true })?.id).toBe('qwen/qwen-image-2.0');
  });

  it('works over a plain model list too', () => {
    expect(pickAuto(fixtureCatalog.list({ kind: 'video' }), { kind: 'video', mode: 't2v' })?.id).toBe(
      'bytedance/seedance-2.0-mini',
    );
  });
});

describe('estimateUsd', () => {
  it('uses the listing price rules', () => {
    expect(estimateUsd(m('bytedance/seedance-2.0-mini'), { seconds: 5, resolution: '480p' })).toBeCloseTo(0.17577, 9);
    expect(estimateUsd(m('alibaba/wan3.0'), { seconds: 10, resolution: '1080p' })).toBeCloseTo(2, 9);
    expect(estimateUsd(m('bytedance/seedream-5.0-lite'))).toBe(0.035);
  });
});

describe('moderationFor', () => {
  it('sends auto for normal runs', () => {
    expect(moderationFor(m('bytedance/seedance-2.5'), false)).toBe('auto');
    expect(moderationFor(m('bytedance/seedance-2.5'), undefined)).toBe('auto');
    expect(moderationFor(m('lumina/face-swap'), false)).toBe('auto');
  });

  it('sends low only for mature runs the model may take', () => {
    expect(moderationFor(m('lumina/z-image-spicy'), true)).toBe('low');
    expect(moderationFor(m('qwen/qwen-image-2.0'), true)).toBe('low');
    expect(() => moderationFor(m('bytedance/seedance-2.5'), true)).toThrow(MatureRoutingError);
    expect(() => moderationFor(m('lumina/face-swap'), true)).toThrow(/never used for mature runs/);
  });
});

describe('D-005 identity-safety rule', () => {
  const lipSync = (sources?: GenerateRequest['imageSources']): GenerateRequest => ({
    kind: 'video',
    mode: 'i2v',
    prompt: 'She smiles',
    firstFrameUrl: 'https://r2.example/a.png',
    audioUrl: 'https://r2.example/a.mp3',
    mature: true,
    ...(sources && { imageSources: sources }),
  });

  it('flags identity-driven models and keeps them out of the plain mature flag', () => {
    for (const id of [
      'lumina/face-swap',
      'lumina/head-swap',
      'lumina/video-face-swap',
      'lumina/video-head-swap',
      'lumina/wan2.7-i2v-spicy',
      'lumina/wan2.2-i2v-spicy',
      'lumina/wan-animate',
    ]) {
      expect(m(id).requiresIdentitySafety, id).toBe(true);
      expect(m(id).mature, id).toBe(false);
    }
    expect(m('lumina/wan2.7-i2v-spicy').matureRouting).toBe('platform_assets_only');
    expect(m('lumina/face-swap').matureRouting).toBe('never');
    expect(m('lumina/video-head-swap').matureRouting).toBe('never');
    expect(m('lumina/wan-animate').matureRouting).toBe('never');
  });

  it('allows a mature photo-driven run only when every picture is a platform asset', () => {
    const model = m('lumina/wan2.7-i2v-spicy');
    for (const source of ['generated', 'character', 'public'] as const) {
      expect(validateRequest(model, lipSync([source]))).toEqual([]);
      expect(moderationFor(model, true, lipSync([source]))).toBe('low');
    }
    expect(isMatureRoutable(model, ['generated'])).toBe(true);
  });

  it('rejects uploaded photos and missing provenance for mature runs', () => {
    const model = m('lumina/wan2.7-i2v-spicy');
    expect(validateRequest(model, lipSync(['upload']))[0]).toMatch(/only platform assets/);
    expect(() => moderationFor(model, true, lipSync(['upload']))).toThrow(MatureRoutingError);
    expect(validateRequest(model, lipSync())[0]).toMatch(/source of every input picture/);
    expect(() => moderationFor(model, true, lipSync())).toThrow(MatureRoutingError);
    expect(isMatureRoutable(model)).toBe(false);
    expect(isMatureRoutable(model, ['generated', 'mine'])).toBe(false);
    // Non-mature runs with an uploaded photo are a matter for core/safety, not routing.
    expect(validateRequest(model, { ...lipSync(['upload']), mature: false })).toEqual([]);
  });

  it('never allows face/head swap for mature runs, whatever the sources', () => {
    const swap = m('lumina/face-swap');
    expect(matureRunProblem(swap, ['generated', 'generated'], 2)).toMatch(/never/);
    const forced = { ...swap, matureRouting: 'platform_assets_only' as const };
    expect(matureRunProblem(forced, ['generated', 'generated'], 2)).toMatch(/never/);
    expect(isMatureRoutable(swap, ['generated', 'generated'])).toBe(false);
  });
});

describe('validateRequest', () => {
  it('flags unsupported fields from the listing', () => {
    expect(
      validateRequest(m('bytedance/seedream-5.0-lite'), { kind: 'image', mode: 't2i', prompt: 'x', negativePrompt: 'y' }),
    ).toEqual(['negativePrompt not supported']);
    expect(validateRequest(m('minimax/minimax-h3'), { kind: 'video', mode: 't2v', prompt: 'x', audio: true })).toEqual([
      'audio not supported',
    ]);
    expect(validateRequest(m('bytedance/seedance-2.5'), { kind: 'video', mode: 'i2v', prompt: 'x' })).toEqual([
      'i2v needs firstFrameUrl',
    ]);
    expect(
      validateRequest(m('bytedance/seedance-2.5'), { kind: 'video', mode: 't2v', prompt: 'x', seconds: 5, resolution: '720p' }),
    ).toEqual([]);
    expect(validateRequest(m('bytedance/seedance-2.5'), { kind: 'video', mode: 't2v', prompt: 'x', seconds: 20 })).toEqual([
      'seconds not supported',
    ]);
  });

  it('applies the listing exclusive and needs rules', () => {
    expect(
      validateRequest(m('bytedance/seedance-2.5'), {
        kind: 'video',
        mode: 'refs',
        prompt: 'x',
        firstFrameUrl: 'https://x/a.png',
        referenceImageUrls: ['https://x/b.png'],
      }),
    ).toContain('first_frame cannot be combined with reference_images');
    expect(
      validateRequest(m('bytedance/seedance-2.0-mini'), {
        kind: 'video',
        mode: 'refs',
        prompt: 'x',
        referenceAudioUrls: ['https://x/a.mp3'],
      }),
    ).toContain('reference_audios needs one of reference_images/reference_videos');
  });

  it('checks input picture counts for swaps', () => {
    const one = { kind: 'image' as const, mode: 'face_swap' as const, prompt: '', inputImageUrls: ['https://x/a.png'] };
    expect(validateRequest(m('lumina/face-swap'), one)).toEqual(['at least 2 input images']);
    expect(validateRequest(m('lumina/face-swap'), { ...one, inputImageUrls: ['https://x/a.png', 'https://x/b.png'] })).toEqual([]);
  });
});
