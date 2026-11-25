import { expect, test } from '@playwright/test';
import { registerFidelity, setMode } from './support/toolSpec';

test.describe('Remix /create/remix', () => {
  registerFidelity('remix');

  test('character count changes slots, parsed fields, note chips and the quote', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/remix');
    const composer = page.getByTestId('tool-composer');
    await expect(composer).toContainText('14 credits');
    await page.getByRole('radio', { name: '3 people' }).click();
    await expect(page.locator('main aside').getByText('@Character 3')).toBeVisible();
    await expect(page.locator('main aside').getByText('Template or upload')).toBeVisible();
    await expect(page.locator('main aside').getByText('Character 3 Action')).toBeVisible();
    await expect(composer).toContainText('Actions × 3');
    await expect(composer).toContainText('16 credits');
  });

  test('Advanced shows motion strength and reference strength sliders', async ({ page }) => {
    await setMode(page, 'advanced');
    await page.goto('/create/remix');
    await expect(page.getByRole('slider', { name: 'Motion strength' })).toHaveValue('6');
    await expect(page.getByRole('slider', { name: 'Character reference strength' })).toHaveValue('80');
    await expect(page.locator('[data-pill="motion"]')).toHaveText('Sporty 6');
  });
});
