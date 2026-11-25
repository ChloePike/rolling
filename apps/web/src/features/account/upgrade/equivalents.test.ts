import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { creditsAt, howMany, ratesFrom, REFERENCE_VIDEO_FALLBACK_CREDITS, secondsOf } from './equivalents';

const video = (credits: CatalogModel['credits']) =>
  ({ id: 'bytedance/seedance-2.5', kind: 'video', name: 'Seedance 2.5', credits, default: true, matureOnly: false, defaultResolution: '720p' }) as CatalogModel;

describe('upgrade equivalents', () => {
  it('reads the exact price point, else scales by seconds', () => {
    expect(creditsAt([{ resolution: '720p', seconds: 5, credits: 347 }], '720p', 5)).toBe(347);
    expect(creditsAt([{ resolution: '720p', seconds: 10, credits: 694 }], '720p', 5)).toBe(347);
    expect(creditsAt([{ resolution: '1080p', seconds: 5, credits: 600 }], '720p', 5)).toBeNull();
  });

  it('falls back to the D-006 example without a catalog', () => {
    expect(ratesFrom(undefined, undefined).video.credits).toBe(REFERENCE_VIDEO_FALLBACK_CREDITS);
    expect(ratesFrom(undefined, undefined).image).toBeNull();
    expect(ratesFrom([video([{ resolution: '720p', seconds: 5, credits: 300 }])], []).video.credits).toBe(300);
  });

  it('counts whole outputs and seconds, rounding down', () => {
    expect(howMany(800, 347)).toBe(2);
    expect(howMany(2500, 347)).toBe(7);
    expect(secondsOf(200, { name: 'x', resolution: '720p', seconds: 5, credits: 347 })).toBe(2);
  });
});

describe('never-zero equivalents and model plan availability', () => {
  it('Starter falls back to 480p shots, then images; never 0', async () => {
    const { equivalentFor } = await import('./equivalents');
    const img = { id: 'bytedance/seedream-5.0-lite', kind: 'image', name: 'Seedream 5.0 Lite', credits: [{ resolution: '2K', seconds: null, credits: 9 }], default: true, matureOnly: false, defaultResolution: '2K' } as CatalogModel;
    const withLow = ratesFrom([video([{ resolution: '720p', seconds: 5, credits: 347 }, { resolution: '480p', seconds: 5, credits: 150 }])], [img]);
    expect(equivalentFor(200, withLow)).toMatchObject({ unit: 'shots', n: 1, rate: { resolution: '480p' }, images: 22 });
    const noLow = ratesFrom([video([{ resolution: '720p', seconds: 5, credits: 347 }])], [img]);
    expect(equivalentFor(200, noLow)).toEqual({ unit: 'images', n: 22, model: 'Seedream 5.0 Lite' });
    expect(equivalentFor(800, noLow)).toMatchObject({ unit: 'shots', n: 2, rate: { resolution: '720p' } });
    // No catalog: an area-scaled 480p estimate keeps the line meaningful.
    expect(equivalentFor(200, ratesFrom(undefined, undefined))).toMatchObject({ unit: 'shots', n: 1, rate: { resolution: '480p' } });
  });

  it('models whose lowest resolution is above 720p need Plus', async () => {
    const { lowestPlanForModel } = await import('./useRates');
    expect(lowestPlanForModel({ kind: 'video', resolutions: ['768p'] })).toBe('plus');
    expect(lowestPlanForModel({ kind: 'video', resolutions: ['1080p', '4K'] })).toBe('plus');
    expect(lowestPlanForModel({ kind: 'video', resolutions: ['480p', '720p', '1080p'] })).toBe('starter');
    expect(lowestPlanForModel({ kind: 'video', resolutions: ['4K'] })).toBe('pro');
    expect(lowestPlanForModel({ kind: 'image', resolutions: ['2K'] })).toBe('starter');
  });
});
