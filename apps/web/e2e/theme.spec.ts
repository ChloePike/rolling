import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * D-010: the theme follows `prefers-color-scheme` live, and the saved
 * preference (`data-theme` on <html>) overrides it. Screenshots of each page
 * in each mode land in __screens__/theme/ for review.
 */

const SCREENS = fileURLToPath(new URL('./__screens__/theme/', import.meta.url));
mkdirSync(SCREENS, { recursive: true });

const DARK = { bg: 'rgb(11, 11, 12)', text: 'rgb(245, 245, 245)', meta: '#0B0B0C' };
const LIGHT = { bg: 'rgb(255, 255, 255)', text: 'rgb(17, 17, 19)', meta: '#FFFFFF' };

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'canvas', path: '/p/prj_demo' },
  { name: 'quick-create', path: '/create/quick' },
  { name: 'settings', path: '/settings/account' },
  { name: 'upgrade', path: '/upgrade' },
] as const;

/** Saves the theme preference the way lib/prefs does, before the app loads. */
async function savePref(page: Page, theme: 'system' | 'light' | 'dark') {
  await page.addInitScript((t) => {
    try {
      const prefs = JSON.parse(localStorage.getItem('rolling.prefs') ?? '{}') as Record<string, unknown>;
      localStorage.setItem('rolling.prefs', JSON.stringify({ ...prefs, theme: t }));
    } catch {
      /* storage unavailable */
    }
  }, theme);
}

async function colors(page: Page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return {
      bg: body.backgroundColor,
      text: body.color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      attr: document.documentElement.dataset.theme ?? null,
    };
  });
}

async function open(page: Page, path: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string) {
  await page.mouse.move(1438, 898);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SCREENS}${name}.png` });
}

const MODES = [
  { mode: 'system-dark', scheme: 'dark', pref: 'system', want: DARK, attr: null },
  { mode: 'system-light', scheme: 'light', pref: 'system', want: LIGHT, attr: null },
  { mode: 'override-dark', scheme: 'light', pref: 'dark', want: DARK, attr: 'dark' },
  { mode: 'override-light', scheme: 'dark', pref: 'light', want: LIGHT, attr: 'light' },
] as const;

for (const p of PAGES) {
  test.describe(`theme: ${p.name}`, () => {
    for (const m of MODES) {
      test(`${m.mode}: page background and text follow the ${m.attr ? 'saved preference' : 'system'}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: m.scheme });
        await savePref(page, m.pref);
        await open(page, p.path);
        const c = await colors(page);
        expect(c.bg).toBe(m.want.bg);
        expect(c.text).toBe(m.want.text);
        expect(c.scheme).toBe(m.want === LIGHT ? 'light' : 'dark');
        expect(c.meta).toBe(m.want.meta);
        expect(c.attr).toBe(m.attr);
        await shot(page, `${p.name}-${m.mode}`);
      });
    }

    test('switches live when the system scheme changes, and when data-theme is set', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await open(page, p.path);
      expect((await colors(page)).bg).toBe(DARK.bg);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => (await colors(page)).bg).toBe(LIGHT.bg);
      await expect.poll(async () => (await colors(page)).meta).toBe(LIGHT.meta);
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      await expect.poll(async () => (await colors(page)).bg).toBe(DARK.bg);
      await expect.poll(async () => (await colors(page)).meta).toBe(DARK.meta);
      await page.evaluate(() => delete document.documentElement.dataset.theme);
      await expect.poll(async () => (await colors(page)).text).toBe(LIGHT.text);
    });
  });
}

/** Reads one pixel of the timeline canvas (the ruler background, left edge). */
async function timelinePixel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return '';
    const [r, g, b] = ctx.getImageData(2, 2, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  });
}

test.describe('theme: editor timeline (canvas-drawn)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme}: screenshot`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/dev/editor');
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => timelinePixel(page)).not.toBe('');
      await shot(page, `editor-system-${scheme}`);
    });
  }

  test('redraws with the light tokens when the theme changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dev/editor');
    await expect.poll(() => timelinePixel(page)).not.toBe('');
    const dark = await timelinePixel(page);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await expect.poll(() => timelinePixel(page)).not.toBe(dark);
    const light = await timelinePixel(page);
    // The ruler corner is dark on dark and near white on light.
    const lum = (s: string) => s.match(/\d+/g)!.slice(0, 3).reduce((a, v) => a + Number(v), 0) / 3;
    expect(lum(dark)).toBeLessThan(100);
    expect(lum(light)).toBeGreaterThan(200);
  });
});
