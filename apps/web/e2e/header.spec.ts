import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { APP_PARTS, DESIGN_PARTS, measureHeader, pixelDiffRatio, type Box } from './support/measure';

const SCREENS_OUT = fileURLToPath(new URL('./__screens__/', import.meta.url));
const TOLERANCE = 2;
const NAV_LABELS = ['Home', 'Canvas', 'Quick Create', 'Remix', 'Avatar', 'Characters', 'Assets', 'Activity'];
const HEADER_CLIP_HEIGHT = 80;

async function openApp(page: Page, width: number, path = '/') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await page.locator('[data-testid="app-header"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(width / 2, 600);
}

async function openDesign(page: Page, width: number, props: Record<string, unknown> = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(buildDesignPage('Main.dc.html', props));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
}

function expectBoxClose(actual: Box, expected: Box, what: string, tol = TOLERANCE) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${what}.${k}: app ${actual[k].toFixed(1)} vs design ${expected[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

/** Same as expectBoxClose but x measured from the viewport's right edge. */
function expectRightAnchoredClose(actual: Box, aw: number, expected: Box, ew: number, what: string) {
  const ar = aw - (actual.x + actual.width);
  const er = ew - (expected.x + expected.width);
  expect(Math.abs(ar - er), `${what} right inset: app ${ar.toFixed(1)} vs design ${er.toFixed(1)}`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(actual.y - expected.y), `${what}.y`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(actual.width - expected.width), `${what}.width`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(actual.height - expected.height), `${what}.height`).toBeLessThanOrEqual(TOLERANCE);
}

test.describe('shared header', () => {
  test('renders logo, wordmark, 8 nav links in handoff order, credits 2,480, Upgrade, settings gear and account', async ({ page }) => {
    await openApp(page, 1440);
    const header = page.getByTestId('app-header');
    await expect(header.getByRole('link', { name: 'Rolling home' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(NAV_LABELS);
    await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(header.getByRole('button', { name: 'Credit balance: 2,480 credits' })).toContainText('2,480');
    await expect(header.getByRole('link', { name: 'Upgrade' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Account' })).toBeVisible();
  });

  test('brand yellow #FFCB2B appears only in the logo mark', async ({ page }) => {
    await openApp(page, 1440);
    const yellow = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return [cs.color, cs.backgroundColor, cs.fill, cs.borderColor].includes('rgb(255, 203, 43)');
        })
        .map((el) => el.tagName.toLowerCase()),
    );
    expect(yellow).toEqual(['circle']);
  });

  test('at 1440 wide the nav shows text labels and no tooltips', async ({ page }) => {
    await openApp(page, 1440);
    const items = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
    for (const label of NAV_LABELS) await expect(items.getByText(label, { exact: true })).toBeVisible();
    await items.nth(1).hover();
    await page.waitForTimeout(500);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('at 1180 wide the nav shows 36x36 icon-only items with a tooltip below on hover and keyboard focus', async ({ page }) => {
    await openApp(page, 1180);
    const nav = page.getByRole('navigation', { name: 'Main' });
    const items = nav.getByRole('link');
    await expect(items).toHaveCount(8);
    // Labels stay as accessible names but are visually hidden.
    await expect(items).toHaveText(NAV_LABELS);
    for (let i = 0; i < 8; i++) {
      const box = (await items.nth(i).boundingBox())!;
      expect(box.width).toBeCloseTo(36, 0);
      expect(box.height).toBeCloseTo(36, 0);
      await expect(items.nth(i).getByText(NAV_LABELS[i]!, { exact: true })).not.toBeInViewport();
    }
    // Header stays on one line (72px) once the nav is compact.
    const header = (await page.getByTestId('app-header').boundingBox())!;
    expect(header.height).toBeCloseTo(72, 0);

    await items.nth(2).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('Quick Create');
    const itemBox = (await items.nth(2).boundingBox())!;
    const tipBox = (await tip.boundingBox())!;
    expect(tipBox.y).toBeGreaterThanOrEqual(itemBox.y + itemBox.height);
    expect(Math.abs(tipBox.x + tipBox.width / 2 - (itemBox.x + itemBox.width / 2))).toBeLessThanOrEqual(1);

    await page.mouse.move(600, 600);
    await expect(tip).toHaveCount(0);
    await items.nth(7).focus();
    await expect(page.getByRole('tooltip')).toHaveText('Activity');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('at 1440 header geometry matches Main.dc.html within 2px: height 72, logo, wordmark, nav pill, each nav item, credits, Upgrade, gear, avatar', async ({ page }) => {
    await openDesign(page, 1440);
    const design = await measureHeader(page, DESIGN_PARTS);
    await openApp(page, 1440);
    const app = await measureHeader(page, APP_PARTS);

    expect(app.header.box.height).toBeCloseTo(72, 0);
    for (const part of ['header', 'logo', 'wordmark', 'nav', 'credits', 'upgrade', 'settings', 'account'] as const) {
      expectBoxClose(app[part].box, design[part].box, part);
    }
    expect(app.navItems.map((n) => n.text)).toEqual(design.navItems.map((n) => n.text));
    app.navItems.forEach((item, i) => expectBoxClose(item.box, design.navItems[i]!.box, `nav item ${item.text}`));
  });

  test('at 1440 header colors match Main.dc.html: header and nav pill backgrounds, active and idle nav items, Upgrade text, logo fill', async ({ page }) => {
    await openDesign(page, 1440);
    const design = await measureHeader(page, DESIGN_PARTS);
    await openApp(page, 1440);
    const app = await measureHeader(page, APP_PARTS);

    expect(app.header.background).toBe(design.header.background);
    expect(app.nav.background).toBe(design.nav.background);
    expect(app.navItems[0]!.background).toBe(design.navItems[0]!.background);
    expect(app.navItems[0]!.color).toBe(design.navItems[0]!.color);
    expect(app.navItems[1]!.background).toBe(design.navItems[1]!.background);
    expect(app.navItems[1]!.color).toBe(design.navItems[1]!.color);
    for (const part of ['credits', 'upgrade', 'settings', 'account'] as const) {
      expect(app[part].background, `${part} background`).toBe(design[part].background);
      expect(app[part].color, `${part} color`).toBe(design[part].color);
    }
    expect(app.logo.fill).toBe(design.logo.fill);
    expect(app.logo.fill).toBe('rgb(255, 203, 43)');
  });

  test('at 1180 header keeps Main.dc.html geometry: logo and right cluster insets within 2px, nav pill 44px tall and centered, 8x36 + 7x2 + 8 wide', async ({ page }) => {
    // The design file has no compact nav (it wraps below 1280), so anchor the
    // left and right clusters to the design rendered at 1440.
    await openDesign(page, 1440);
    const design = await measureHeader(page, DESIGN_PARTS);
    await openApp(page, 1180);
    const app = await measureHeader(page, APP_PARTS);

    expectBoxClose(app.logo.box, design.logo.box, 'logo');
    expectBoxClose(app.wordmark.box, design.wordmark.box, 'wordmark');
    for (const part of ['credits', 'upgrade', 'settings', 'account'] as const) {
      expectRightAnchoredClose(app[part].box, app.viewportWidth, design[part].box, design.viewportWidth, part);
    }
    expect(app.header.box.height).toBeCloseTo(design.header.box.height, 0);
    expect(Math.abs(app.nav.box.y - design.nav.box.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(app.nav.box.height - design.nav.box.height)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(app.nav.box.width - (8 * 36 + 7 * 2 + 8))).toBeLessThanOrEqual(1);
    const navCenter = app.nav.box.x + app.nav.box.width / 2;
    expect(Math.abs(navCenter - app.viewportWidth / 2)).toBeLessThanOrEqual(TOLERANCE);
  });

  test('at 1440 header screenshot differs from Main.dc.html in under 0.5% of pixels', async ({ page }) => {
    const clip = { x: 0, y: 0, width: 1440, height: HEADER_CLIP_HEIGHT };
    await openDesign(page, 1440);
    const design = await page.screenshot({ clip });
    await openApp(page, 1440);
    const app = await page.screenshot({ clip });
    mkdirSync(SCREENS_OUT, { recursive: true });
    await page.screenshot({ clip, path: `${SCREENS_OUT}header-1440.png` });
    await openDesign(page, 1440);
    await page.screenshot({ clip, path: `${SCREENS_OUT}header-1440-design.png` });

    const ratio = await pixelDiffRatio(page, app, design);
    test.info().annotations.push({ type: 'pixel-diff', description: `${(ratio * 100).toFixed(3)}%` });
    expect(ratio, `pixel diff ratio ${(ratio * 100).toFixed(3)}%`).toBeLessThan(0.005);
  });

  test('at 1180 header screenshot is saved for review', async ({ page }) => {
    await openApp(page, 1180);
    mkdirSync(SCREENS_OUT, { recursive: true });
    await page.screenshot({ clip: { x: 0, y: 0, width: 1180, height: HEADER_CLIP_HEIGHT }, path: `${SCREENS_OUT}header-1180.png` });
  });

  test('settings popover opens from the gear at the MainSettings.dc.html position and size (within 2px) and closes on Escape', async ({ page }) => {
    await openDesign(page, 1440, { initSettings: true });
    const designBox = (await page.getByRole('dialog', { name: 'Settings' }).boundingBox())!;
    await openApp(page, 1440);
    const gear = page.getByRole('button', { name: 'Settings' });
    await gear.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300); // enter animation
    expectBoxClose((await dialog.boundingBox())!, designBox, 'settings popover');
    await expect(dialog.getByRole('radio', { name: /Simple/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByText('Default aspect ratio')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(gear).toBeFocused();
  });
});
