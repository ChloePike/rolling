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
    // Intl date and time in the locale, not the old `11-23 14:20`.
    await expect(details).toContainText(new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(new Date().getFullYear() !== 2026 && { year: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(new Date('2026-11-23T14:20:00')));
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

  test('upload uses a real file chooser: progress, then the asset appears selected', async ({ page }) => {
    await openApp(page, '/assets');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload' }).click();
    await (await chooser).setFiles({ name: 'Beach.png', mimeType: 'image/png', buffer: Buffer.alloc(2048) });
    await expect(page.locator('[data-upload="Beach.png"]').getByRole('progressbar')).toBeVisible();
    await expect(page.getByText('Beach.png uploaded.')).toBeVisible();
    await expect(page.locator('[data-asset]')).toHaveCount(13);
    await expect(page.getByRole('complementary', { name: 'Asset details' })).toContainText('Beach.png');
  });

  test('detail actions: favorite (shows in Favorites), rename, download, delete with confirm', async ({ page }) => {
    await openApp(page, '/assets');
    const details = page.getByRole('complementary', { name: 'Asset details' });
    await page.locator('[data-asset]').nth(1).click();
    await details.getByRole('button', { name: 'Favorite' }).click();
    await expect(details.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
    await details.getByRole('button', { name: 'Rename' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rename asset' });
    await dlg.getByLabel('Name').fill('Shot A final.mp4');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-asset]').nth(1)).toContainText('Shot A final.mp4');
    const dl = page.waitForEvent('download');
    await details.getByRole('button', { name: 'Download' }).click();
    expect((await dl).suggestedFilename()).toBe('Shot A final.mp4.txt');
    await details.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete Shot A final.mp4?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Shot A final.mp4 deleted.')).toBeVisible();
    await expect(page.locator('[data-asset]')).toHaveCount(11);
    await page.getByRole('navigation', { name: 'Folders' }).getByRole('link', { name: /Favorites/ }).click();
    await expect(page.locator('[data-asset]')).toHaveCount(3);
    await page.getByRole('navigation', { name: 'Folders' }).getByRole('link', { name: /Desk organizer pitch/ }).click();
    await expect(page.locator('[data-asset]')).toHaveCount(5);
  });

  test('voices: preview toggles; Clone a voice takes an audio file and clones to Ready', async ({ page }) => {
    await openApp(page, '/assets?folder=voices');
    const play = page.getByRole('button', { name: 'Preview Clear female' });
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Clone a voice' }).click();
    await (await chooser).setFiles({ name: 'Narration take.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(1024) });
    const row = page.locator('[data-voice]').filter({ hasText: 'Narration take' });
    await expect(row).toContainText('Cloning');
    await expect(row).toContainText('Ready', { timeout: 5000 });
  });

  test('characters: New character opens the Characters tool', async ({ page }) => {
    await openApp(page, '/assets?folder=characters');
    await page.getByRole('button', { name: 'New character' }).click();
    await expect(page).toHaveURL(/\/create\/character$/);
  });
});
