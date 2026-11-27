import { expect, test, type Page } from '@playwright/test';
import { NODE } from '../src/features/canvas/mocks';
import { setMode } from './tools/support/toolSpec';

/**
 * Real progress only (docs/ux-audit.md #29): a job whose provider reports no
 * progress shows the elapsed time and an indeterminate bar, never a number
 * (it used to read “Generating 50%” for minutes). Mocks; the real-mode run
 * card and Activity row are in stubbed-real/ux-audit.spec.ts.
 */

const ELAPSED = /^\d+:\d{2}$/;

const roomCall = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => ((window as unknown as { __canvasRoom: Record<string, (...x: unknown[]) => unknown> }).__canvasRoom)[f as string]!(...(a as unknown[])), [fn, args] as const);

test('canvas node: a job with no progress reported shows the elapsed time and an indeterminate fill, not 0%', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/p/prj_demo?mock=frozen');
  await page.getByTestId(`node-${NODE.shotB}`).waitFor();
  // Shot B carries real progress in the demo: a number.
  await expect(page.getByTestId(`node-${NODE.shotB}`).getByTestId('node-progress')).toHaveText('58%');
  await roomCall(page, 'startJobs', [NODE.shotA]);
  const a = page.getByTestId(`node-${NODE.shotA}`);
  await expect(a).toHaveAttribute('data-status', /queued|generating/);
  const label = a.getByTestId('node-progress');
  await expect(label).toHaveText(/^Generating · \d+:\d{2}$/);
  await expect(a.locator('.rl-indeterminate')).toHaveCount(1);
  await expect(a).not.toContainText('%');
  // Real progress arrives: the number replaces the clock.
  await roomCall(page, 'advance', 0.3);
  await expect(label).toHaveText('30%');
  await expect(a.locator('.rl-indeterminate')).toHaveCount(0);
});

test('tool feed: a running card with no progress shows the elapsed time, “Generating” without a number and an indeterminate bar', async ({ page }) => {
  await setMode(page, 'simple');
  // Jobs never tick: the provider reports nothing.
  await page.addInitScript(() => {
    (window as unknown as { __rollingMocks?: Record<string, unknown> }).__rollingMocks = { runTickMs: 600_000 };
  });
  await page.goto('/create/quick');
  await page.getByTestId('tool-composer').getByRole('button', { name: 'Generate video', exact: true }).click();
  const card = page.locator('main article').first();
  await expect(card).toHaveAttribute('data-state', 'running');
  const bar = card.getByRole('progressbar');
  await expect(bar).not.toHaveAttribute('aria-valuenow', /.*/);
  await expect(bar).toHaveClass(/rl-indeterminate/);
  await expect(card.getByLabel(/^Elapsed \d+:\d{2}$/)).toHaveText(ELAPSED);
  await expect(card.getByText('Generating', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('%');
});

test('reduced motion: the indeterminate bar stands still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/p/prj_demo?mock=frozen');
  await page.getByTestId(`node-${NODE.shotB}`).waitFor();
  await roomCall(page, 'startJobs', [NODE.shotA]);
  const fill = page.getByTestId(`node-${NODE.shotA}`).locator('.rl-indeterminate');
  await expect(fill).toHaveCount(1);
  expect(await fill.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
