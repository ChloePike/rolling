import { expect, test, type Page } from '@playwright/test';
import { ME, stubApi } from './support';

/**
 * The one-time trial (D-022) against a stubbed real API: `/api/me` reports a
 * non-member on a trial. Header chip and credits, the popover and Settings
 * show the trial; the first-run opens once on Home and is remembered.
 */

const DAY = 86_400_000;
const ENDS = Date.UTC(2026, 11, 11, 12, 0);

function trialMe(status: 'active' | 'used' | 'expired', remaining: number) {
  return {
    ...ME,
    workspaces: [{ ...ME.workspaces[0], plan: null }],
    plan: null,
    isMember: false,
    balance: { plan: 0, purchased: 0, held: 0, planExpiresAt: null },
    trial: { status, credits: 120, remaining, expiresAt: status === 'expired' ? ENDS - 30 * DAY : ENDS, agentAllowanceUsd: 0.05, agentUsedUsd: 0.01 },
  };
}

async function asTrial(page: Page, status: 'active' | 'used' | 'expired' = 'active', remaining = 108, opts: { skipFirstRun?: boolean } = {}) {
  await stubApi(page, { delayMs: 50 });
  // Registered after stubApi, so it answers first.
  await page.route(/\/api\/me$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trialMe(status, remaining)) }));
  await page.route(/\/api\/billing\/ledger/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lines: [], pageInfo: { hasNextPage: false, endCursor: null } }) }));
  // No subscription behind a trial.
  await page.route(/\/api\/billing$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan: null, interval: null, status: null, renewsAt: null, cancelAtPeriodEnd: false, periodEnd: null, periodStart: null, balance: trialMe(status, remaining).balance, autoTopUp: null, seats: null }) }),
  );
  if (opts.skipFirstRun) await page.addInitScript(() => window.localStorage.setItem('rolling.firstRun.usr_stub', 'skipped'));
}

test('header shows the Trial chip with what is left; the popover and Settings show the trial', async ({ page }) => {
  await asTrial(page, 'active', 108, { skipFirstRun: true });
  await page.goto('/');
  const header = page.getByTestId('app-header');
  await expect(header.getByTestId('trial-chip')).toHaveText(/Trial/);
  await expect(header.getByTestId('trial-chip')).toHaveAttribute('data-status', 'active');
  const credits = header.getByRole('button', { name: /108/ });
  await expect(credits).toBeVisible();
  await credits.click();
  const summary = page.getByTestId('trial-summary');
  await expect(summary).toContainText('108 of 120 trial credits left');
  await expect(summary).toContainText('Ends Dec 11');
  await page.keyboard.press('Escape');

  await page.goto('/settings/billing');
  const card = page.getByTestId('trial-plan');
  await expect(card).toContainText('108 credits left');
  await expect(card).toContainText('video up to 480p and 5s');
  await card.getByRole('button', { name: 'Pick a plan' }).click();
  await expect(page.getByRole('dialog', { name: 'Pick a plan' })).toBeVisible();
});

test('an ended trial says so and opens the join paywall with its own headline', async ({ page }) => {
  await asTrial(page, 'expired', 0, { skipFirstRun: true });
  await page.goto('/settings/billing');
  await expect(page.getByTestId('trial-chip')).toHaveAttribute('data-status', 'expired');
  const card = page.getByTestId('trial-plan');
  await expect(card).toContainText('Ended');
  await card.getByRole('button', { name: 'Pick a plan' }).click();
  await expect(page.getByRole('dialog', { name: 'Your trial has ended' })).toBeVisible();
});

test('first-run: three steps, the brief lands in the Home prompt box, and it is remembered', async ({ page }) => {
  await asTrial(page);
  await page.goto('/');
  const dlg = page.getByRole('dialog', { name: 'What do you make?' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('first-run-next')).toBeDisabled();
  await dlg.getByRole('radio', { name: /Short drama/ }).click();
  await dlg.getByTestId('first-run-next').click();
  const step2 = page.getByRole('dialog', { name: 'Start from a template or a brief' });
  // No templates in this workspace: the brief, prefilled for the pick.
  await expect(step2).toContainText('No templates for this yet');
  await expect(step2.getByLabel('Or write a brief')).toHaveValue(/two friends argue/);
  await step2.getByLabel('Or write a brief').fill('A 10-second scene in a rainy bus stop');
  await step2.getByTestId('first-run-next').click();
  const step3 = page.getByRole('dialog', { name: 'See the result' });
  await expect(step3.getByTestId('first-run-credits')).toContainText('108 credits until Dec 11');
  await step3.getByTestId('first-run-finish').click();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
  await expect(page.locator('#brief')).toHaveValue('A 10-second scene in a rainy bus stop');

  await page.reload();
  await expect(page.locator('#brief')).toBeVisible();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
});

test('first-run: Skip is remembered', async ({ page }) => {
  await asTrial(page);
  await page.goto('/');
  await page.getByTestId('first-run-skip').click();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem('rolling.firstRun.usr_stub'))).toBe('skipped');
  await page.reload();
  await expect(page.locator('#brief')).toBeVisible();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
});
