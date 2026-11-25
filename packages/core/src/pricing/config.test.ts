import { describe, expect, it } from 'vitest';
import { fixtureModel as m } from '../models/__fixtures__/catalog';
import {
  creditsFor,
  creditsForAll,
  creditsForUsd,
  DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  MARKUP,
  PLANS,
  PRICE_PLACEHOLDER,
  UnpricedModelError,
  USD_PER_CREDIT,
} from './config';

describe('pricing placeholders', () => {
  it('ships the PRD placeholders', () => {
    expect(PLANS.starter.monthlyCredits).toBe(1000);
    expect(PLANS.pro.monthlyCredits).toBe(3000);
    expect(PLANS.studio.monthlyCredits).toBe(10000);
    expect(PLANS.pro.priceMonthlyUsd).toBe(PRICE_PLACEHOLDER);
    expect(DEFAULT_CONFIRM_THRESHOLD_CREDITS).toBe(20);
    expect(MARKUP).toBe(1);
    expect(USD_PER_CREDIT).toBe(0.15);
  });
});

describe('creditsFor follows live cost (D-002)', () => {
  it('keeps the PRD anchor: Seedance 2.5, 720p, 5 s = 8 credits', () => {
    expect(creditsFor(m('bytedance/seedance-2.5'), { resolution: '720p', seconds: 5 })).toBe(8);
  });

  it('prices per resolution and length', () => {
    const s = m('bytedance/seedance-2.5');
    expect(creditsFor(s, { resolution: '480p', seconds: 5 })).toBe(4);
    expect(creditsFor(s, { resolution: '1080p', seconds: 5 })).toBe(19);
    expect(creditsFor(s, { resolution: '720p', seconds: 15 })).toBe(24);
    expect(creditsFor(m('alibaba/wan3.0'), { resolution: '1080p', seconds: 30 })).toBe(40);
    expect(creditsFor(m('minimax/minimax-h3'), { resolution: '2K', seconds: 5 })).toBe(5);
  });

  it('prices images per image, at least one credit', () => {
    expect(creditsFor(m('bytedance/seedream-5.0-lite'))).toBe(1);
    expect(creditsFor(m('qwen/qwen-image-2.0'), { n: 6 })).toBe(2);
    expect(
      creditsForAll([
        { model: m('bytedance/seedream-5.0-lite') },
        { model: m('bytedance/seedance-2.5'), request: { resolution: '720p', seconds: 5 } },
      ]),
    ).toBe(9);
  });

  it('rounds float noise before the ceiling', () => {
    expect(creditsForUsd(1.2)).toBe(8);
    expect(creditsForUsd(0)).toBe(0);
    expect(() => creditsForUsd(-1)).toThrow(RangeError);
  });

  it('refuses unpriceable requests and bad inputs', () => {
    expect(() => creditsFor(m('bytedance/seedance-2.5'), { resolution: '4K', seconds: 5 })).toThrow(UnpricedModelError);
    expect(() => creditsFor(m('deepseek/deepseek-v4.1-flash'))).toThrow(UnpricedModelError);
    expect(() => creditsFor(m('bytedance/seedance-2.5'), { seconds: 0 })).toThrow(RangeError);
    expect(() => creditsFor(m('bytedance/seedream-5.0-lite'), { n: 1.5 })).toThrow(RangeError);
  });
});
