import { describe, expect, it } from 'vitest';
import { isUnlockedBy, lowestPlanForModel, offeredPlans, preselectedPlan, requiredPlan, teamSeatsFor, upgradeVariant, type UpgradeReason } from './reasons';

describe('upgrade reasons → plans (pricing config)', () => {
  it('resolutions map to the lowest plan whose cap covers them (lowestPlanFor)', () => {
    expect(requiredPlan({ kind: 'resolution', value: '720p' })).toBe('starter');
    expect(requiredPlan({ kind: 'resolution', value: '768p' })).toBe('plus');
    expect(requiredPlan({ kind: 'resolution', value: '1080p' })).toBe('plus');
    expect(requiredPlan({ kind: 'resolution', value: '4K' })).toBe('pro');
    expect(requiredPlan({ kind: 'resolution', value: '2K' })).toBe('starter');
    expect(requiredPlan({ kind: 'resolution', value: '4K', media: 'image' })).toBe('pro');
  });

  it('models use their smallest resolution, or an explicit plan', () => {
    expect(lowestPlanForModel({ resolutions: ['1080p', '4K'] })).toBe('plus');
    expect(lowestPlanForModel({ resolutions: ['480p', '1080p'] })).toBe('starter');
    expect(requiredPlan({ kind: 'model', id: 'm', resolutions: ['4K'] })).toBe('pro');
    expect(requiredPlan({ kind: 'model', id: 'm', plan: 'plus' })).toBe('plus');
  });

  it('count, voice cloning, membership and team', () => {
    expect(requiredPlan({ kind: 'count', value: 2 })).toBe('starter');
    expect(requiredPlan({ kind: 'count', value: 4 })).toBe('plus');
    expect(requiredPlan({ kind: 'count', value: 8 })).toBe('pro');
    expect(requiredPlan({ kind: 'voice-clone' })).toBe('plus');
    for (const kind of ['agent', 'generate', 'mature', 'top-up', 'auto-top-up'] as const) expect(requiredPlan({ kind } as UpgradeReason)).toBe('starter');
    expect(requiredPlan({ kind: 'team-invite' })).toBe('team');
  });

  it('preselects the lowest offered plan above the current one', () => {
    const r: UpgradeReason = { kind: 'resolution', value: '1080p' };
    expect(preselectedPlan(r, null)).toBe('plus');
    expect(preselectedPlan(r, 'starter')).toBe('plus');
    expect(offeredPlans(r, 'starter')).toEqual(['plus', 'pro']);
    expect(preselectedPlan({ kind: 'resolution', value: '4K' }, 'starter')).toBe('pro');
    expect(preselectedPlan({ kind: 'agent' }, null)).toBe('starter');
    expect(offeredPlans({ kind: 'agent' }, null)).toEqual(['starter', 'plus', 'pro']);
    // Nothing personal is above Pro: Team.
    expect(offeredPlans({ kind: 'plan' }, 'pro')).toEqual([]);
    expect(upgradeVariant({ kind: 'plan' }, 'pro')).toBe('team');
  });

  it('variants and unlock checks', () => {
    expect(upgradeVariant({ kind: 'team-invite' }, 'plus')).toBe('team');
    expect(upgradeVariant({ kind: 'top-up' }, 'plus')).toBe('topUp');
    expect(upgradeVariant({ kind: 'top-up' }, null)).toBe('personal');
    expect(upgradeVariant({ kind: 'resolution', value: '1080p' }, 'starter')).toBe('personal');
    expect(isUnlockedBy({ kind: 'resolution', value: '1080p' }, 'plus')).toBe(true);
    expect(isUnlockedBy({ kind: 'resolution', value: '1080p' }, 'starter')).toBe(false);
    expect(isUnlockedBy({ kind: 'resolution', value: '4K' }, 'team')).toBe(true);
    expect(isUnlockedBy({ kind: 'agent' }, null)).toBe(false);
    expect(isUnlockedBy({ kind: 'team-invite' }, 'pro')).toBe(false);
    expect(isUnlockedBy({ kind: 'team-invite' }, 'team')).toBe(true);
  });

  it('team seats start at everyone already in plus the invitee', () => {
    expect(teamSeatsFor({ kind: 'team-invite' })).toEqual({ seats: 2, min: 1 });
    expect(teamSeatsFor({ kind: 'team-invite', minSeats: 4 })).toEqual({ seats: 5, min: 4 });
    expect(teamSeatsFor({ kind: 'team-invite', minSeats: 4, seats: 2 })).toEqual({ seats: 4, min: 4 });
  });
});
