import { describe, expect, it } from 'vitest';
import { lanePeaks, PEAKS_PER_SECOND } from './peaks';
import { posterUrl, assetMediaUrl } from '@/features/overlays/backend';

describe('editor waveform and stills (real mode)', () => {
  it('spreads media.process peaks (0..1) over the source length at the lane rate, in tenths of a pixel', () => {
    const p = lanePeaks([0, 0.5, 1, 0.25], 3);
    expect(p).toHaveLength(Math.round(3 * PEAKS_PER_SECOND));
    expect(p[0]).toBe(4); // silence stays a thin line
    expect(Math.max(...p)).toBe(130);
    expect(p[p.length - 1]).toBe(Math.round(0.25 * 130));
    expect(lanePeaks([], 3)).toEqual([0]);
    // Without a length, one peak per lane step.
    expect(lanePeaks([0.5, 0.5], null)).toHaveLength(2);
  });

  it('bin and clip stills use the poster variant of the asset', () => {
    expect(posterUrl(assetMediaUrl('ast_1'))).toBe('/api/media/private/ast_1?variant=poster');
  });
});
