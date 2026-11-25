import { describe, expect, it } from 'vitest';
import {
  estimateUsd,
  getCapabilities,
  getCapabilitiesByProviderId,
  isMatureRoutable,
  MatureRoutingError,
  MODEL_CAPABILITIES,
  moderationFor,
  pickAuto,
  validateRequest,
} from './capabilities';
import type { ModelCapabilities } from './types';

const cap = (key: string): ModelCapabilities => getCapabilities(key)!;

describe('capabilities table', () => {
  it('has unique keys and provider ids', () => {
    expect(new Set(MODEL_CAPABILITIES.map((m) => m.key)).size).toBe(MODEL_CAPABILITIES.length);
    expect(new Set(MODEL_CAPABILITIES.map((m) => m.providerModelId)).size).toBe(MODEL_CAPABILITIES.length);
    expect(getCapabilitiesByProviderId('bytedance/seedance-2.5')?.key).toBe('seedance-2.5');
  });

  it('marks substitutes (D-002)', () => {
    expect(cap('seedance-2.0-mini').substituteFor).toBe('wan-2.2');
    expect(cap('qwen-image-2.0').substituteFor).toBe('wan-2.7-image');
    expect(cap('seedream-5.5').substituteFor).toBe('seedream-5.0-pro');
    for (const m of MODEL_CAPABILITIES) if (m.status === 'substitute') expect(m.substituteFor).toBeTruthy();
  });

  it('defaults mature to false and never allows identity models for mature runs (D-005)', () => {
    for (const m of MODEL_CAPABILITIES) expect(m.mature).toBe(false);
    for (const key of ['face-swap', 'head-swap', 'video-face-swap', 'video-head-swap']) {
      expect(cap(key).requiresIdentitySafety).toBe(true);
      expect(isMatureRoutable({ ...cap(key), mature: true })).toBe(false);
    }
  });
});

describe('moderationFor', () => {
  it('sends auto for normal runs', () => {
    expect(moderationFor(cap('seedance-2.5'), false)).toBe('auto');
    expect(moderationFor(cap('seedance-2.5'), undefined)).toBe('auto');
  });
  it('sends low only for mature runs on mature models', () => {
    expect(moderationFor({ ...cap('z-image-spicy'), mature: true }, true)).toBe('low');
    expect(() => moderationFor(cap('seedance-2.5'), true)).toThrow(MatureRoutingError);
    expect(() => moderationFor({ ...cap('face-swap'), mature: true }, true)).toThrow(MatureRoutingError);
  });
});

describe('pickAuto', () => {
  it('picks the cheapest video model that fits', () => {
    expect(pickAuto({ kind: 'video', mode: 't2v' })?.key).toBe('seedance-2.0-mini');
    expect(pickAuto({ kind: 'video', mode: 't2v', seconds: 20 })?.key).toBe('wan-3.0');
    expect(pickAuto({ kind: 'video', mode: 't2v', resolution: '1080p' })?.key).toBe('wan-3.0');
    expect(pickAuto({ kind: 'video', mode: 't2v', resolution: '2K' })?.key).toBe('minimax-h3');
    expect(pickAuto({ kind: 'video', mode: 'refs', referenceImages: 10 })?.key).toBe('wan-3.0');
  });

  it('picks the cheapest image model that fits', () => {
    expect(pickAuto({ kind: 'image', mode: 't2i' })?.key).toBe('seedream-5.0-flash');
    expect(pickAuto({ kind: 'image', mode: 't2i', n: 4 })?.key).toBe('qwen-image-2.0');
  });

  it('never picks identity or candidate models and returns null when nothing fits', () => {
    expect(pickAuto({ kind: 'image', mode: 'face_swap' })).toBeNull();
    expect(pickAuto({ kind: 'video', mode: 'extend' })).toBeNull();
    expect(pickAuto({ kind: 'video', mode: 't2v', mature: true })).toBeNull();
  });

  it('routes mature runs only to mature models', () => {
    const models = MODEL_CAPABILITIES.map((m) => (m.key === 'wan-3.0' ? { ...m, mature: true } : m));
    expect(pickAuto({ kind: 'video', mode: 't2v', mature: true }, models)?.key).toBe('wan-3.0');
  });
});

describe('estimateUsd', () => {
  it('uses per-second and per-image prices', () => {
    expect(estimateUsd(cap('seedance-2.0-mini'), { seconds: 5, resolution: '480p' })).toBeCloseTo(0.17577, 5);
    expect(estimateUsd(cap('wan-3.0'), { seconds: 10, resolution: '1080p' })).toBeCloseTo(2, 5);
    expect(estimateUsd(cap('seedream-5.0-lite'), {})).toBe(0.035);
    expect(estimateUsd(cap('seedream-5.5'), { resolution: '2K' })).toBe(0.035);
  });
});

describe('validateRequest', () => {
  it('flags unsupported fields', () => {
    expect(validateRequest(cap('seedream-5.0-lite'), { kind: 'image', mode: 't2i', prompt: 'x', negativePrompt: 'y' })).toEqual([
      'negativePrompt not supported',
    ]);
    expect(validateRequest(cap('minimax-h3'), { kind: 'video', mode: 't2v', prompt: 'x', audio: true })).toEqual(['audio not supported']);
    expect(validateRequest(cap('seedance-2.5'), { kind: 'video', mode: 'i2v', prompt: 'x' })).toEqual(['i2v needs firstFrameUrl']);
    expect(validateRequest(cap('seedance-2.5'), { kind: 'video', mode: 't2v', prompt: 'x', seconds: 5, resolution: '720p' })).toEqual([]);
  });
});
