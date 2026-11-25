import { expect, test } from '@playwright/test';
import { animationTiming, diffScreen, expectBoxesClose, expectDiffUnder, measure, openApp, openDesign, settle } from './support/fidelity';

const PARTS = { head: 'main section', tabs: 'main [role="tablist"]', grid: 'main [role="tablist"] + div' };
const DESIGN_PARTS = { head: 'main section', tabs: 'main [role="tablist"]', grid: 'main [role="tablist"] + div' };

test.describe('profile (Profile.dc.html)', () => {
  test('header, tabs with counts, published and templates grids; mature works never listed', async ({ page }) => {
    await openApp(page, '/u/alexmakes');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alex Chen');
    await expect(page.getByText('@alexmakes')).toBeVisible();
    await expect(page.getByText('[BIO: one or two lines the user writes about themselves]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', '/settings/account');
    const published = page.getByRole('tab', { name: /Published/ });
    await expect(published).toHaveAttribute('aria-selected', 'true');
    await expect(published).toContainText('8');
    await expect(page.locator('[data-work]')).toHaveCount(8);
    await expect(page.getByText('Late night set')).toHaveCount(0);
    await page.getByRole('tab', { name: /Templates/ }).click();
    await expect(page.locator('[data-work]')).toHaveCount(2);
    await expect(page.getByText('Two-person product demo')).toBeVisible();
  });

  test('share copies the link and confirms with a toast', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page, '/u/alexmakes');
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText('Profile link copied')).toBeVisible();
  });

  test('box measurements within 2px of the design', async ({ page }) => {
    await openDesign(page, 'Profile.dc.html');
    const design = await measure(page, DESIGN_PARTS);
    await openApp(page, '/u/alexmakes');
    await settle(page);
    expectBoxesClose(await measure(page, PARTS), design);
  });

  for (const tab of ['Published', 'Templates']) {
    test(`${tab}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      const r = await diffScreen(page, info, {
        feature: 'profile',
        name: tab.toLowerCase(),
        design: async () => {
          await openDesign(page, 'Profile.dc.html');
          if (tab === 'Templates') await page.getByRole('tab', { name: /Templates/ }).click();
        },
        app: async () => {
          await openApp(page, '/u/alexmakes');
          if (tab === 'Templates') await page.getByRole('tab', { name: /Templates/ }).click();
        },
      });
      expectDiffUnder(r);
    });
  }

  test('motion: tab underline slides, cards stagger; reduced motion jumps and fades', async ({ page }) => {
    await openApp(page, '/u/alexmakes');
    await settle(page);
    const line = page.locator('[role="tablist"] [aria-hidden="true"]');
    const a = (await line.boundingBox())!;
    await page.getByRole('tab', { name: /Templates/ }).click();
    const xs: number[] = [];
    for (let k = 0; k < 12; k++) {
      xs.push((await line.boundingBox())!.x);
      await page.waitForTimeout(16);
    }
    const target = (await page.getByRole('tab', { name: /Templates/ }).boundingBox())!;
    expect(xs.some((x) => x > a.x + 1 && x < target.x - 1), `intermediate positions ${xs.join(', ')}`).toBe(true);
    const t = await animationTiming(page, '[data-work]');
    expect(t?.duration).toBe(200);
    const delays = await page.evaluate(() => Array.from(document.querySelectorAll('[data-work]')).map((e) => getComputedStyle(e).animationDelay));
    expect(delays).toEqual(['0s', '0.03s']);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/u/alexmakes');
    await settle(page);
    await page.getByRole('tab', { name: /Templates/ }).click();
    await page.waitForTimeout(30);
    const t2 = (await page.getByRole('tab', { name: /Templates/ }).boundingBox())!;
    expect(Math.abs((await page.locator('[role="tablist"] [aria-hidden="true"]').boundingBox())!.x - t2.x)).toBeLessThanOrEqual(1);
  });
});
