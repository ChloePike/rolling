import { describe, expect, it } from 'vitest';
import { NO_CAPS } from '@/lib/models/caps';
import { fitImage } from '@/features/overlays/modelSettings';
import { imageHasChoice, seedImageRatio } from './imageSettings';
import type { ImageParams } from '@/features/overlays/types';

const IMAGE: ImageParams = { aspectRatio: '16:9', quality: 'standard', size: '2K', count: '2' };

describe('Home Image settings', () => {
  it('a model with one fixed option has nothing to choose (read-only pills, no empty popover)', () => {
    // Seedream 5.0 Flash: no ratio list, no resolution list, one image per request.
    expect(imageHasChoice({ ...NO_CAPS, counts: [1] })).toBe(false);
    expect(imageHasChoice({ ...NO_CAPS, ratios: ['1:1'], resolutions: ['2K'], counts: [1] })).toBe(false);
    expect(imageHasChoice({ ...NO_CAPS, ratios: ['1:1', '16:9'], counts: [1] })).toBe(true);
    expect(imageHasChoice({ ...NO_CAPS, counts: [1, 2, 4] })).toBe(true);
    expect(imageHasChoice(null)).toBe(true);
  });

  it('starts from the Preferences aspect ratio unless the model cannot make it', () => {
    expect(seedImageRatio(IMAGE, '9:16').aspectRatio).toBe('9:16');
    expect(seedImageRatio(IMAGE, '1:1').aspectRatio).toBe('1:1');
    // Not a Home ratio: the default stays.
    expect(seedImageRatio(IMAGE, '21:9').aspectRatio).toBe('16:9');
    // The model takes other ratios only: refit to one it takes.
    const seeded = seedImageRatio(IMAGE, '9:16');
    expect(fitImage(seeded, { ...NO_CAPS, ratios: ['1:1', '3:4'], counts: [1] }).aspectRatio).not.toBe('9:16');
    // The model takes it: kept.
    expect(fitImage(seeded, { ...NO_CAPS, ratios: ['16:9', '9:16'], counts: [1] }).aspectRatio).toBe('9:16');
  });
});
