import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { costBlock, fitImage, fitVideo, maxSeconds, modelCaps, paramOptions, strictCredits, videoToSettings } from './modelSettings';
import type { ImageParams, VideoParams } from './types';

const base: CatalogModel = {
  id: 'x',
  kind: 'video',
  name: 'X',
  tags: [],
  default: false,
  auto: true,
  mature: false,
  matureOnly: false,
  requiresIdentitySafety: false,
  operations: [],
  seconds: null,
  defaultSeconds: null,
  resolutions: [],
  defaultResolution: null,
  ratios: [],
  audio: false,
  lipSync: false,
  credits: [],
};

/** Shaped like the synced catalog row: no 1080p, 4–12 s. */
const seedanceMini: CatalogModel = {
  ...base,
  id: 'bytedance/seedance-2.0-mini',
  name: 'Seedance 2.0 Mini',
  seconds: { min: 4, max: 12 },
  defaultSeconds: 5,
  resolutions: ['480p', '720p'],
  defaultResolution: '720p',
  ratios: ['16:9', '9:16', '1:1'],
  audio: true,
  credits: [
    { resolution: '480p', seconds: 5, credits: 40 },
    { resolution: '720p', seconds: 5, credits: 90 },
  ],
};

const seedreamFlash: CatalogModel = {
  ...base,
  id: 'bytedance/seedream-5.0-flash',
  kind: 'image',
  name: 'Seedream 5.0 Flash',
  resolutions: [],
  params: { size: true },
  limits: { imagesPerRequest: 1 },
  ratios: ['1:1', '16:9', '9:16'],
  credits: [{ resolution: null, seconds: null, credits: 6 }],
};

const intl = createIntl({
  locale: 'en',
  messages: {
    'overlays.planLock.reason': 'Available on {plan}',
    'overlays.planLock.label': '{option}, {reason}',
    'overlays.cost.blocked.plan': '{option} isn’t on your plan. {reason}',
    'overlays.cost.blocked.unsupported': '{model} can’t use these settings',
    'overlays.cost.blocked.unpriced': 'No price for these settings yet',
  },
});

const VIDEO: VideoParams = { aspectRatio: '9:16', resolution: '1080p', duration: '15s', count: '1', audio: true };

describe('prompt settings follow the model (PROMPT-2)', () => {
  it('offers exactly the model’s options: Seedance 2.0 Mini has no 1080p and caps at 12s', () => {
    const caps = modelCaps(seedanceMini, 'video')!;
    const opts = paramOptions(caps)!;
    expect(opts.resolutions).toEqual(['480p', '720p']);
    expect(opts.resolutions).not.toContain('1080p');
    expect(opts.ratios).toEqual(['16:9', '9:16', '1:1']);
    expect(opts.durations).toEqual(['5s', '10s']);
    expect(maxSeconds(caps, seedanceMini)).toBe(12);
    expect(modelCaps(undefined, 'video')).toBeNull();
  });

  it('refits an unsupported value to the closest supported one', () => {
    const caps = modelCaps(seedanceMini, 'video');
    expect(fitVideo(VIDEO, caps, seedanceMini)).toEqual({ aspectRatio: '9:16', resolution: '720p', duration: '10s', count: '1', audio: true });
    const fitted = fitVideo(VIDEO, caps, seedanceMini);
    expect(fitVideo(fitted, caps, seedanceMini)).toBe(fitted);
  });

  it('image count defaults to what the model supports (Seedream 5.0 Flash = 1)', () => {
    const caps = modelCaps(seedreamFlash, 'image')!;
    expect(caps.counts).toEqual([1]);
    expect(paramOptions(caps)!.counts).toBeNull();
    const two: ImageParams = { aspectRatio: '16:9', quality: 'standard', size: '2K', count: '2' };
    expect(fitImage(two, caps, seedreamFlash).count).toBe('1');
  });

  it('the cost never shows a number when blocked: plan lock, unsupported or unpriced give a reason', () => {
    const caps = modelCaps(seedanceMini, 'video');
    const ok = fitVideo(VIDEO, caps, seedanceMini);
    expect(costBlock(intl, 'video', seedanceMini, caps, videoToSettings(ok), 'pro')).toBeNull();
    expect(strictCredits(seedanceMini, { resolution: '720p', seconds: 10 })).toBe(180);
    // 1080p is not on this model.
    expect(costBlock(intl, 'video', seedanceMini, caps, videoToSettings(VIDEO), 'pro')).toBe('Seedance 2.0 Mini can’t use these settings');
    // Plan locks still apply (Starter caps video at 720p; 720p passes, a 1080p model would not).
    const big = { ...seedanceMini, resolutions: ['720p', '1080p'], credits: [{ resolution: '1080p', seconds: 5, credits: 200 }, { resolution: '720p', seconds: 5, credits: 90 }] };
    const bigCaps = modelCaps(big, 'video');
    expect(costBlock(intl, 'video', big, bigCaps, { ratio: '9:16', resolution: '1080p', seconds: 5, audio: false, count: 1 }, 'starter')).toMatch(/1080p isn’t on your plan/);
    // No price point for 480p.
    const unpriced = { ...seedanceMini, credits: [{ resolution: '720p', seconds: 5, credits: 90 }] };
    expect(costBlock(intl, 'video', unpriced, caps, { ratio: '9:16', resolution: '480p', seconds: 5, audio: false, count: 1 }, 'pro')).toBe('No price for these settings yet');
    expect(costBlock(intl, 'video', undefined, null, videoToSettings(VIDEO), 'pro')).toBeNull();
  });
});
