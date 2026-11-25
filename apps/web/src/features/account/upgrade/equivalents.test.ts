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
