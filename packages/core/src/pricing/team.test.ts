import { describe, expect, it } from 'vitest';
import {
  AGENT_ALLOWANCE_USD,
  MARKUP,
  PERSONAL_PLAN_ORDER,
  PLANS,
  planAgentAllowanceUsd,
  planConcurrentJobs,
  planMonthlyCredits,
  prorate,
  quoteTopUp,
  SEAT_PRICE,
  TEAM_SEATS,
  teamAgentAllowanceUsd,
  teamConcurrentJobs,
  teamIncludedCredits,
  teamPriceCents,
  USD_PER_CREDIT,
} from './config';

/**
 * Team plan (D-013). Worst case: every included credit and the whole agent
 * allowance used, card fees 4.65% + $0.30 per charge, 2% infrastructure.
 */
const costPerCredit = USD_PER_CREDIT / MARKUP;
const INFRA = 0.02;
const worstMargin = (revenue: number, credits: number, allowanceUsd: number) =>
  1 - (costPerCredit * credits + allowanceUsd + revenue * 0.0465 + 0.3 + revenue * INFRA) / revenue;

describe('Team plan (D-013)', () => {
  it('prices Team at $79/mo or $758/yr with one included seat and Pro perks', () => {
    expect(PLANS.team).toMatchObject({
      kind: 'team',
      label: 'Team',
      priceMonthlyUsd: 79,
      priceYearlyUsd: 758,
      monthlyCredits: 2500,
      topUpBonus: 0.1,
      concurrentJobs: 10,
      maxVideoResolution: '4K',
      maxImageResolution: '4K',
      voiceCloning: true,
      seats: 1,
    });
    expect(SEAT_PRICE).toMatchObject({ priceMonthlyUsd: 25, priceYearlyUsd: 240, monthlyCredits: 500, concurrentJobs: 2, maxConcurrentJobs: 30, agentAllowanceUsd: 3 });
    expect(AGENT_ALLOWANCE_USD.team).toBe(12.5);
    expect(quoteTopUp(10000, 'team')).toMatchObject({ planBonus: 0.1, credits: 12500 });
  });

  it('makes personal plans one seat each', () => {
    expect(PERSONAL_PLAN_ORDER).toEqual(['starter', 'plus', 'pro']);
    for (const id of PERSONAL_PLAN_ORDER) expect(PLANS[id].seats).toBe(1);
  });

  it('adds 500 credits, 2 jobs (max 30) and $3 agent allowance per extra seat', () => {
    expect(teamIncludedCredits(1)).toBe(2500);
    expect(teamIncludedCredits(4)).toBe(4000);
    expect(teamConcurrentJobs(1)).toBe(10);
    expect(teamConcurrentJobs(5)).toBe(18);
    expect(teamConcurrentJobs(11)).toBe(30);
    expect(teamConcurrentJobs(50)).toBe(30);
    expect(teamAgentAllowanceUsd(1)).toBe(12.5);
    expect(teamAgentAllowanceUsd(3)).toBe(18.5);
    expect(teamPriceCents(1, 'month')).toBe(7900);
    expect(teamPriceCents(3, 'month')).toBe(12900);
    expect(teamPriceCents(3, 'year')).toBe(75800 + 2 * 24000);
    for (const bad of [0, 1.5, TEAM_SEATS.max + 1]) expect(() => teamIncludedCredits(bad)).toThrow(RangeError);
  });

  it('plan helpers use seats only for Team', () => {
    expect(planMonthlyCredits('pro', 5)).toBe(2500);
    expect(planMonthlyCredits('team', 5)).toBe(4500);
    expect(planConcurrentJobs('plus', 9)).toBe(5);
    expect(planConcurrentJobs('team', 3)).toBe(14);
    expect(planConcurrentJobs('team', null)).toBe(10);
    expect(planAgentAllowanceUsd('starter', 4)).toBe(1.2);
    expect(planAgentAllowanceUsd('team', 2)).toBe(15.5);
  });

  it('keeps the Team base at >= 60% gross margin worst case, monthly and yearly', () => {
    expect(worstMargin(79, 2500, 12.5)).toBeGreaterThanOrEqual(0.6);
    expect(worstMargin(758, 2500 * 12, 12.5 * 12)).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps every additional seat at >= 60% gross margin worst case, monthly and yearly', () => {
    const s = SEAT_PRICE;
    // A seat on its own (its own $0.30 fixed fee counted, the strictest case).
    expect(worstMargin(s.priceMonthlyUsd, s.monthlyCredits, s.agentAllowanceUsd)).toBeGreaterThanOrEqual(0.6);
    expect(worstMargin(s.priceYearlyUsd, s.monthlyCredits * 12, s.agentAllowanceUsd * 12)).toBeGreaterThanOrEqual(0.6);
    // And every whole team size, billed as one charge.
    for (let seats = 1; seats <= TEAM_SEATS.max; seats++) {
      const month = teamPriceCents(seats, 'month') / 100;
      const year = teamPriceCents(seats, 'year') / 100;
      expect(worstMargin(month, teamIncludedCredits(seats), teamAgentAllowanceUsd(seats))).toBeGreaterThanOrEqual(0.6);
      expect(worstMargin(year, teamIncludedCredits(seats) * 12, teamAgentAllowanceUsd(seats) * 12)).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('prorates the rest of a period, rounding down', () => {
    expect(prorate(500, 0, 100, 0)).toBe(500);
    expect(prorate(500, 0, 100, 50)).toBe(250);
    expect(prorate(500, 0, 100, 99)).toBe(5);
    expect(prorate(500, 0, 100, 100)).toBe(0);
    expect(prorate(1000, 0, 3, 1)).toBe(666);
  });
});
