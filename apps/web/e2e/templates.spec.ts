import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { pixelDiffRatio, type Box } from './support/measure';

/**
 * Templates (Templates.dc.html). The design file draws an older header
 * (12px padding, no Upgrade); the app uses the shared 72px header, so the
 * comparison covers the page content below each header, aligned at its top.
 */

const OUT = fileURLToPath(new URL('./__screens__/templates/', import.meta.url));
const W = 1440;
const H = 900;

async function openDesign(page: Page) {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(buildDesignPage('Templates.dc.html'));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
  return (await page.locator('header').first().boundingBox())!.height;
}

async function openApp(page: Page) {
  await page.setViewportSize({ width: W, height: H });
  await page.goto('/templates');
  await page.locator('[data-testid="app-header"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, H - 2);
  await page.waitForTimeout(450);
  return (await page.getByTestId('app-header').boundingBox())!.height;
}

const PARTS = {
  title: 'h1',
  search: 'input[placeholder^="Search templates"]',
  firstCat: 'button[aria-pressed="true"]',
  featured: 'section[aria-label="Featured"]',
  featuredCard: 'section[aria-label="Featured"] > a',
  grid: 'section[aria-label="All templates"]',
  firstCard: 'section[aria-label="All templates"] > a',
};

async function measure(page: Page, top: number) {
  const out: Record<string, Box> = {};
  for (const [k, sel] of Object.entries(PARTS)) {
    const b = (await page.locator(sel).first().boundingBox())!;
    out[k] = { ...b, y: b.y - top };
  }
  out.total = { ...(await page.getByText(/128 templates · Most used first/).boundingBox())! };
  out.total.y -= top;
  return out;
}

test.describe('templates screen', () => {
  test('content below the header differs from Templates.dc.html in under 1% of pixels; main boxes within 2px', async ({ page }) => {
    const dTop = await openDesign(page);
    const dm = await measure(page, dTop);
    const clip = (top: number) => ({ x: 0, y: top, width: W, height: H - 72 });
    const design = await page.screenshot({ clip: clip(dTop) });
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}templates-design.png` });

    const aTop = await openApp(page);
    const am = await measure(page, aTop);
    const app = await page.screenshot({ clip: clip(aTop) });
    await page.screenshot({ path: `${OUT}templates.png` });

    for (const k of Object.keys(dm)) {
      for (const p of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(am[k]![p] - dm[k]![p]), `${k}.${p}: app ${am[k]![p].toFixed(1)} vs design ${dm[k]![p].toFixed(1)}`).toBeLessThanOrEqual(2);
      }
    }
    const ratio = await pixelDiffRatio(page, app, design);
    test.info().annotations.push({ type: 'pixel-diff', description: `${(ratio * 100).toFixed(3)}%` });
    console.log(`[pixel-diff] templates/default: ${(ratio * 100).toFixed(3)}%`);
    expect(ratio).toBeLessThan(0.01);
  });

  test('copy, featured picks, 12 cards with role badges and Intl numbers', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Templates');
    await expect(page.getByText('Pick a template, swap in your own characters and lines')).toBeVisible();
    const featured = page.getByRole('region', { name: 'Featured' }).getByRole('link');
    await expect(featured).toHaveCount(2);
    await expect(featured.first()).toContainText('12K uses');
    await expect(featured.nth(1)).toContainText('8,640 uses');
    await expect(featured.first()).toContainText('This week’s picks');
    const cards = page.getByRole('region', { name: 'All templates' }).getByRole('link');
    await expect(cards).toHaveCount(12);
    await expect(cards.first()).toContainText('2 roles');
    await expect(cards.first()).toContainText('2 characters · Dialogue · 600 uses');
    await expect(cards.nth(1)).toContainText('1 character · No dialogue · 1,537 uses');
    await expect(page.getByRole('button', { name: 'Aspect ratio: 9:16' })).toBeVisible();
  });

  test('category and search filter the grid; featured hides while filtering; empty state', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Short drama' }).click();
    await expect(page.getByRole('button', { name: 'Short drama' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Featured' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'All templates' }).getByRole('link')).toHaveText([/Period drama opener/]);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search templates' }).fill('unbox');
    await expect(page.getByRole('region', { name: 'All templates' }).getByRole('link')).toHaveText([/Unboxing close-ups/]);
    await page.getByRole('searchbox', { name: 'Search templates' }).fill('zzz');
    await expect(page.getByText('No templates match “zzz”. Try another word or category.')).toBeVisible();
  });

  test('cards enter with the list stagger (30ms apart, max 6); reduced motion keeps them still', async ({ page }) => {
    await openApp(page);
    const delays = await page
      .getByRole('region', { name: 'All templates' })
      .getByRole('link')
      .evaluateAll((els) => els.slice(0, 8).map((el) => getComputedStyle(el).animationDelay));
    expect(delays).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s', '0.15s']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Outfits' }).click();
    const t = await page
      .getByRole('region', { name: 'All templates' })
      .getByRole('link')
      .first()
      .evaluate((el) => getComputedStyle(el).transform);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(t);
  });
});
