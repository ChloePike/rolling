import { describe, expect, it } from 'vitest';
import { fixtureModel as m } from '../models/__fixtures__/catalog';
import {
  creditsFor,
  creditsForAll,
  creditsForUsd,
  DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  MARKUP,
  PLANS,
  CREDIT_PACKS,
  packPriceCents,
  UnpricedModelError,
  USD_PER_CREDIT,
} from './config';

describe('pricing model (D-006)', () => {
  const cardFee = (amount: number) => (amount * 0.0465 + 0.3) / amount;
  const INFRA = 0.02;
  const costPerCredit = USD_PER_CREDIT / MARKUP;
  const margin = (revenue: number, credits: number) => 1 - (costPerCredit * credits) / revenue - cardFee(revenue) - INFRA;

  it('ships entry-ticket plans and tiered packs', () => {
    expect(PLANS.starter).toMatchObject({ monthlyCredits: 200, priceMonthlyUsd: 5, priceYearlyUsd: 48, packDiscount: 0 });
    expect(PLANS.pro).toMatchObject({ monthlyCredits: 800, priceMonthlyUsd: 15, packDiscount: 0.05 });
    expect(PLANS.studio).toMatchObject({ monthlyCredits: 2500, priceMonthlyUsd: 49, packDiscount: 0.1, seats: 10 });
    expect(CREDIT_PACKS.map((p) => p.priceUsd)).toEqual([10, 25, 50, 100, 250]);
    expect(MARKUP).toBe(3);
    expect(USD_PER_CREDIT).toBe(0.01);
    expect(DEFAULT_CONFIRM_THRESHOLD_CREDITS).toBe(300);
  });

  it('keeps gross margin >= 50% on every pack at every member discount, all credits used', () => {
    for (const pack of CREDIT_PACKS) {
      for (const plan of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
        expect(margin(packPriceCents(pack, plan) / 100, pack.credits)).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('keeps gross margin >= 50% on every plan, monthly and yearly, all credits used', () => {
    for (const plan of Object.values(PLANS)) {
      expect(margin(plan.priceMonthlyUsd as number, plan.monthlyCredits)).toBeGreaterThanOrEqual(0.5);
      expect(margin(plan.priceYearlyUsd as number, plan.monthlyCredits * 12)).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('prices packs for members with their plan discount', () => {
    const pack = CREDIT_PACKS[1]!;
    expect(packPriceCents(pack, 'starter')).toBe(2500);
    expect(packPriceCents(pack, 'pro')).toBe(2375);
    expect(packPriceCents(pack, 'studio')).toBe(2250);
  });
});

describe('creditsFor follows live cost (D-002)', () => {
  it('prices Seedance 2.5, 720p, 5 s at 347 credits ($1.1556 × 3 ÷ $0.01)', () => {
    expect(creditsFor(m('bytedance/seedance-2.5'), { resolution: '720p', seconds: 5 })).toBe(347);
  });

  it('prices per resolution and length', () => {
    const s = m('bytedance/seedance-2.5');
    expect(creditsFor(s, { resolution: '480p', seconds: 5 })).toBe(162);
    expect(creditsFor(s, { resolution: '1080p', seconds: 5 })).toBe(853);
    expect(creditsFor(s, { resolution: '720p', seconds: 15 })).toBe(1041);
    expect(creditsFor(m('alibaba/wan3.0'), { resolution: '1080p', seconds: 30 })).toBe(1800);
    expect(creditsFor(m('minimax/minimax-h3'), { resolution: '2K', seconds: 5 })).toBe(195);
  });

  it('prices images per image', () => {
    expect(creditsFor(m('bytedance/seedream-5.0-lite'))).toBe(11);
    expect(creditsFor(m('qwen/qwen-image-2.0'), { n: 6 })).toBe(63);
    expect(
      creditsForAll([
        { model: m('bytedance/seedream-5.0-lite') },
        { model: m('bytedance/seedance-2.5'), request: { resolution: '720p', seconds: 5 } },
      ]),
    ).toBe(358);
  });

  it('rounds float noise before the ceiling', () => {
    expect(creditsForUsd(1.2)).toBe(360);
    expect(creditsForUsd(0.07)).toBe(21);
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
