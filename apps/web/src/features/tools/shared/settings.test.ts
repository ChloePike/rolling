import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { capsOf, defaultSettings, DESIGN_CAPS, durationsOf, fitSettings, toolCaps } from './settings';
import { fromCatalog } from './useToolModels';

const m = (o: Partial<CatalogModel>) =>
  ({
    id: 'v/a', name: 'A', kind: 'video', tags: [], default: false, auto: true, mature: false, matureOnly: false, requiresIdentitySafety: false, operations: ['t2v'],
    seconds: { min: 4, max: 12 }, defaultSeconds: 5, resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: ['16:9', '9:16'], audio: true, lipSync: false, credits: [],
    ...o,
  }) as CatalogModel;

describe('tool settings from the catalog', () => {
  it('lengths: the allowed list, else the usual steps inside min..max', () => {
    expect(durationsOf(m({}))).toEqual([5, 10]);
    expect(durationsOf(m({ seconds: { min: 5, max: 15, allowed: [10, 5] } as CatalogModel['seconds'] }))).toEqual([5, 10]);
    expect(durationsOf(m({ seconds: { min: 6, max: 8 }, defaultSeconds: 6 }))).toEqual([6]);
    expect(durationsOf(m({ seconds: null }))).toEqual([]);
  });

  it('caps hide what the model lacks: no audio, no count for video, image count from the request limit', () => {
    expect(capsOf(m({ audio: false }), 'video')).toMatchObject({ audio: false, counts: [], ratios: ['16:9', '9:16'], design: false });
    expect(capsOf(m({ kind: 'image', resolutions: ['1K', '2K'], limits: { imagesPerRequest: 2 } } as Partial<CatalogModel>), 'image')).toMatchObject({ durations: [], counts: [1, 2], resolutions: ['1K', '2K'] });
    expect(capsOf(m({ lipSync: true }), 'avatar').durations).toEqual([]);
    expect(capsOf(undefined, 'video').ratios).toEqual([]);
  });

  it('defaults come from the model; unsupported values fall back when the model changes', () => {
    const caps = capsOf(m({}), 'video');
    expect(defaultSettings(caps, m({}))).toEqual({ ratio: '16:9', resolution: '720p', seconds: 5, audio: true, count: 1 });
    const other = m({ resolutions: ['768p'], defaultResolution: '768p', ratios: ['1:1'], audio: false, seconds: { min: 10, max: 10 }, defaultSeconds: 10 });
    expect(fitSettings({ ratio: '16:9', resolution: '720p', seconds: 5, audio: true, count: 1 }, capsOf(other, 'video'), other)).toEqual({ ratio: '1:1', resolution: '768p', seconds: 10, audio: false, count: 1 });
  });

  it('Auto uses the catalog default model; the mock list uses the design options', () => {
    const list = fromCatalog([m({ id: 'v/x', name: 'X', ratios: ['4:3'] }), m({ id: 'v/y', name: 'Y', default: true, ratios: ['21:9'] })], 'video');
    expect(toolCaps(list, 'Auto', 'video').ratios).toEqual(['21:9']);
    expect(toolCaps(list, 'X', 'video').ratios).toEqual(['4:3']);
    expect(toolCaps([{ id: 'x', name: 'X', mark: 'X', tone: '', tags: [], credits: 1, unit: 'per5s', eta: '' }], 'Auto', 'video')).toEqual(DESIGN_CAPS.video);
  });
});
