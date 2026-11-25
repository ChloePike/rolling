import { expect, test } from '@playwright/test';
import { animationTiming, diffScreen, expectBoxesClose, expectDiffUnder, measure, openApp, openDesign, settle } from './support/fidelity';

const TABS = [
  { label: 'All assets', path: '/assets', name: 'files' },
  { label: 'Characters', path: '/assets?folder=characters', name: 'characters' },
  { label: 'My voices', path: '/assets?folder=voices', name: 'voices' },
] as const;

const PARTS = { folders: 'main aside, main nav', title: 'main h1', search: 'main label' };

test.describe('assets (Assets.dc.html)', () => {
  test('files: type filters, upload progress, selection drives the details panel', async ({ page }) => {
    await openApp(page, '/assets');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('All assets');
    await expect(page.locator('[data-asset]')).toHaveCount(12);
    await expect(page.getByRole('status').filter({ hasText: 'Uploading' })).toContainText('Uploading · product_shoot_03.mov');
    const details = page.getByRole('complementary', { name: 'Asset details' });
    await expect(details).toContainText('Product photo.png');
    await expect(details).toContainText('11-23 14:20');
    await page.locator('[data-asset]').nth(1).click();
    await expect(details).toContainText('Shot A · v2.mp4');
    await expect(details).toContainText('Made on canvas');
    await page.getByRole('group', { name: 'Filter by type' }).getByRole('button', { name: 'Audio' }).click();
    await expect(page.locator('[data-asset]')).toHaveCount(2);
    await page.getByPlaceholder('Search assets, characters, voices').fill('zzz');
    await expect(page.getByText('No assets match.')).toBeVisible();
  });

  test('folders switch to Characters and My voices', async ({ page }) => {
    await openApp(page, '/assets');
    const nav = page.getByRole('navigation', { name: 'Folders' });
    await nav.getByRole('link', { name: /Characters/ }).click();
    await expect(page).toHaveURL(/folder=characters/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Characters');
    await expect(page.locator('[data-character]')).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'New character' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Asset details' })).toHaveCount(0);
    await nav.getByRole('link', { name: /My voices/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My voices');
    await expect(page.getByRole('button', { name: 'Clone a voice' })).toBeVisible();
    await expect(page.getByText('Cloning 64%')).toBeVisible();
    await expect(page.getByText('Sample too short')).toBeVisible();
  });

  test('box measurements within 2px of the design', async ({ page }) => {
    await openDesign(page, 'Assets.dc.html');
    const design = await measure(page, { folders: 'main aside', title: 'main h1', search: 'main label', details: 'aside[aria-label="Asset details"]' });
    await openApp(page, '/assets');
    await settle(page);
    const app = await measure(page, { folders: 'main nav', title: 'main h1', search: 'main label', details: 'aside[aria-label="Asset details"]' });
    expectBoxesClose(app, design);
  });

  for (const t of TABS) {
    test(`${t.label}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      const r = await diffScreen(page, info, {
        feature: 'library',
        name: `assets-${t.name}`,
        design: () => openDesign(page, 'Assets.dc.html', { initTab: t.label }),
        app: () => openApp(page, t.path),
      });
      expectDiffUnder(r);
    });
  }

  test('motion: cards stagger, the details panel cross-fades on selection; reduced motion is opacity only', async ({ page }) => {
    await openApp(page, '/assets');
    await page.locator('[data-asset]').first().waitFor();
    const delays = await page.evaluate(() => Array.from(document.querySelectorAll('[data-asset]')).map((e) => getComputedStyle(e).animationDelay));
    expect(delays.slice(0, 8)).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.18s', '0.18s']);
    await settle(page);
    await page.locator('[data-asset]').nth(3).click();
    const t = await animationTiming(page, 'aside[aria-label="Asset details"]');
    expect(t?.duration).toBe(200);
    expect(t?.firstTransform).toBe('translateY(4px)');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/assets');
    await page.locator('[data-asset]').first().waitFor();
    const r = await page.evaluate(() => getComputedStyle(document.querySelector('[data-asset]')!).animationDuration);
    expect(r).toBe('0.001s');
  });
});
