import { describe, expect, it } from 'vitest';
import { gateFromAllowance } from './agentGate';

const member = { plan: 'plus' as const, allowanceUsd: 3.5, usedUsd: 1, resetsAt: 0, models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek', unlimited: true as const }] };
const trial = { plan: null, allowanceUsd: 0.05, usedUsd: 0.01, resetsAt: 0, trial: true, models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek', unlimited: false as const, estTurnUsd: 0.001, turnsLeft: 40 }] };

describe('Home agent gate (D-038, D-007, D-022)', () => {
  it('no plan and no trial: the join paywall', () => {
    expect(gateFromAllowance(null, null)).toBe('join');
  });

  it('members go through with any model', () => {
    expect(gateFromAllowance(member, 'claude-sonnet-5.5')).toBe('ok');
    expect(gateFromAllowance(member, null)).toBe('ok');
  });

  it('a trial keeps its limits: its one model, within its allowance', () => {
    expect(gateFromAllowance(trial, null)).toBe('ok');
    expect(gateFromAllowance(trial, 'deepseek-v4.1-flash')).toBe('ok');
    expect(gateFromAllowance(trial, 'claude-sonnet-5.5')).toBe('trial-agent');
    expect(gateFromAllowance({ ...trial, usedUsd: 0.05 }, null)).toBe('trial-agent');
  });
});
