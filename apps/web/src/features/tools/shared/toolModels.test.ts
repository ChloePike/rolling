import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { fromCatalog, modelIdOf, segModels, TOOL_NEEDS } from './useToolModels';

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
  it('keeps the kind, real ids and indicative per-5s prices; lip-sync models only in Avatar', () => {
    const video = fromCatalog(catalog, 'video');
    expect(video.map((m) => m.id)).toEqual(['bytedance/seedance-2.5']);
    expect(video[0]).toMatchObject({ credits: 8, unit: 'per5s', isDefault: true });
    expect(video[0]!.catalog?.id).toBe('bytedance/seedance-2.5');
    expect(fromCatalog(catalog, 'avatar').map((m) => m.id)).toEqual(['lumina/wan2.7-i2v-spicy']);
    expect(fromCatalog(catalog, 'image')[0]).toMatchObject({ unit: 'perImage', credits: 3 });
  });

  it('drops hidden, tool-only and mature-only models (D-009, D-005)', () => {
    const list = [...catalog, m({ id: 'x/swap', name: 'Swap', kind: 'video', placement: 'tool', credits: [] }), m({ id: 'x/hidden', name: 'Hidden', kind: 'video', hidden: true, credits: [] }), m({ id: 'x/spicy', name: 'Spicy', kind: 'video', matureOnly: true, credits: [] })];
    expect(fromCatalog(list, 'video').map((x) => x.id)).toEqual(['bytedance/seedance-2.5']);
  });

  it('Advanced "Model" chips: catalog names of featured models (max 3); the mock list uses the design ids', () => {
    const many = ['a', 'b', 'c', 'd'].map((id) => m({ id: `v/${id}`, name: `Model ${id.toUpperCase()}`, kind: 'video', credits: [] }));
    expect(segModels(fromCatalog(many, 'video'), ['v/d']).map((x) => x.name)).toEqual(['Model A', 'Model B', 'Model C']);
    const more = [m({ id: 'v/f', name: 'Featured', kind: 'video', credits: [] }), m({ id: 'v/m', name: 'More', kind: 'video', placement: 'more', credits: [] })];
    expect(segModels(fromCatalog(more, 'video')).map((x) => x.name)).toEqual(['Featured']);
    const mock = [{ id: 'x', name: 'X', mark: 'X', tone: '', tags: [], credits: 1, unit: 'per5s' as const, eta: '' }, { id: 'y', name: 'Y', mark: 'Y', tone: '', tags: [], credits: 1, unit: 'per5s' as const, eta: '' }];
    expect(segModels(mock, ['y']).map((x) => x.name)).toEqual(['Y']);
  });

  it('tool needs: Remix wants reference or first-frame input, Quick text or references', () => {
    expect(TOOL_NEEDS.remix(m({ id: 'a', name: 'A', kind: 'video', operations: ['t2v'], credits: [] }))).toBe(false);
    expect(TOOL_NEEDS.remix(m({ id: 'a', name: 'A', kind: 'video', operations: ['t2v', 'refs'], credits: [] }))).toBe(true);
    expect(TOOL_NEEDS.quick(m({ id: 'a', name: 'A', kind: 'video', operations: ['i2v'], credits: [] }))).toBe(false);
  });

  it('run model: a catalog id for a picked name, `auto` for Auto', () => {
    const video = fromCatalog(catalog, 'video');
    expect(modelIdOf(video, 'Seedance 2.5')).toBe('bytedance/seedance-2.5');
    expect(modelIdOf(video, 'Auto')).toBe('auto');
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
