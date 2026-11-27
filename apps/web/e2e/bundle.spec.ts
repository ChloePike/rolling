import { expect, test, type Page } from '@playwright/test';

/**
 * Bundle splitting (2026-11-27): Home loads without the canvas, the editor or other
 * routes; route chunks preload on intent (hover). The on-demand layers are covered by
 * their screens' specs (header, home, overlays, picker). The size budget is checked at
 * build time (build/bundleBudget.ts).
 */

function scripts(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') urls.push(new URL(r.url()).pathname);
  });
  return urls;
}

test('Home first load does not fetch the canvas, the editor or the settings page', async ({ page }) => {
  const urls = scripts(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Turn an idea into a video');
  expect(urls.some((u) => /\/assets\/index-[\w-]+\.js$/.test(u))).toBe(true);
  // On-demand layers (upgrade modal, pickers) may be fetched once the browser is idle; routes are not.
  for (const name of ['_projectId', 'Editor', '_section']) {
    expect(urls.filter((u) => u.includes(`/assets/${name}-`)), name).toEqual([]);
  }
});

test('hovering a nav item preloads its route chunk before the click', async ({ page }) => {
  const urls = scripts(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Turn an idea into a video');
  // Let the after-first-render loads (English, on-demand layers) start first.
  await page.waitForTimeout(800);
  const before = urls.length;
  const activity = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity' });
  await activity.hover();
  // The Activity route's chunks (its component split and what it imports) arrive on hover.
  await expect.poll(() => urls.slice(before).some((u) => /\/assets\/activity-[\w-]+\.js$/.test(u))).toBe(true);
  const fetched = urls.length;
  await activity.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity');
  expect(urls.slice(fetched).filter((u) => /\/assets\/activity-[\w-]+\.js$/.test(u))).toEqual([]);
});
