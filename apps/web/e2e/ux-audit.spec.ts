import { expect, test } from '@playwright/test';
import { openApp, settle } from './support/fidelity';
import { asPlan } from './support/session';

/**
 * UX audit fixes (docs/ux-audit.md) on the mocks. Real-mode checks live in
 * `e2e/stubbed-real/ux-audit.spec.ts`.
 */

test('canvas: an empty canvas offers next steps; the agent placeholder fits an empty canvas; Run all has no “~0” chip', async ({ page }) => {
  await openApp(page, '/p/prj_demo?mock=empty');
  const empty = page.getByTestId('canvas-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Empty canvas');
  await expect(page.getByRole('textbox', { name: 'Tell the agent' })).toHaveAttribute('placeholder', /^Describe the video\./);
  await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeVisible();
  await expect(page.getByText('~0', { exact: true })).toHaveCount(0);
  await empty.getByRole('button', { name: 'Add a node' }).click();
  await expect(page.getByPlaceholder(/Search, or type a request/)).toBeVisible();
  await page.keyboard.press('Escape');
  await empty.getByRole('button', { name: 'Start from a template' }).click();
  await expect(page.getByRole('button', { name: 'Workflows and templates', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('canvas: the demo canvas keeps its cost chip and has no empty-state card', async ({ page }) => {
  await openApp(page, '/p/prj_demo');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByTestId('canvas-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Run all, about \d+ credits$/ })).toBeVisible();
});

test('templates: no “0 roles” badge or “0s” duration, a filtered count, and an empty search offers to clear it', async ({ page }) => {
  await openApp(page, '/templates');
  await settle(page);
  await expect(page.getByText(/^0 roles?$/)).toHaveCount(0);
  await expect(page.getByText('0s', { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox').or(page.getByPlaceholder(/Search templates/)).first().fill('zzzz');
  await expect(page.getByText('No templates match “zzzz”. Try another word or category.')).toBeVisible();
  await expect(page.getByText(/^0 templates · Most used first$/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(page.locator('[data-template]').first()).toBeVisible();
  await expect(page.getByPlaceholder(/Search templates/)).toHaveValue('');
});

test('dialogs: closing the template preview with Escape puts focus back on the card that opened it', async ({ page }) => {
  await openApp(page, '/templates');
  await settle(page);
  const card = page.locator('section[aria-label] [data-template]').nth(2);
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('template-preview')).toBeVisible();
  // The preview re-renders as its details load; focus must stay inside it.
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('template-preview')).toHaveCount(0);
  expect(await card.evaluate((el) => el === document.activeElement)).toBe(true);
});

test('header: at 1280 wide the header stays one row (icons-only nav below 1360, a usability departure from the 1280 in handoff §1)', async ({ page }) => {
  await asPlan(page, 'plus');
  for (const width of [1280, 1359]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/activity');
    const header = page.getByTestId('app-header').or(page.locator('header')).first();
    await expect(page.getByRole('link', { name: 'Upgrade' }).or(page.getByRole('button', { name: 'Upgrade' })).first()).toBeVisible();
    expect((await header.boundingBox())!.height, `header height at ${width}`).toBeLessThanOrEqual(76);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/activity');
  await expect(page.getByRole('navigation').getByText('Quick Create', { exact: true })).toBeVisible();
});

test('tools: the composer stays on screen in short windows (1280×720, 1024×768)', async ({ page }) => {
  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/create/quick');
    const box = (await page.getByTestId('tool-composer').boundingBox())!;
    expect(box.y + box.height, `composer bottom at ${width}×${height}`).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  }
});
