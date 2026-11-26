import { beforeEach, describe, expect, it, vi } from 'vitest';

function stub(mocks: Record<string, unknown> = {}) {
  vi.stubGlobal('window', { __rollingMocks: { latencyMs: 0, ...mocks }, location: { search: '' }, localStorage: { getItem: () => null, setItem: () => {} } });
}

/** A fresh session module graph (after `vi.resetModules`) with its mock data loaded, like the app entry. */
async function freshSession() {
  const s = await import('./index');
  await (await import('@/lib/api/mode')).loadMockData();
  return s;
}

describe('lib/session mock flows', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('top-up checkout adds the quoted credits (bonus included) to purchased credits', async () => {
    stub();
    const s = await freshSession();
    const before = s.getCredits().available;
    const r = await s.checkoutTopUp(25);
    expect(r.credits).toBe(2850); // Pro: +4% tier, +10% plan
    expect(s.getCredits().available).toBe(before + 2850);
    expect(s.getCredits().purchased).toBe(680 + 2850);
  });

  it('top-up is members only and can fail', async () => {
    stub({ me: { plan: null } });
    const s = await freshSession();
    await expect(s.checkoutTopUp(10)).rejects.toMatchObject({ code: 'NO_PLAN' });
    vi.resetModules();
    stub({ checkout: 'fail' });
    const t = await freshSession();
    await expect(t.checkoutTopUp(10)).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(t.getCredits().available).toBe(2480);
  });

  it('plan checkout makes a non-member a member and grants the plan credits', async () => {
    stub({ me: { plan: null } });
    const s = await freshSession();
    expect(s.getSession().isMember).toBe(false);
    await s.checkoutPlan('plus');
    expect(s.getSession()).toMatchObject({ isMember: true, planId: 'plus' });
    expect(s.getCredits().available).toBe(2480 + 800);
  });

  it('a run holds, then settles from plan credits first; a failed run is refunded', async () => {
    stub();
    const s = await freshSession();
    const p = s.startMockRun(100);
    expect(s.getCredits()).toMatchObject({ available: 2380, held: 116 });
    await p;
    expect(s.getCredits()).toMatchObject({ available: 2380, held: 16, plan: 1700, usedThisMonth: 1384 });
    vi.resetModules();
    stub({ run: 'fail' });
    const t = await freshSession();
    await expect(t.startMockRun(100)).rejects.toMatchObject({ code: 'RUN_FAILED' });
    expect(t.getCredits()).toMatchObject({ available: 2480, held: 16 });
    await expect(t.startMockRun(99999)).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });
});
