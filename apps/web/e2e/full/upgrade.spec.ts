import { expect, test, type Page } from '@playwright/test';
import { account, api, env, expectUpgradeModal, grantPlan, shot, watchErrors } from './support';

/**
 * Matrix: UPG-1 … UPG-4. The shared upgrade modal (every locked click opens it in place, the URL never
 * changes, what the user typed is kept) and the plan surfaces members see. Nothing here pays or spends.
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const card = (page: Page, id: string) => page.locator(`section[aria-labelledby="plan-${id}"]`);

test('UPG-1 Starter: a locked 1080p in the Quick Create settings opens “1080p needs Plus” in place; Esc keeps the prompt and the 720p setting', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'upgres', 'starter');
  expect((await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { creationMode: 'simple' })).status()).toBe(200);
  const errs = watchErrors(page);
  await page.goto('/create/quick');
  const box = page.getByTestId('tool-composer').getByRole('textbox');
  await box.fill('A rainy street at night');
  const url = page.url();
  await page.locator('[data-pill="res"]').click();
  const params = page.getByRole('dialog', { name: 'Video settings' });
  await params.getByRole('radio', { name: /^1080p, Available on Plus/ }).click();
  const dlg = await expectUpgradeModal(page, '1080p needs Plus');
  await shot(page, testInfo, 'upgrade-1080p');
  await expect(dlg).toHaveAttribute('aria-modal', 'true');
  expect(page.url()).toBe(url);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(box).toHaveValue('A rainy street at night');
  await expect(page.locator('[data-pill="res"]')).not.toContainText('1080p');
  errs.assertClean();
});

test('UPG-2 non-member: the Mature content switch opens “Mature content needs a plan” and stays off; the credits popover offers no top-up', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'upgmature');
  await page.goto('/settings/preferences');
  const sw = page.getByRole('switch', { name: 'Mature content' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  const dlg = await expectUpgradeModal(page, 'Mature content needs a plan');
  await expect(page).toHaveURL(/\/settings\/preferences$/);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  // D-007: no top-ups for non-members.
  await page.getByRole('button', { name: 'Credit balance' }).click();
  await expect(page.getByRole('button', { name: /^Top up/ })).toHaveCount(0);
});

test('UPG-3 header Upgrade is shown to non-members, Starter and Plus, hidden for Pro and Team', async ({ page, context, baseURL }) => {
  test.setTimeout(3 * 60_000);
  await account(context, baseURL, 'upgheader');
  const upgrade = () => page.getByTestId('app-header').getByRole('link', { name: 'Upgrade' });
  for (const [plan, visible] of [[null, true], ['starter', true], ['plus', true], ['pro', false], ['team', false]] as const) {
    if (plan) await grantPlan(page.request, plan);
    await page.goto('/activity');
    await page.getByTestId('app-header').waitFor();
    await expect(page.getByTestId('app-header').getByRole('button', { name: 'Credit balance' })).toBeVisible();
    await expect(upgrade(), `${plan ?? 'non-member'}`).toHaveCount(visible ? 1 : 0);
  }
});

test('UPG-4 /upgrade for members: “Change your plan”; Plus sees Pro as the recommended next plan, Pro sees no downgrade pushed', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'upgpage', 'plus');
  await page.goto('/upgrade');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Change your plan');
  await expect(card(page, 'pro')).toContainText('Recommended');
  await expect(card(page, 'plus')).not.toContainText('Recommended');
  await shot(page, testInfo, 'upgrade-plus');
  // Taglines from the pricing config; voice cloning is not live.
  await expect(card(page, 'starter')).toContainText(/720p/);
  await expect(card(page, 'pro')).toContainText(/4K/);
  await expect(page.getByText(/Voice cloning \(coming soon\)/).first()).toBeVisible();
  await grantPlan(page.request, 'pro');
  await page.goto('/upgrade');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Change your plan');
  await expect(page.getByText('Recommended', { exact: true })).toHaveCount(0);
});
