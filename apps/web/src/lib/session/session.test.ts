import { afterEach, describe, expect, it } from 'vitest';
import { checkoutPlan, getSession, resetSessionForTests } from './index';

describe('lib/session (mock)', () => {
  afterEach(() => resetSessionForTests());

  it('defaults to an active Pro member with mature content allowed', () => {
    const s = getSession();
    expect(s).toMatchObject({ planId: 'pro', isMember: true, matureAllowed: true });
  });

  it('checkout makes the workspace a member of the chosen plan; unknown ids fall back to the default plan', async () => {
    expect((await checkoutPlan('starter')).planId).toBe('starter');
    expect((await checkoutPlan('studio')).planId).toBe('pro');
  });
});
