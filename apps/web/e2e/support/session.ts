import type { Page } from '@playwright/test';

/**
 * Seeds the mock session (apps/web/src/lib/session) before the app loads:
 * a plan id for an active member of that plan, or null for a signed-up
 * non-member. The app defaults to an active Pro member.
 */
export async function asPlan(page: Page, plan: 'starter' | 'plus' | 'pro' | 'team' | null, seats?: number) {
  await page.addInitScript(
    ([p, n]) => {
      const w = window as unknown as { __rollingMocks?: { me?: Record<string, unknown> } };
      w.__rollingMocks = { ...w.__rollingMocks, me: { ...w.__rollingMocks?.me, plan: p ? { id: p, period: 'monthly', status: 'active', ...(n ? { seats: n } : {}) } : null } };
    },
    [plan, seats ?? null] as const,
  );
}
