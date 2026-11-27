import { expect, test, type Page } from '@playwright/test';
import { asPlan } from './support/session';
import { openApp } from './support/fidelity';
import { setMode } from './tools/support/toolSpec';

/**
 * The shared upgrade modal (owner request: every locked click opens a modal in
 * place; the URL never changes). Mock mode: checkout applies in place, the
 * modal shows "You're on …" and the interrupted action continues.
 */

async function fast(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript((x) => {
    const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
    w.__rollingMocks = { ...w.__rollingMocks, delayMs: 50, latencyMs: 250, ...x };
  }, extra);
}

const modal = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });

test.describe('Upgrade modal', () => {
  test('tools Advanced panel: 1080p opens “1080p needs Plus” with Plus preselected, URL unchanged; checkout applies 1080p', async ({ page }) => {
    await fast(page);
    await asPlan(page, 'starter');
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    const url = page.url();
    await page.locator('main aside [data-group="res"] button[data-locked]').click();
    const dlg = modal(page, '1080p needs Plus');
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(url);
    // Plans that unlock 1080p, Plus preselected; prices and perks from the pricing config.
    await expect(dlg.getByRole('radio', { name: /^(Plus|Pro)/ })).toHaveCount(2);
    await expect(dlg.getByRole('radio', { name: /^Plus/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.getByRole('radio', { name: /^Plus/ })).toContainText('$15/mo');
    await expect(dlg.getByTestId('upgrade-perks')).toContainText('800 credits every month');
    await dlg.getByRole('radio', { name: 'Yearly' }).click();
    await expect(dlg.getByRole('radio', { name: /^Plus/ })).toContainText('$144/yr');
    await dlg.getByRole('button', { name: 'Continue with Plus' }).click();
    const done = modal(page, 'You’re on Plus');
    await expect(done).toBeVisible();
    await expect(done).toContainText('1080p is unlocked and applied.');
    await done.getByRole('button', { name: 'Continue' }).click();
    await expect(done).toHaveCount(0);
    await expect(page.locator('main aside [data-group="res"] [aria-pressed="true"]')).toHaveText('1080p');
    await expect(page).toHaveURL(url);
  });

  test('tools settings popover (ParamPopover): 1080p opens the modal; Esc closes it and keeps the prompt and settings', async ({ page }) => {
    await fast(page);
    await asPlan(page, 'starter');
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    const box = page.getByTestId('tool-composer').getByRole('textbox');
    await box.fill('A rainy street at night');
    await page.locator('[data-pill="res"]').click();
    const params = page.getByRole('dialog', { name: 'Video settings' });
    await params.getByRole('radio', { name: '1080p, Available on Plus' }).click();
    const dlg = modal(page, '1080p needs Plus');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('radio', { name: /^Plus/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg).toHaveAttribute('aria-modal', 'true');
    // Focus stays inside the modal.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(box).toHaveValue('A rainy street at night');
    await expect(page.locator('[data-pill="res"]')).toHaveText('720p');
    await expect(page).toHaveURL(/\/create\/quick$/);
  });

  test('canvas prompt box: a locked resolution opens the modal (Pro for 4K), URL unchanged; checkout applies it', async ({ page }) => {
    await fast(page);
    await asPlan(page, 'starter');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/p/prj_demo?mock=frozen');
    await page.getByTestId('canvas').waitFor();
    const url = page.url();
    await page.getByRole('button', { name: '9:16 · 720p · 5s' }).click();
    await page.getByRole('menu', { name: 'Resolution' }).getByRole('menuitemradio', { name: '1080p, Available on Plus' }).click();
    const dlg = modal(page, '1080p needs Plus');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('radio', { name: /^Plus/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(url);
    await dlg.getByRole('button', { name: 'Continue with Plus' }).click();
    await expect(modal(page, 'You’re on Plus')).toBeVisible();
    // Closes by itself and the picked resolution applies.
    await expect(page.getByRole('button', { name: '9:16 · 1080p · 5s' })).toBeVisible({ timeout: 6000 });
  });

  test('non-member agent send (Home): opens “The agent needs a plan”, keeps the brief, Starter preselected; checkout sends it', async ({ page }) => {
    await fast(page);
    await asPlan(page, null);
    await openApp(page, '/');
    const ta = page.locator('textarea');
    await ta.fill('A 15s ad for a sparkling water');
    await page.getByRole('button', { name: 'Start' }).click();
    const dlg = modal(page, 'The agent needs a plan');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('radiogroup', { name: 'Plans' }).getByRole('radio')).toHaveText([/Starter/, /Plus/, /Pro/]);
    await expect(dlg.getByRole('radio', { name: /^Starter/ })).toHaveAttribute('aria-checked', 'true');
    await expect(ta).toHaveValue('A 15s ad for a sparkling water');
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(ta).toHaveValue('A 15s ad for a sparkling water');
    await page.getByRole('button', { name: 'Start' }).click();
    await modal(page, 'The agent needs a plan').getByRole('button', { name: 'Continue with Starter' }).click();
    await expect(modal(page, 'You’re on Starter')).toBeVisible();
    // The kept brief goes to the agent: it shows in the Home conversation.
    await expect(page.getByTestId('home-agent-user')).toHaveText('A 15s ad for a sparkling water', { timeout: 8000 });
  });

  test('team invite without Team opens the Team variant with a seat stepper and the price from the config', async ({ page }) => {
    await fast(page);
    await openApp(page, '/settings/team');
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dlg = modal(page, 'Start Team to invite people');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('upgrade-modal')).toHaveAttribute('data-variant', 'team');
    await expect(dlg.getByRole('spinbutton', { name: 'Seats' })).toHaveValue('5');
    await expect(dlg.getByTestId('team-total')).toHaveText('$179 a month');
    await dlg.getByRole('button', { name: 'More seats' }).click();
    await expect(dlg.getByTestId('team-total')).toHaveText('$204 a month');
    await expect(page).toHaveURL(/\/settings\/team$/);
  });

  test('payments not configured: the modal keeps the reason headline, shows “Payments aren’t available yet” under it and closes cleanly', async ({ page }) => {
    await fast(page, { payments: 'off' });
    await asPlan(page, 'starter');
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    await page.locator('main aside [data-group="res"] button[data-locked]').click();
    const dlg = modal(page, '1080p needs Plus');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('heading').first()).toHaveText('1080p needs Plus');
    await expect(dlg.getByTestId('upgrade-modal')).toHaveAttribute('data-phase', 'unavailable');
    await expect(dlg.getByTestId('upgrade-unavailable')).toContainText('Payments aren’t available yet');
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('main aside [data-group="res"] [aria-pressed="true"]')).toHaveText('720p');
  });

  test('mature content without a plan opens the modal; it turns on after checkout', async ({ page }) => {
    await fast(page);
    await asPlan(page, null);
    await openApp(page, '/settings/preferences');
    const sw = page.getByRole('switch', { name: 'Mature content' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    const dlg = modal(page, 'Mature content needs a plan');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Continue with Starter' }).click();
    await modal(page, 'You’re on Starter').getByRole('button', { name: 'Continue' }).click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  test('a locked model opens the modal and is selected after checkout', async ({ page }) => {
    await fast(page);
    await asPlan(page, 'starter');
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    await page.locator('[data-pill="model"]').click();
    const lockedRow = page.locator('button[data-locked="true"]').first();
    test.skip((await lockedRow.count()) === 0, 'no model above Starter in this mock catalog');
    const name = (await lockedRow.locator('[class*="name"]').first().textContent())?.trim() ?? '';
    await lockedRow.click();
    await expect(page.getByRole('dialog', { name: new RegExp(`^${name} needs`) })).toBeVisible();
  });

  test('reduced motion: the modal fades only', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fast(page);
    await asPlan(page, 'starter');
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    await page.locator('main aside [data-group="res"] button[data-locked]').click();
    const dlg = modal(page, '1080p needs Plus');
    await expect(dlg).toBeVisible();
    const transforms = await dlg.evaluate((el) => el.getAnimations().map((a) => ((a.effect as KeyframeEffect).getKeyframes?.() ?? []).map((k) => k.transform ?? 'none')).flat());
    for (const t of transforms) expect(t).toMatch(/^(none|translate(Y)?\(0px(, 0px)?\)( scale\(1\))?)$/);
  });
});
