import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './design';
import { pixelDiffRatio, type Box } from './measure';

/**
 * Fidelity helpers for the auth, account, library, activity and profile
 * screens. The shared header is checked by header.spec.ts; screen diffs here
 * compare the area below each page's own header, aligned at the header's
 * bottom edge (the design files draw a 68px header, the app shell's is 72px).
 */

export const WIDTH = 1440;
export const HEIGHT = 900;
const SCREENS = fileURLToPath(new URL('../__screens__/', import.meta.url));

export async function openDesign(page: Page, screen: string, props: Record<string, unknown> = {}, height = HEIGHT) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.setContent(buildDesignPage(screen, props));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
}

export async function openApp(page: Page, path: string, height = HEIGHT) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
}

/** Lets enter animations and staggers finish and parks the pointer away from hover targets. */
export async function settle(page: Page, ms = 600) {
  await page.mouse.move(WIDTH - 2, (page.viewportSize()?.height ?? HEIGHT) - 2);
  await page.waitForTimeout(ms);
}

/** Bottom edge of the page header (0 when the screen has none). */
export async function headerBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = document.querySelector('[data-testid="app-header"]') ?? document.querySelector('header');
    return h ? h.getBoundingClientRect().bottom : 0;
  });
}

export interface DiffResult {
  ratio: number;
  offsetDesign: number;
  offsetApp: number;
}

/**
 * Screenshots the design and the app below their headers and returns the
 * fraction of differing pixels. Saves both images to __screens__/<feature>/.
 */
export async function diffScreen(
  page: Page,
  testInfo: TestInfo,
  opts: {
    feature: string;
    name: string;
    design: () => Promise<void>;
    app: () => Promise<void>;
    height?: number;
    /** False for screens without the app header (login). */
    appHeader?: boolean;
  },
): Promise<DiffResult> {
  const height = opts.height ?? HEIGHT;
  await opts.design();
  await settle(page, 100);
  const offsetDesign = Math.round(await headerBottom(page));
  const clipH = height - Math.max(offsetDesign, opts.appHeader === false ? 0 : 72);
  const designShot = await page.screenshot({ clip: { x: 0, y: offsetDesign, width: WIDTH, height: clipH } });
  await opts.app();
  await settle(page);
  const offsetApp = Math.round(await headerBottom(page));
  const appShot = await page.screenshot({ clip: { x: 0, y: offsetApp, width: WIDTH, height: clipH } });
  const dir = `${SCREENS}${opts.feature}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${opts.name}-design.png`, designShot);
  writeFileSync(`${dir}${opts.name}-app.png`, appShot);
  await page.screenshot({ path: `${dir}${opts.name}-app-full.png` });
  const ratio = await pixelDiffRatio(page, appShot, designShot);
  console.log(`[pixel-diff] ${opts.feature}/${opts.name}: ${(ratio * 100).toFixed(3)}%`);
  testInfo.annotations.push({ type: 'pixel-diff', description: `${opts.feature}/${opts.name}: ${(ratio * 100).toFixed(3)}%` });
  return { ratio, offsetDesign, offsetApp };
}

export function expectDiffUnder(result: DiffResult, max = 0.01) {
  expect(result.ratio, `pixel diff ${(result.ratio * 100).toFixed(3)}%`).toBeLessThanOrEqual(max);
}

/** Reads boxes for selectors, relative to the header bottom. */
export async function measure(page: Page, selectors: Record<string, string>): Promise<Record<string, Box>> {
  return page.evaluate((sel) => {
    const h = document.querySelector('[data-testid="app-header"]') ?? document.querySelector('header');
    const top = h ? h.getBoundingClientRect().bottom : 0;
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [k, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      if (!el) throw new Error(`Missing ${k}: ${s}`);
      const r = el.getBoundingClientRect();
      out[k] = { x: r.x, y: r.y - top, width: r.width, height: r.height };
    }
    return out;
  }, selectors);
}

export function expectBoxesClose(app: Record<string, Box>, design: Record<string, Box>, tol = 2) {
  for (const k of Object.keys(design)) {
    for (const p of ['x', 'y', 'width', 'height'] as const) {
      const a = app[k]![p];
      const d = design[k]![p];
      expect(Math.abs(a - d), `${k}.${p}: app ${a.toFixed(1)} vs design ${d.toFixed(1)}`).toBeLessThanOrEqual(tol);
    }
  }
}

/** Timing of the first running CSS animation on the element (or a descendant). */
export async function animationTiming(page: Page, selector: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const anims = el.getAnimations({ subtree: true });
    const a = anims[0];
    if (!a) return null;
    const t = a.effect!.getComputedTiming();
    const kf = (a.effect as KeyframeEffect).getKeyframes();
    return { duration: Number(t.duration), easing: String(kf[0]?.easing ?? t.easing), firstTransform: String(kf[0]?.transform ?? '') };
  }, selector);
}
