import { expect, test } from '@playwright/test';
import { asPlan } from '../support/session';
import { registerFidelity, setMode } from './support/toolSpec';

test.describe('Characters /create/character', () => {
  registerFidelity('character');

  test('chips, age and style update the note line and the style pill', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/character');
    const composer = page.getByTestId('tool-composer');
    await expect(composer).toContainText('28 y/o');
    await page.getByLabel('Age').fill('31');
    await expect(composer).toContainText('31 y/o');
    await page.locator('main aside').getByRole('button', { name: 'Anime' }).click();
    await expect(page.locator('[data-pill="style"]')).toHaveText('Anime');
    await expect(page.locator('main aside').getByRole('button', { name: 'Anime' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('settings pill opens the image settings popover; 4K stays disabled at standard quality', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/character');
    await page.locator('[data-pill="views"]').click();
    const dialog = page.getByRole('dialog', { name: 'Image settings' });
    await expect(dialog.getByRole('radio', { name: '4K' })).toBeDisabled();
    await dialog.getByRole('radio', { name: 'High quality' }).click();
    await expect(dialog.getByRole('radio', { name: '4K' })).toBeEnabled();
  });

  test('plan caps (D-006): on Starter, 4K images are locked and name Pro', async ({ page }) => {
    await asPlan(page, 'starter');
    await setMode(page, 'advanced');
    await page.goto('/create/character');
    const locked = page.locator('main aside [data-group="res"] button[data-locked]');
    await expect(locked).toHaveCount(1);
    await expect(locked).toContainText('4K');
    await expect(locked).toContainText('Pro');
    await expect(locked).toBeDisabled();
  });
});
