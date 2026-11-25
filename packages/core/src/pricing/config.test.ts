import { describe, expect, it } from 'vitest';
import { fixtureModel as m } from '../models/__fixtures__/catalog';
import {
  AGENT_ALLOWANCE_USD,
  creditsFor,
  creditsForAll,
  creditsForUsd,
  DEFAULT_CONFIRM_THRESHOLD_CREDITS,
  MARKUP,
  PLANS,
  AUTO_TOP_UP,
  PLAN_ORDER,
  lowestPlanFor,
  planAllowsResolution,
  quoteTopUp,
  resolutionRank,
  TopUpAmountError,
  TOP_UP,
  UnpricedModelError,
  USD_PER_CREDIT,
} from './config';

describe('pricing model (D-006)', () => {
  const cardFee = (amount: number) => (amount * 0.0465 + 0.3) / amount;
  const INFRA = 0.02;
  const costPerCredit = USD_PER_CREDIT / MARKUP;
  const margin = (revenue: number, credits: number) => 1 - (costPerCredit * credits) / revenue - cardFee(revenue) - INFRA;

  it('ships Starter, Plus and Pro as entry tickets', () => {
    expect(PLAN_ORDER).toEqual(['starter', 'plus', 'pro']);
    expect(PLANS.starter).toMatchObject({ label: 'Starter', monthlyCredits: 200, priceMonthlyUsd: 5, priceYearlyUsd: 48, topUpBonus: 0 });
    expect(PLANS.plus).toMatchObject({ label: 'Plus', monthlyCredits: 800, priceMonthlyUsd: 15, topUpBonus: 0.05 });
    expect(PLANS.pro).toMatchObject({ label: 'Pro', monthlyCredits: 2500, priceMonthlyUsd: 49, topUpBonus: 0.1, seats: 10 });
    expect(MARKUP).toBe(3);
    expect(USD_PER_CREDIT).toBe(0.01);
    expect(DEFAULT_CONFIRM_THRESHOLD_CREDITS).toBe(300);
    expect(AUTO_TOP_UP.amountUsd).toBe(10);
  });

  it('caps output resolution per plan: Starter 720p, Plus 1080p, Pro 4K video', () => {
    expect(PLANS.starter.maxVideoResolution).toBe('720p');
    expect(PLANS.plus.maxVideoResolution).toBe('1080p');
    expect(PLANS.pro.maxVideoResolution).toBe('4K');
    expect(planAllowsResolution('starter', 'video', '480p')).toBe(true);
    expect(planAllowsResolution('starter', 'video', '720p')).toBe(true);
    expect(planAllowsResolution('starter', 'video', '768p')).toBe(false);
    expect(planAllowsResolution('starter', 'video', '1080p')).toBe(false);
    expect(planAllowsResolution('plus', 'video', '1080p')).toBe(true);
    expect(planAllowsResolution('plus', 'video', '2K')).toBe(false);
    expect(planAllowsResolution('pro', 'video', '4K')).toBe(true);
    expect(planAllowsResolution('plus', 'image', '2K')).toBe(true);
    expect(planAllowsResolution('plus', 'image', '4K')).toBe(false);
    expect(planAllowsResolution('pro', 'video', 'weird')).toBe(false);
    expect(lowestPlanFor('video', '1080p')).toBe('plus');
    expect(lowestPlanFor('video', '2K')).toBe('pro');
    expect(lowestPlanFor('image', '4K')).toBe('pro');
    expect(resolutionRank('768p')).toBe(768);
  });

  it('quotes any top-up amount with tier and plan bonuses', () => {
    expect(quoteTopUp(1000, 'starter')).toMatchObject({ baseCredits: 1000, bonusCredits: 0, credits: 1000 });
    expect(quoteTopUp(2499, 'starter').credits).toBe(2499);
    expect(quoteTopUp(2500, 'starter').credits).toBe(2600);
    expect(quoteTopUp(3733, 'plus')).toMatchObject({ baseCredits: 3733, tierBonus: 0.04, planBonus: 0.05, credits: 3733 + 335 });
    expect(quoteTopUp(10000, 'pro')).toMatchObject({ tierBonus: 0.15, planBonus: 0.1, credits: 12500 });
  });

  it('rejects amounts outside 10..10,000 USD or not in whole cents', () => {
    expect(() => quoteTopUp(999, 'starter')).toThrow(TopUpAmountError);
    expect(() => quoteTopUp(1_000_001, 'pro')).toThrow(TopUpAmountError);
    expect(() => quoteTopUp(1000.5, 'pro')).toThrow(TopUpAmountError);
  });

  it('keeps gross margin >= 50% for every top-up amount and plan, all credits used', () => {
    const amounts = new Set<number>();
    for (let c = 1000; c <= 1_000_000; c += c < 20000 ? 1 : 997) amounts.add(c);
    for (const t of TOP_UP.tiers) amounts.add(t.minUsd * 100);
    amounts.add(1_000_000);
    for (const plan of PLAN_ORDER) {
      for (const cents of amounts) {
        const q = quoteTopUp(cents, plan);
        expect(margin(cents / 100, q.credits)).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('keeps gross margin >= 50% on every plan, monthly and yearly, all credits used', () => {
    for (const plan of Object.values(PLANS)) {
      expect(margin(plan.priceMonthlyUsd as number, plan.monthlyCredits)).toBeGreaterThanOrEqual(0.5);
      expect(margin(plan.priceYearlyUsd as number, plan.monthlyCredits * 12)).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('keeps plan gross margin >= 50% with the whole agent allowance used (D-012)', () => {
    expect(AGENT_ALLOWANCE_USD).toEqual({ starter: 1.2, plus: 3.5, pro: 12.5 });
    for (const plan of Object.values(PLANS)) {
      const price = plan.priceMonthlyUsd as number;
      const cost = costPerCredit * plan.monthlyCredits + price * cardFee(price) + price * INFRA + AGENT_ALLOWANCE_USD[plan.id];
      expect(price * 0.5).toBeGreaterThanOrEqual(cost);
      expect(margin(price, plan.monthlyCredits) - AGENT_ALLOWANCE_USD[plan.id] / price).toBeGreaterThanOrEqual(0.5);
    }
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
