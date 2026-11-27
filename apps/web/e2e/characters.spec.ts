import { expect, test } from '@playwright/test';

/**
 * Character page (D-032, mock mode): the sheet, the locked description,
 * versions with a drift badge, outfit variants, "Used in" and the latest
 * consistency checks; reached from Assets → Characters.
 */
test.describe('Character page /assets/characters/:id', () => {
  test('shows the sheet, the locked description, versions with drift badges, outfits and where it is used', async ({ page }) => {
    await page.goto('/assets/characters/chr_mock_mia');
    const root = page.getByTestId('character-page');
    await expect(root.getByRole('heading', { level: 1 })).toHaveText('Mia');
    const sheet = page.getByTestId('character-sheet');
    await expect(sheet.getByRole('listitem')).toHaveCount(6);
    await expect(sheet).toContainText('3/4 view');
    await expect(sheet).toContainText('Smiling');
    const descriptor = page.getByTestId('character-descriptor');
    await expect(descriptor).toContainText('Locked · v2');
    await expect(descriptor).toContainText('Side-part bob, black');
    await expect(descriptor).toContainText('make a new version');
    const versions = page.getByTestId('character-versions');
    await expect(versions.locator('[data-version]')).toHaveCount(2);
    await expect(versions.locator('[data-version="2"] [data-drift="drift"]')).toHaveText('Drift · 0.48');
    await expect(versions.locator('[data-version="1"] [data-drift="consistent"]')).toHaveText('Consistent · 0.86');
    await expect(versions.locator('[data-version="2"]')).toContainText('Current');
    await expect(page.getByTestId('character-outfits')).toContainText('Office');
    await expect(page.getByTestId('character-outfits')).toContainText('Navy suit, white shirt');
    const used = page.getByTestId('character-used-in');
    await expect(used.getByRole('link')).toHaveCount(2);
    await expect(used).toContainText('Morning coffee · Ep. 1');
    await expect(page.getByTestId('character-checks').locator('[data-verdict]')).toHaveCount(2);
    await expect(page.getByTestId('character-training')).toContainText('isn’t available yet');
  });

  test('renames in place; the description has no edit control', async ({ page }) => {
    await page.goto('/assets/characters/chr_mock_mia');
    await page.getByRole('button', { name: 'Rename Mia' }).click();
    const input = page.getByLabel('Character name');
    await input.fill('Mia Chen');
    await input.press('Enter');
    await expect(page.getByTestId('character-page').getByRole('heading', { level: 1 })).toHaveText('Mia Chen');
    await expect(page.getByTestId('character-descriptor').getByRole('textbox')).toHaveCount(0);
  });

  test('opens from Assets → Characters', async ({ page }) => {
    await page.goto('/assets?folder=characters');
    await page.locator('[data-character-link]').first().click();
    await expect(page).toHaveURL(/\/assets\/characters\//);
    await expect(page.getByTestId('character-sheet')).toBeVisible();
  });
});
