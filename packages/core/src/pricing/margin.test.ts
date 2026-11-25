import { describe, expect, it } from 'vitest';
import { computeMarginReport, creditCostUsd, monthlySubscriptionUsd } from './margin';

describe('monthly margin report', () => {
  it('prices subscriptions per month (yearly ÷ 12, Team by seats) and credits at gateway cost', () => {
    expect(monthlySubscriptionUsd({ plan: 'plus', interval: 'month', seats: 1 })).toBe(15);
    expect(monthlySubscriptionUsd({ plan: 'plus', interval: 'year', seats: 1 })).toBe(12);
    expect(monthlySubscriptionUsd({ plan: 'team', interval: 'month', seats: 3 })).toBe(129);
    expect(creditCostUsd(300)).toBeCloseTo(1, 9);
  });

  it('computes per-plan gross margin and flags plans under the floor (50%, Team 60%)', () => {
    const rows = computeMarginReport({
      subscriptions: [
        { workspaceId: 'w1', plan: 'plus', interval: 'month', seats: 1 },
        { workspaceId: 'w2', plan: 'team', interval: 'month', seats: 1 },
        { workspaceId: 'w3', plan: 'starter', interval: 'year', seats: 1 },
      ],
      topUps: [{ workspaceId: 'w1', amountCents: 1000 }, { workspaceId: 'w9', amountCents: 2500 }],
      creditsConsumed: [
        { workspaceId: 'w1', credits: 900 },
        { workspaceId: 'w2', credits: 2500 },
        { workspaceId: 'w3', credits: 200 },
      ],
      agentUsd: [{ workspaceId: 'w2', usd: 12.5 }, { workspaceId: 'w3', usd: 1.2 }],
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(rows.map((r) => r.key)).toEqual(['starter/year', 'plus/month', 'team/month', 'none']);
    // Plus: $25 revenue, $3 credits, fees 4.65% + 2 × $0.30, 2% infra.
    expect(by['plus/month']).toMatchObject({ revenueUsd: 25, creditCostUsd: 3, cardFeesUsd: 1.76, infraUsd: 0.5, belowFloor: false });
    expect(by['plus/month']!.margin).toBeCloseTo((25 - 3 - 1.7625 - 0.5) / 25, 2);
    // Team worst case (all credits and allowance used) ≈ 66.6% ≥ 60% (D-013).
    expect(by['team/month']!.margin).toBeCloseTo(0.666, 2);
    expect(by['team/month']!.floor).toBe(0.6);
    // Starter yearly worst case dips below 50% (accepted with monitoring, D-012).
    expect(by['starter/year']!.belowFloor).toBe(true);
    // Top-ups of workspaces without a plan.
    expect(by['none']).toMatchObject({ revenueUsd: 25, workspaces: 1 });
  });
});
