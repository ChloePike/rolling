import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pixelDiffRatio, type Box } from '../../support/measure';
import { buildToolDesignPage } from './design-tools';
import { APP_HEADER, DESIGN_HEADER, HEIGHT, TOOL_STATES, WIDTH, type ToolState } from './states';

export const SCREENS_OUT = fileURLToPath(new URL('../../__screens__/tools/', import.meta.url));
/** Acceptance bar from docs/frontend-build.md. */
export const MAX_DIFF = 0.01;
const TOL = 2;

/** Selectors for the same parts in the rendered design and in the app. */
const PARTS: Record<string, { design: string; app: string; all?: boolean }> = {
  aside: { design: 'aside[aria-label="Settings"]', app: 'main aside' },
  section: { design: 'section[aria-label="History"]', app: 'main section' },
  title: { design: 'section h1', app: 'main section h1' },
  filters: { design: 'section [role="tablist"]', app: 'main section [role="tablist"]' },
  asideCards: { design: 'aside[aria-label="Settings"] > div', app: 'main aside > div', all: true },
  feedCards: { design: 'section article', app: 'main section article', all: true },
  composer: { design: 'section > div:nth-child(2) > div', app: '[data-testid="tool-composer"]' },
  composerControls: {
    design: 'section > div:nth-child(2) > div > div:last-child button',
    app: '[data-testid="tool-composer"] > div:last-child button',
    all: true,
  },
};
/** App overlays come from features/overlays; the tool wraps the anchored ones in `[data-overlay]`. */
export const MODEL_PANEL = '[data-overlay="model"] [role="dialog"]';
export const PARAMS_PANEL = '[data-overlay="params"] [role="dialog"]';
export const MODAL = '[role="dialog"].rl-modal';
const OVERLAY_PARTS: Record<string, { design: string; app: string }> = {
  model: { design: '[role="dialog"][aria-label="Choose model"]', app: MODEL_PANEL },
  params: { design: 'section [role="dialog"][aria-label="Settings"]', app: PARAMS_PANEL },
  confirm: { design: '[role="dialog"][aria-label="Confirm"]', app: MODAL },
  viewer: { design: '[role="dialog"][aria-label="Result"]', app: MODAL },
};

/** Avoid esbuild's `__name` helper leaking into page.evaluate in some runners. */
async function shim(page: Page) {
  await page.evaluate('window.__name = window.__name || ((f) => f)');
}

export async function openDesign(page: Page, s: ToolState, height: number) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.setContent(buildToolDesignPage(s.design));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
  await shim(page);
}

export async function setMode(page: Page, mode: 'simple' | 'advanced') {
  await page.addInitScript((m) => {
    try {
      window.localStorage.setItem('rolling.creationMode', m);
    } catch {
      /* ignore */
    }
  }, mode);
}

/** Sets the "Confirm before running" preference (lib/prefs): 0 = always confirm. */
export async function setThreshold(page: Page, credits: number) {
  await page.addInitScript((n) => {
    try {
      const raw = window.localStorage.getItem('rolling.prefs');
      window.localStorage.setItem('rolling.prefs', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), confirmThreshold: n }));
    } catch {
      /* ignore */
    }
  }, credits);
}

export async function openApp(page: Page, s: ToolState) {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await setMode(page, s.mode);
  // The confirm state is drawn for a run at or above the threshold; the mock quote is 10 credits.
  if (s.id.endsWith('-confirm')) await setThreshold(page, 0);
  // The preview server is shared by parallel suites; retry a failed navigation once.
  await page.goto(s.path).catch(() => page.goto(s.path));
  await page.getByTestId(`tool-${s.tool}`).waitFor();
  await page.waitForFunction(async () => {
    await document.fonts.ready;
    return document.fonts.check("700 20px 'Geist'") && document.fonts.check("400 13px 'Geist'");
  });
  await shim(page);
  await page.mouse.move(5, HEIGHT - 5);
  if (s.open) await s.open(page);
  await page.mouse.move(5, HEIGHT - 5);
  // Let enter animations finish (slowest is 320ms + stagger).
  await page.waitForTimeout(500);
}

async function boxes(page: Page, sel: string, all: boolean, dy: number): Promise<Box[]> {
  return page.evaluate(
    ({ sel, all, dy }) => {
      const els = all ? Array.from(document.querySelectorAll(sel)) : [document.querySelector(sel)].filter(Boolean);
      return els.map((e) => {
        const r = e!.getBoundingClientRect();
        return { x: r.x, y: r.y - dy, width: r.width, height: r.height };
      });
    },
    { sel, all, dy },
  );
}

function expectClose(a: Box, d: Box, what: string) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - d[k]), `${what}.${k}: app ${a[k].toFixed(1)} vs design ${d[k].toFixed(1)}`).toBeLessThanOrEqual(TOL);
  }
}

/**
 * Registers, for every state of a tool: a pixel diff against the design at
 * 1440 wide (≤ 1%, number recorded as an annotation), box measurements of the
 * main regions and controls (±2px), and, in Advanced mode, the same checks for
 * the left panel scrolled to its end.
 */
export function registerFidelity(tool: ToolState['tool']) {
  for (const s of TOOL_STATES.filter((x) => x.tool === tool)) {
    test(`${s.id}: matches ${s.design}.dc.html at 1440 (pixel diff ≤ 1%, boxes ±2px)`, async ({ page }) => {
      const body = s.crop === 'body';
      // Body states compare the area under the header: the design draws a 68px header, the app's is 72px.
      const designH = body ? HEIGHT - (APP_HEADER - DESIGN_HEADER) : HEIGHT;
      const dTop = body ? DESIGN_HEADER : 0;
      const aTop = body ? APP_HEADER : 0;
      const dClip = { x: 0, y: dTop, width: WIDTH, height: designH - dTop };
      const aClip = { x: 0, y: aTop, width: WIDTH, height: HEIGHT - aTop };

      // Layout parts are measured under the header at equal body height (the header heights differ).
      await openDesign(page, s, HEIGHT - (APP_HEADER - DESIGN_HEADER));
      const dParts: Record<string, Box[]> = {};
      for (const [k, p] of Object.entries(PARTS)) dParts[k] = await boxes(page, p.design, !!p.all, DESIGN_HEADER);
      if (!body) await openDesign(page, s, designH);
      const design = await page.screenshot({ clip: dClip });
      const overlayKey = s.design.match(/(Model|Params|Confirm|Viewer)$/)?.[1]?.toLowerCase();
      const dOverlay = overlayKey ? await boxes(page, OVERLAY_PARTS[overlayKey]!.design, false, dTop) : [];
      let dAside: Buffer | undefined;
      let dAsideScroll = 0;
      if (s.mode === 'advanced') {
        dAsideScroll = await page.evaluate(() => {
          const a = document.querySelector('aside')!;
          a.scrollTop = a.scrollHeight;
          return a.scrollHeight;
        });
        dAside = await page.screenshot({ clip: { x: 0, y: dTop, width: 340, height: HEIGHT - APP_HEADER } });
      }

      await openApp(page, s);
      const app = await page.screenshot({ clip: aClip, animations: 'disabled' });
      mkdirSync(SCREENS_OUT, { recursive: true });
      writeFileSync(`${SCREENS_OUT}${s.id}.png`, app);
      writeFileSync(`${SCREENS_OUT}${s.id}-design.png`, design);
      for (const [k, p] of Object.entries(PARTS)) {
        const a = await boxes(page, p.app, !!p.all, APP_HEADER);
        expect(a.length, `${k} count`).toBe(dParts[k]!.length);
        a.forEach((b, i) => expectClose(b, dParts[k]![i]!, `${k}[${i}]`));
      }
      if (overlayKey) {
        const a = await boxes(page, OVERLAY_PARTS[overlayKey]!.app, false, aTop);
        expect(a.length, `${overlayKey} overlay present`).toBe(1);
        expectClose(a[0]!, dOverlay[0]!, `${overlayKey} overlay`);
      }

      const ratio = await pixelDiffRatio(page, app, design);
      test.info().annotations.push({ type: 'pixel-diff', description: `${s.id} ${(ratio * 100).toFixed(3)}%` });
      expect(ratio, `${s.id} pixel diff ${(ratio * 100).toFixed(3)}%`).toBeLessThanOrEqual(MAX_DIFF);

      if (dAside) {
        const scroll = await page.evaluate(() => {
          const a = document.querySelector('main aside')!;
          a.scrollTop = a.scrollHeight;
          return a.scrollHeight;
        });
        expect(Math.abs(scroll - dAsideScroll), `left panel scroll height app ${scroll} vs design ${dAsideScroll}`).toBeLessThanOrEqual(TOL);
        await page.waitForTimeout(50);
        const aAside = await page.screenshot({ clip: { x: 0, y: aTop, width: 340, height: HEIGHT - APP_HEADER }, animations: 'disabled' });
        writeFileSync(`${SCREENS_OUT}${s.id}-panel-end.png`, aAside);
        writeFileSync(`${SCREENS_OUT}${s.id}-panel-end-design.png`, dAside);
        const r2 = await pixelDiffRatio(page, aAside, dAside);
        test.info().annotations.push({ type: 'pixel-diff', description: `${s.id} panel end ${(r2 * 100).toFixed(3)}%` });
        expect(r2, `${s.id} panel end pixel diff ${(r2 * 100).toFixed(3)}%`).toBeLessThanOrEqual(MAX_DIFF);
      }
    });
  }
}

/** Animations running on an element: name, duration (ms), delay, keyframe easing and transforms. */
export async function animationsOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    return el.getAnimations().map((a) => {
      const e = a.effect as KeyframeEffect;
      const kf = e.getKeyframes();
      return {
        duration: Number(e.getComputedTiming().duration),
        delay: e.getTiming().delay ?? 0,
        easing: String(kf[0]?.easing ?? e.getTiming().easing),
        transforms: kf.map((k) => String(k.transform ?? 'none')),
        opacities: kf.map((k) => String(k.opacity ?? '')),
      };
    });
  }, selector);
}

export const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
export const EXIT = 'cubic-bezier(0.4, 0, 1, 1)';
