import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../lib/models';
import { catalogToOptions, unitCredits } from './catalog';

const base: CatalogModel = {
  id: 'bytedance/seedance-2.5',
  kind: 'video',
  name: 'Seedance 2.5',
  tags: ['Omni reference'],
  default: true,
  auto: true,
  mature: false,
  matureOnly: false,
  requiresIdentitySafety: false,
  operations: [],
  seconds: { min: 5, max: 30 },
  defaultSeconds: 5,
  resolutions: ['480p', '720p'],
  defaultResolution: '720p',
  ratios: [],
  audio: true,
  lipSync: false,
  credits: [
    { resolution: '480p', seconds: 5, credits: 4 },
    { resolution: '720p', seconds: 5, credits: 8 },
    { resolution: '720p', seconds: 10, credits: 16 },
  ],
};

describe('catalogToOptions', () => {
  it('quotes video per 5s at the default resolution and marks the default model popular', () => {
    const [o] = catalogToOptions([base], 'video');
    expect(o).toMatchObject({ id: base.id, credits: 8, unit: 'per5s', badge: 'popular', mark: 'S2' });
  });
  it('hides mature-only models unless asked, and lists lip-sync models for avatar', () => {
    const mature = { ...base, id: 'm', matureOnly: true };
    const lip = { ...base, id: 'l', lipSync: true };
    expect(catalogToOptions([base, mature], 'video').map((o) => o.id)).toEqual([base.id]);
    expect(catalogToOptions([base, mature], 'video', { showMature: true })).toHaveLength(2);
    expect(catalogToOptions([base, lip], 'avatar').map((o) => [o.id, o.unit, o.credits])).toEqual([['l', 'per10s', 16]]);
  });
  it('scales from the nearest point when the exact length is missing; images use the first point', () => {
    expect(unitCredits({ ...base, credits: [{ resolution: '720p', seconds: 4, credits: 6 }] }, 5)).toBe(8);
    expect(unitCredits({ ...base, kind: 'image', credits: [{ resolution: null, seconds: null, credits: 3 }] }, null)).toBe(3);
  });
});
