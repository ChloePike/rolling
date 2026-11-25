import { expect, test } from '@playwright/test';
import { animationsOf, EXIT, MODAL, MODEL_PANEL, registerFidelity, setMode, STANDARD } from './support/toolSpec';

test.describe('Quick Create /create/quick', () => {
  registerFidelity('quick');

  test('creation mode comes from the header settings popover, not a page toggle; Advanced panel animates in and out', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    const tool = page.getByTestId('tool-quick');
    await expect(tool).toHaveAttribute('data-mode', 'simple');
    await expect(tool.getByText('Advanced settings')).toHaveCount(0);

    await page.getByTestId('app-header').getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: /Advanced/ }).click();
    await expect(tool).toHaveAttribute('data-mode', 'advanced');
    const anims = await animationsOf(page, 'main aside [data-group="model"]');
    expect(anims[0]).toMatchObject({ duration: 320, easing: STANDARD });
    expect(anims[0]!.transforms[0]).toBe('translateY(8px)');
    // List stagger: 30ms apart, capped after the sixth item.
    const delays = await page.$$eval('main aside [data-group]', (els) => els.map((e) => getComputedStyle(e).animationDelay));
    expect(delays.slice(0, 6)).toEqual(['0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s']);
    await expect(tool.getByRole('heading', { name: 'Random seed' })).toBeAttached();

    await page.getByRole('radio', { name: /Simple/ }).click();
    await expect(tool).toHaveAttribute('data-mode', 'simple');
    const exit = await animationsOf(page, 'main aside [data-group="model"]');
    expect(exit[0]).toMatchObject({ duration: 140, easing: EXIT });
    await expect(page.locator('main aside [data-group]')).toHaveCount(0);
  });

  test('model pill opens the picker (200ms, standard, 6px), Escape closes it (140ms exit) and returns focus', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    const pill = page.locator('[data-pill="model"]');
    await pill.click();
    const dialog = page.getByRole('dialog', { name: 'Choose model' });
    await expect(dialog).toBeVisible();
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    const enter = await animationsOf(page, MODEL_PANEL);
    expect(enter[0]).toMatchObject({ duration: 200, easing: STANDARD });
    expect(enter[0]!.transforms[0]).toBe('translateY(6px)');
    for (const name of ['Seedance 2.5', 'MiniMax H3', 'Wan 3.0', 'Wan 2.2']) await expect(dialog.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press('Escape');
    const exit = await animationsOf(page, MODEL_PANEL);
    expect(exit[0]).toMatchObject({ duration: 140, easing: EXIT });
    await expect(dialog).toHaveCount(0);
    await expect(pill).toBeFocused();
  });

  test('in Advanced, picking a model updates the pill and the Model control; settings pills open one settings popover', async ({ page }) => {
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    await page.locator('[data-pill="model"]').click();
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: /MiniMax H3/ }).click();
    await expect(page.locator('[data-pill="model"]')).toContainText('MiniMax H3');
    await expect(page.locator('main aside [data-group="model"]').getByRole('button', { name: 'MiniMax H3' })).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-pill="res"]').click();
    await expect(page.getByRole('dialog', { name: 'Video settings' })).toBeVisible();
    for (const id of ['ratio', 'duration', 'res', 'fps', 'count', 'seed']) {
      await expect(page.locator(`[data-pill="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
    }
    await page.mouse.click(1300, 130);
    await expect(page.getByRole('dialog', { name: 'Video settings' })).toHaveCount(0);

    await page.locator('main aside [data-group="res"]').getByRole('button', { name: '480p' }).click();
    await expect(page.getByTestId('tool-composer')).toContainText('6 credits');
  });

  test('send opens the run confirm (standard enter, shorter exit-curve exit) with the quote; a result opens the viewer', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    await page.getByTestId('tool-composer').getByRole('button', { name: 'Generate video', exact: true }).click();
    const confirm = page.locator(MODAL);
    await expect(confirm).toBeVisible();
    const modalIn = (await animationsOf(page, MODAL))[0]!;
    expect(modalIn.easing).toBe(STANDARD);
    expect(modalIn.duration).toBeGreaterThanOrEqual(200);
    await expect(confirm).toContainText('2,480 → 2,470');
    await expect(confirm.getByRole('button', { name: 'Generate video · 10 credits' })).toBeVisible();
    await page.keyboard.press('Escape');
    const modalOut = (await animationsOf(page, MODAL))[0]!;
    expect(modalOut.easing).toBe(EXIT);
    expect(modalOut.duration).toBeLessThan(modalIn.duration);
    await expect(confirm).toHaveCount(0);

    await page.locator('article button[aria-label="Details"]').nth(1).click();
    await expect(page.locator(MODAL)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL)).toHaveCount(0);
  });

  test('feed cards enter with a 30ms stagger; running progress is a real progress bar', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    await expect(page.locator('main article')).toHaveCount(4);
    const timing = await page.$$eval('main article', (els) => els.map((e) => `${getComputedStyle(e).animationDuration} ${getComputedStyle(e).animationDelay}`));
    expect(timing).toEqual(['0.2s 0s', '0.2s 0.03s', '0.2s 0.06s', '0.2s 0.09s']);
    await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '62');
    await page.getByRole('tab', { name: 'Running' }).click();
    await expect(page.locator('main article')).toHaveCount(1);
  });

  test('reduced motion: popover, panel and cards fade only (no movement)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    for (const t of (await animationsOf(page, 'main aside [data-group="model"]'))[0]?.transforms ?? []) expect(t).toMatch(/^(none|translateY\(0px\))$/);
    for (const t of (await animationsOf(page, 'main article'))[0]?.transforms ?? []) expect(t).toMatch(/^(none|translateY\(0px\))$/);
    await page.locator('[data-pill="model"]').click();
    const a = await animationsOf(page, MODEL_PANEL);
    for (const t of a[0]?.transforms ?? []) expect(t).toMatch(/^(none|translateY\(0px\))$/);
    expect(a[0]?.opacities[0]).toBe('0');
    await page.keyboard.press('Escape');
    await page.getByTestId('tool-composer').getByRole('button', { name: 'Generate video', exact: true }).click();
    const c = await animationsOf(page, MODAL);
    for (const t of c[0]?.transforms ?? []) expect(t).toMatch(/^(none|translate(Y)?\(0px(, 0px)?\)( scale\(1\))?)$/);
  });

  test('plan caps (D-006): on Starter, 1080p stays visible but locked and names Plus as the unlocking plan', async ({ page }) => {
    await setMode(page, 'advanced');
    await page.goto('/create/quick');
    const locked = page.locator('main aside [data-group="res"] button[data-locked]');
    await expect(locked).toHaveCount(1);
    await expect(locked).toBeDisabled();
    await expect(locked).toContainText('1080p');
    await expect(locked).toContainText('Plus');
    await expect(locked).toHaveAttribute('title', 'Available on Plus');
    await expect(locked).toHaveAccessibleName('1080p, Available on Plus');
    await locked.click({ force: true });
    await expect(page.locator('main aside [data-group="res"] [aria-pressed="true"]')).toHaveText('720p');
    await expect(page.locator('[data-pill="res"]')).toHaveText('720p');
  });

  test('non-members (D-007): Generate and Refine open the join paywall and keep the typed brief', async ({ page }) => {
    await setMode(page, 'simple');
    await page.addInitScript(() => window.localStorage.setItem('rolling.mock.isMember', 'false'));
    await page.goto('/create/quick');
    const box = page.getByTestId('tool-composer').getByRole('textbox');
    await box.fill('Make shot 3 a slow push-in');
    await page.getByTestId('tool-composer').getByRole('button', { name: 'Generate video', exact: true }).click();
    const paywall = page.getByRole('dialog', { name: 'Pick a plan to generate' });
    await expect(paywall).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Confirm' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(paywall).toHaveCount(0);
    await expect(box).toHaveValue('Make shot 3 a slow push-in');
    await page.getByRole('button', { name: 'Refine prompt' }).click();
    await expect(paywall).toBeVisible();
  });
});
