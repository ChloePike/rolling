import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@/lib/api/types';

const ME: MeResponse = {
  user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada', image: null, emailVerified: true },
  workspace: { id: 'ws_t', name: 'Studio', kind: 'team', matureAllowed: true },
  role: 'owner',
  monthlyCreditLimit: null,
  workspaces: [
    { id: 'ws_p', name: 'Personal', kind: 'personal', role: 'owner', plan: null },
    { id: 'ws_t', name: 'Studio', kind: 'team', role: 'owner', plan: 'team' },
  ],
  prefs: { language: 'en', currency: 'EUR', creationMode: 'advanced', defaultRatio: '16:9', defaultModel: 'auto', confirmThreshold: 100, notifications: { done: false, low: true, renewal: true, product: true }, theme: 'dark', matureContent: true },
  plan: { id: 'team', label: 'Team', interval: 'year', status: 'active', currentPeriodEnd: 1_800_000_000_000, cancelAtPeriodEnd: true, perks: { monthlyCredits: 3500, topUpBonus: 0.1, concurrentJobs: 14, maxVideoResolution: '4K', maxImageResolution: '4K', voiceCloning: true, seats: 3 } },
  isMember: true,
  matureAllowed: true,
  balance: { plan: 900, purchased: 100, held: 40, planExpiresAt: 1_800_000_000_000 },
};

describe('lib/session real mapping', () => {
  it('maps /api/me to the session and the balance to credits', async () => {
    vi.stubGlobal('window', undefined);
    const { sessionFromMe, creditsFromBalance } = await import('./real');
    const s = sessionFromMe(ME);
    expect(s).toMatchObject({ status: 'signedIn', planId: 'team', isTeam: true, seats: 3, isMember: true, matureAllowed: true, role: 'owner' });
    expect(s.plan).toMatchObject({ period: 'yearly', cancelAtPeriodEnd: true, label: 'Team' });
    expect(s.workspaces).toHaveLength(2);
    expect(sessionFromMe({ ...ME, isMember: false, plan: null }).planId).toBeNull();
    const c = creditsFromBalance(ME.balance, ME);
    expect(c).toMatchObject({ available: 1000, plan: 900, purchased: 100, held: 40, expiringThisMonth: 900 });
    expect(c.planExpires.getTime()).toBe(1_800_000_000_000);
    vi.unstubAllGlobals();
  });
});

describe('lib/session guard', () => {
  it('public paths and safe redirects', async () => {
    const { isPublicPath, safeRedirect } = await import('./guard');
    for (const p of ['/login', '/signup', '/share/shr_1', '/invite/abc', '/upgrade']) expect(isPublicPath(p)).toBe(true);
    for (const p of ['/', '/settings/billing', '/p/prj_1', '/share', '/u/ada']) expect(isPublicPath(p)).toBe(false);
    expect(safeRedirect('/settings/team?resume=invite')).toBe('/settings/team?resume=invite');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect('/login?redirect=/x')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
  });
});

describe('lib/session agent allowance', () => {
  it('unlimited (DeepSeek) models show no count and do not count toward exhausted', async () => {
    const { fromAllowanceView, withHelpers, mockAgentAllowance } = await import('./agentAllowance');
    const a = withHelpers(
      fromAllowanceView({
        plan: 'starter',
        allowanceUsd: 1.2,
        usedUsd: 1.2,
        resetsAt: 1,
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', unlimited: true },
          { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', unlimited: false, estTurnUsd: 0.064, turnsLeft: 0 },
        ],
      }),
    );
    expect(a.turnsLeftFor('deepseek-v4.1-flash')).toBeNull();
    expect(a.isUnlimited('deepseek-v4.1-flash')).toBe(true);
    expect(a.turnsLeftFor('claude-opus-5.5')).toBe(0);
    expect(a.exhausted).toBe(true);
    const m = withHelpers(mockAgentAllowance('starter', Date.UTC(2026, 10, 25)));
    expect(m.turnsLeftFor('deepseek-v4.1-flash')).toBeNull();
    expect(m.turnsLeftFor('claude-opus-5.5')).toBe(18);
    expect(m.exhausted).toBe(false);
  });
});
