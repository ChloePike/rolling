import { expect, test, type Page } from '@playwright/test';

/** The one-time trial (D-022) on the mocks: a non-member with trial credits. */

async function asTrial(page: Page, status: 'active' | 'used' | 'expired', remaining: number, skipFirstRun = true) {
  await page.addInitScript(
    ([s, r, skip]) => {
      const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
      const expiresAt = Date.now() + 10 * 86_400_000;
      w.__rollingMocks = {
        ...w.__rollingMocks,
        latencyMs: 100,
        me: { plan: null, trial: { status: s, credits: 120, remaining: r, expiresAt } },
        credits: { available: r, trial: r, plan: 0, purchased: 0, held: 0, usedThisMonth: 0, expiringThisMonth: 0 },
      };
      if (skip) window.localStorage.setItem('rolling.firstRun.usr_alex', 'skipped');
    },
    [status, remaining, skipFirstRun] as const,
  );
}

test('trial user: Trial chip in the header, summary in the credits popover', async ({ page }) => {
  await asTrial(page, 'active', 64);
  await page.goto('/');
  await expect(page.getByTestId('trial-chip')).toBeVisible();
  await page.getByTestId('app-header').getByRole('button', { name: /64/ }).click();
  await expect(page.getByTestId('trial-summary')).toContainText('64 of 120 trial credits left');
});

test('used-up trial: See plans opens “Your trial credits are used up”', async ({ page }) => {
  await asTrial(page, 'used', 0);
  await page.goto('/');
  await expect(page.getByTestId('trial-chip')).toHaveAttribute('data-status', 'used');
  await page.getByTestId('app-header').locator('[data-credits-trigger]').click();
  await page.getByTestId('trial-summary').getByRole('button', { name: 'See plans' }).click();
  await expect(page.getByRole('dialog', { name: 'Your trial credits are used up' })).toBeVisible();
});

test('first-run opens for a new trial user and Skip is remembered', async ({ page }) => {
  await asTrial(page, 'active', 120, false);
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'What do you make?' })).toBeVisible();
  await page.getByTestId('first-run-skip').click();
  await page.reload();
  await expect(page.getByTestId('app-header')).toBeVisible();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
});

test('members never see the trial chip or the first-run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-header')).toBeVisible();
  await expect(page.getByTestId('trial-chip')).toHaveCount(0);
  await expect(page.getByTestId('first-run')).toHaveCount(0);
});
