import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../lib/models';
import { defaultModel, quoteCredits, toModelOption } from './catalog';

const base = { tags: [], auto: false, mature: false, matureOnly: false, requiresIdentitySafety: false, operations: [], seconds: null, ratios: [], audio: false, lipSync: false };
const video = {
  ...base,
  id: 'v',
  kind: 'video',
  name: 'Seedance 2.5',
  default: true,
  defaultSeconds: 5,
  resolutions: ['720p'],
  defaultResolution: '720p',
  credits: [
    { resolution: '720p', seconds: 5, credits: 8 },
    { resolution: '1080p', seconds: 5, credits: 14 },
  ],
} as CatalogModel;
const image = { ...base, id: 'i', kind: 'image', name: 'Seedream 5.0 Pro', default: false, defaultSeconds: null, resolutions: ['2K'], defaultResolution: '2K', credits: [{ resolution: '2K', seconds: null, credits: 1 }] } as CatalogModel;

describe('catalog quotes', () => {
  it('uses the exact price point', () => {
    expect(quoteCredits(video, { resolution: '720p', seconds: 5 })).toBe(8);
    expect(quoteCredits(video, { resolution: '1080p', seconds: 5 })).toBe(14);
  });
  it('scales by seconds within a resolution and by image count', () => {
    expect(quoteCredits(video, { resolution: '720p', seconds: 15 })).toBe(24);
    expect(quoteCredits(image, { resolution: '2K', count: 2 })).toBe(2);
  });
  it('returns null without a model or prices', () => {
    expect(quoteCredits(undefined)).toBeNull();
    expect(quoteCredits({ ...video, credits: [] })).toBeNull();
  });
  it('maps to picker rows priced per 5s / per image and picks the default model', () => {
    expect(toModelOption(video, 0)).toMatchObject({ name: 'Seedance 2.5', mark: 'S2', credits: 8, unit: 'per5s' });
    expect(toModelOption(image, 1)).toMatchObject({ credits: 1, unit: 'perImage' });
    expect(defaultModel([image, video])?.id).toBe('v');
  });
});
