import { expect, test } from '@playwright/test';
import { registerFidelity, setMode, setThreshold } from './support/toolSpec';

test.describe('Avatar /create/avatar', () => {
  registerFidelity('avatar');

  test('lip-sync model picker lists the lip-sync candidate and keeps live avatar disabled', async ({ page }) => {
    await setMode(page, 'advanced');
    await page.goto('/create/avatar');
    await page.locator('[data-pill="model"]').click();
    const dialog = page.getByRole('dialog', { name: 'Choose model' });
    await expect(dialog.getByText('Lip-sync method')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Wan 2\.2 S2V/ })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: /Live avatar/ })).toBeDisabled();
    await dialog.getByRole('button', { name: /Wan 2\.2 S2V/ }).click();
    await expect(page.locator('main aside [data-group="model"]').getByRole('button', { name: 'Wan 2.2 S2V' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('persona and voice choices update the example and the script draft', async ({ page }) => {
    await setMode(page, 'simple');
    await setThreshold(page, 0);
    await page.goto('/create/avatar');
    await page.getByRole('button', { name: 'Comedian' }).click();
    await expect(page.locator('main aside')).toContainText('Example: “However messy the desk, small things need a home.”');
    await page.locator('main aside').getByRole('button', { name: /^Steady male/ }).click();
    await expect(page.locator('main article').first()).toContainText('Comedian · Steady male · About 9s of 10s');
    await page.getByRole('button', { name: 'Confirm and generate' }).click();
    await expect(page.locator('[role="dialog"].rl-modal')).toContainText('Write script · 12 credits');
  });
});
