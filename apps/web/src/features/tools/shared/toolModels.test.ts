import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { fromCatalog, quoteCredits, segModels } from './useToolModels';

const base = {
  tags: ['Audio'], default: false, auto: true, mature: false, matureOnly: false, requiresIdentitySafety: false, operations: [],
  seconds: { min: 5, max: 30 }, defaultSeconds: 5, resolutions: ['720p', '1080p'], defaultResolution: '720p', ratios: ['9:16'], audio: true, lipSync: false,
};
const m = (o: Partial<CatalogModel>) => ({ ...base, ...o }) as CatalogModel;
const catalog: CatalogModel[] = [
  m({ id: 'bytedance/seedance-2.5', name: 'Seedance 2.5', kind: 'video', default: true, credits: [{ resolution: '720p', seconds: 5, credits: 8 }, { resolution: '1080p', seconds: 5, credits: 14 }] }),
  m({ id: 'lumina/wan2.7-i2v-spicy', name: 'Wan 2.7 I2V', kind: 'video', lipSync: true, credits: [{ resolution: '720p', seconds: 10, credits: 10 }] }),
  m({ id: 'bytedance/seedream-5.5', name: 'Seedream 5.5', kind: 'image', credits: [{ resolution: '2K', seconds: null, credits: 3 }] }),
];

describe('tool model list from the catalog', () => {
  it('keeps the kind, real ids and per-5s prices; avatar lists lip-sync models only', () => {
    const video = fromCatalog(catalog, 'video');
    expect(video.map((m) => m.id)).toEqual(['bytedance/seedance-2.5', 'lumina/wan2.7-i2v-spicy']);
    expect(video[0]).toMatchObject({ credits: 8, unit: 'per5s', isDefault: true });
    expect(video[1]!.credits).toBe(5);
    expect(fromCatalog(catalog, 'avatar').map((m) => m.id)).toEqual(['lumina/wan2.7-i2v-spicy']);
    expect(fromCatalog(catalog, 'image')[0]).toMatchObject({ unit: 'perImage', credits: 3 });
  });

  it('quotes from price points: Auto uses the default model, seconds scale, count multiplies', () => {
    const video = fromCatalog(catalog, 'video');
    expect(quoteCredits(video, 'Auto', { resolution: '720p', seconds: 5 })).toBe(8);
    expect(quoteCredits(video, 'Seedance 2.5', { resolution: '1080p', seconds: 15, count: 2 })).toBe(84);
    expect(quoteCredits(fromCatalog(catalog, 'image'), 'Auto', { resolution: '2K', count: 2 })).toBe(6);
  });

  it('returns no quote for the mock list so screens keep their estimate', () => {
    expect(quoteCredits([{ id: 'x', name: 'X', mark: 'X', tone: '#000', tags: [], credits: 1, unit: 'per5s', eta: '' }], 'X', { seconds: 5 })).toBeUndefined();
  });

  it('Advanced model control prefers the design short list when the catalog has those ids', () => {
    const video = fromCatalog(catalog, 'video');
    expect(segModels(video, ['bytedance/seedance-2.5']).map((m) => m.name)).toEqual(['Seedance 2.5']);
    expect(segModels(video, ['nope']).length).toBe(2);
  });
});

describe('mock model list', () => {
  it('uses real Hyperouter ids (D-002) behind the design display names', async () => {
    const { toolModels } = await import('./models');
    expect(toolModels.video.map((m) => m.id)).toEqual(['bytedance/seedance-2.5', 'minimax/minimax-h3', 'alibaba/wan3.0', 'bytedance/seedance-2.0-mini']);
    expect(toolModels.image.map((m) => m.id)).toEqual(['bytedance/seedream-5.5', 'bytedance/seedream-5.0-lite', 'qwen/qwen-image-2.0']);
    expect(toolModels.avatar.find((m) => m.name === 'Wan 2.2 S2V')?.id).toBe('lumina/wan2.7-i2v-spicy');
  });
});
