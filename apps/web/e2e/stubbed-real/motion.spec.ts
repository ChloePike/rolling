import { expect, test } from '@playwright/test';
import { layoutShift, recordMotion } from '../support/motion';
import { stubApi } from './support';

/**
 * Loading motion in real mode (docs/motion-audit.md): skeletons keep their
 * 150ms delay under reduced motion (the reduced-motion safety net used to zero
 * it, so every fast load flashed a placeholder), they do not pulse, and Home
 * swaps skeletons for content without shifting the layout.
 */

test.beforeEach(async ({ page }) => {
  await stubApi(page, { delayMs: 1200 });
});

test.describe('reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('skeletons still wait 150ms before showing, and stay still', async ({ page }) => {
    await page.goto('/');
    const skeleton = page.getByTestId('project-skeleton').first().locator('[data-skeleton]').first();
    await expect(skeleton).toBeAttached();
    const style = await skeleton.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { delay: cs.animationDelay.split(',')[0]!.trim(), names: cs.animationName };
    });
    expect(style.delay).toBe('0.15s');
    expect(style.names).not.toContain('pulse');
  });
});

test('Home: skeletons give way to content without layout shift', async ({ page }) => {
  await recordMotion(page);
  await page.goto('/');
  await expect(page.getByTestId('project-skeleton').first()).toBeVisible();
  await expect(page.getByTestId('project-skeleton')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(500);
  const { total, shifts } = await layoutShift(page);
  expect(total, JSON.stringify(shifts)).toBeLessThan(0.01);
});
