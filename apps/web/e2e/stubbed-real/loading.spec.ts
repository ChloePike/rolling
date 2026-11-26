import { expect, test, type Page } from '@playwright/test';
import { expectNoMockStrings, stubApi, watchForMockStrings } from './support';

/**
 * Real mode never renders mock data (owner bug: demo rows first, then an empty
 * page). Every main page, against an API that answers late with empty data:
 * skeletons appear (after ~150ms), no demo string or id ever shows, and the
 * designed empty state follows.
 */

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

const skeleton = (page: Page) => page.locator('[data-skeleton]').first();

test('header: credits and plan load as skeletons, never 0 or a sample balance', async ({ page }) => {
  // A public page renders before `/api/me` answers (app pages wait for the session in the route guard).
  await page.goto('/upgrade');
  await expect(page.getByTestId('header-loading')).toBeAttached();
  await expect(page.getByTestId('app-header').locator('[data-skeleton]').first()).toBeVisible();
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('app-header').getByRole('button', { name: /137/ })).toBeVisible({ timeout: 15_000 });
  });
});

test('home and recent projects: project skeletons, then only New project', async ({ page }) => {
  await page.goto('/');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('project-skeleton').first()).toBeVisible();
    await expect(page.getByTestId('project-skeleton')).toHaveCount(0, { timeout: 15_000 });
  });
  await expect(page.getByRole('link', { name: 'New project' })).toBeVisible();
  // No templates at all: the Inspiration section is left out instead of showing samples.
  await expect(page.getByRole('heading', { name: 'Inspiration' })).toHaveCount(0);
});

test('templates: card skeletons, then the empty state', async ({ page }) => {
  await page.goto('/templates');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('templates-skeleton')).toBeVisible();
    await expect(page.locator('[data-empty]')).toHaveText(/No templates yet/, { timeout: 15_000 });
  });
  await expect(page.getByTestId('templates-skeleton')).toHaveCount(0);
});

test('assets: file and folder-count skeletons, then the empty state', async ({ page }) => {
  await page.goto('/assets');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('asset-skeleton').first()).toBeVisible();
    await expect(page.locator('[data-empty]')).toHaveText(/No assets yet/, { timeout: 15_000 });
  });
  await expect(page.getByTestId('asset-skeleton')).toHaveCount(0);
});

test('public library: grid skeleton, then the empty state', async ({ page }) => {
  await page.goto('/assets/public');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('library-skeleton')).toBeVisible();
    await expect(page.getByText('Nothing matches. Try another word or sub-category.')).toBeVisible({ timeout: 15_000 });
  });
});

test('activity: stat and row skeletons, then the empty state', async ({ page }) => {
  await page.goto('/activity');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('row-skeleton').first()).toBeVisible();
    await expect(page.getByTestId('stat-skeleton').first()).toBeVisible();
    await expect(page.locator('[data-empty]')).toHaveText(/No runs yet/, { timeout: 15_000 });
  });
  await expect(page.getByTestId('row-skeleton')).toHaveCount(0);
});

test('canvas: node skeletons and a title skeleton while the project opens; no demo graph or prompt values', async ({ page }) => {
  await page.goto('/p/prj_01stubstubstubstubstubstub');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('canvas-skeleton')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Untitled project/ }).first()).toBeVisible({ timeout: 15_000 });
  });
  // The graph never arrives on the silent socket: still placeholders, never the demo canvas.
  await expect(page.getByTestId('canvas-skeleton')).toBeVisible();
});

test('upgrade: plans render with no sample account data', async ({ page }) => {
  await page.goto('/upgrade');
  await watchForMockStrings(page, async () => {
    await expect(skeleton(page)).toBeAttached();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('app-header').getByRole('button', { name: /137/ })).toBeVisible({ timeout: 15_000 });
  });
});

test('settings: the session the guard loaded shows at once (cached), with no sample account values', async ({ page }) => {
  await page.goto('/settings/billing');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('settings-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('stub.user@example.test').or(page.getByText('Plus')).first()).toBeVisible({ timeout: 15_000 });
  });
});

test('a failed load shows Retry, and Retry loads the list', async ({ page }) => {
  let fail = true;
  await page.route(/\/api\/runs(\?|$)/, async (route) => {
    if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }) });
    return route.fallback();
  });
  await page.goto('/activity');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  fail = false;
  await retry.click();
  await expect(page.locator('[data-empty]')).toHaveText(/No runs yet/, { timeout: 15_000 });
  await expectNoMockStrings(page);
});

test('skeletons are static under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/templates');
  const el = page.locator('[data-skeleton]').first();
  await expect(el).toBeVisible();
  const names = await el.evaluate((n) => getComputedStyle(n).animationName);
  expect(names).not.toContain('pulse');
});

/** Tools pages read their design values only through the mock adapter (e2e/tools-real covers them in depth). */
test('tools: Quick Create has an empty prompt, no scope or reference chips, and no demo params or quote', async ({ page }) => {
  await page.goto('/create/quick');
  await watchForMockStrings(page, async () => {
    await expect(page.getByTestId('tool-composer')).toBeVisible({ timeout: 15_000 });
  });
  await expect(page.getByTestId('tool-composer').locator('textarea')).toHaveValue('');
});
