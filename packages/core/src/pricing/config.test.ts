import { describe, expect, it } from 'vitest';
import { getCapabilities, MODEL_CAPABILITIES } from '../models/capabilities';
import {
  CREDIT_PRICES,
  creditsFor,
  creditsForAll,
  DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  PLANS,
  PRICE_PLACEHOLDER,
  UnpricedModelError,
} from './config';

describe('pricing placeholders', () => {
  it('ships the PRD placeholders', () => {
    expect(PLANS.starter.monthlyCredits).toBe(1000);
    expect(PLANS.pro.monthlyCredits).toBe(3000);
    expect(PLANS.studio.monthlyCredits).toBe(10000);
    expect(PLANS.pro.priceMonthlyUsd).toBe(PRICE_PLACEHOLDER);
    expect(DEFAULT_CONFIRM_THRESHOLD_CREDITS).toBe(20);
    expect(CREDIT_PRICES['seedance-2.5'].credits).toBe(8);
  });

  it('prices video per started 5 seconds', () => {
    expect(creditsFor({ creditKey: 'seedance-2.5', kind: 'video', seconds: 5 })).toBe(8);
    expect(creditsFor({ creditKey: 'seedance-2.5', kind: 'video', seconds: 10 })).toBe(16);
    expect(creditsFor({ creditKey: 'seedance-2.5', kind: 'video', seconds: 6 })).toBe(16);
    expect(creditsFor({ creditKey: 'minimax-h3', kind: 'video', seconds: 5 })).toBe(6);
    expect(creditsFor({ creditKey: 'wan-3.0', kind: 'video', seconds: 30 })).toBe(42);
    expect(creditsFor({ creditKey: 'wan-2.2', kind: 'video', seconds: 4 })).toBe(2);
  });

  it('prices images per image', () => {
    expect(creditsFor({ creditKey: 'seedream-5.0-pro', kind: 'image' })).toBe(3);
    expect(creditsFor({ creditKey: 'seedream-5.0-lite', kind: 'image', count: 4 })).toBe(4);
    expect(creditsFor({ creditKey: 'wan-2.7-image', kind: 'image', count: 2 })).toBe(4);
    expect(
      creditsForAll([
        { creditKey: 'seedream-5.0-lite', kind: 'image' },
        { creditKey: 'seedance-2.5', kind: 'video', seconds: 5 },
      ]),
    ).toBe(9);
  });

  it('refuses unpriced models and bad inputs', () => {
    expect(() => creditsFor({ creditKey: 'seedance-2.5-flash', kind: 'video', seconds: 5 })).toThrow(UnpricedModelError);
    expect(() => creditsFor({ creditKey: 'seedance-2.5', kind: 'image' })).toThrow(TypeError);
    expect(() => creditsFor({ creditKey: 'seedance-2.5', kind: 'video', seconds: 0 })).toThrow(RangeError);
  });

  it('every capability creditKey has a price', () => {
    for (const cap of MODEL_CAPABILITIES) {
      if (cap.creditKey) expect(Object.keys(CREDIT_PRICES)).toContain(cap.creditKey);
    }
    expect(getCapabilities('seedance-2.0-mini')?.creditKey).toBe('wan-2.2');
  });
});
