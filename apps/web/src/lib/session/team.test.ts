import { beforeEach, describe, expect, it, vi } from 'vitest';

function stub(mocks: Record<string, unknown> = {}) {
  vi.stubGlobal('window', { __rollingMocks: { latencyMs: 0, ...mocks }, location: { search: '' }, localStorage: { getItem: () => null, setItem: () => {} } });
}

describe('lib/session Team (D-013)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('personal plans have one seat; switching to Team sets seats and Team credits', async () => {
    stub();
    const s = await import('./index');
    expect(s.getSession()).toMatchObject({ planId: 'pro', seats: 1, isTeam: false });
    await expect(s.changeSeats(3, 1)).rejects.toMatchObject({ code: 'TEAM_REQUIRED' });
    await s.checkoutPlan('team', 'monthly', 3);
    expect(s.getSession()).toMatchObject({ planId: 'team', seats: 3, isTeam: true });
    expect(s.getCredits().plan).toBe(3500);
  });

  it('adding seats grants prorated credits once; lowering below used is refused', async () => {
    stub({ me: { plan: { id: 'team', period: 'monthly', status: 'active', seats: 2 } } });
    const s = await import('./index');
    const before = s.getCredits().plan;
    const r = await s.changeSeats(4, 2);
    expect(r).toMatchObject({ seats: 4, previous: 2 });
    expect(r.granted).toBeGreaterThan(0);
    expect(r.granted).toBeLessThanOrEqual(1000);
    expect(s.getCredits().plan).toBe(before + r.granted);
    expect((await s.changeSeats(3, 2)).granted).toBe(0);
    expect((await s.changeSeats(4, 2)).granted).toBe(0);
    await expect(s.changeSeats(1, 2)).rejects.toMatchObject({ code: 'SEATS_IN_USE' });
    expect(s.getSession().seats).toBe(4);
  });
});
