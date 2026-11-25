import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { pixelDiffRatio, type Box } from './support/measure';

/**
 * Editor overlay (CanvasEdit.dc.html, CanvasEditAgent.dc.html), rendered full
 * screen by the dev route /dev/editor.
 */

const SCREENS_OUT = fileURLToPath(new URL('./__screens__/editor/', import.meta.url));
const TOLERANCE = 2;
const W = 1440;
const H = 900;

type EditorState = 'edit' | 'editAgent';

async function openApp(page: Page, state: EditorState = 'edit') {
  await page.setViewportSize({ width: W, height: H });
  await page.goto(state === 'editAgent' ? '/dev/editor?state=agent' : '/dev/editor');
  await page.locator('[data-testid="editor"][data-shown="true"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (state === 'editAgent') await page.locator('[role="dialog"][aria-label="Proposed edit"][data-shown="true"]').waitFor();
  // Let enter transitions (320ms panel, 200ms card) settle and park the pointer on the monitor.
  await page.mouse.move(700, 200);
  await page.waitForTimeout(450);
}

async function openDesign(page: Page, state: EditorState = 'edit') {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(buildDesignPage('Canvas.dc.html', { initOverlay: state }));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
}

function expectBoxClose(actual: Box, expected: Box, what: string, tol = TOLERANCE) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${what}.${k}: app ${actual[k].toFixed(1)} vs design ${expected[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

/** Main regions and controls, located by role and label in both the design and the app. */
const REGIONS: Array<[string, string]> = [
  ['editor', 'section[aria-label="Editor"]'],
  ['bin', 'aside[aria-label="Project"]'],
  ['monitor', 'section[aria-label="Program monitor"]'],
  ['inspector', 'aside[aria-label="Inspector"]'],
  ['timeline', 'section[aria-label="Timeline"]'],
  ['play', 'button[aria-label="Play"]'],
  ['mark in', 'button[aria-label="Mark in"]'],
  ['mark out', 'button[aria-label="Mark out"]'],
  ['undo', 'button[aria-label="Undo"]'],
  ['redo', 'button[aria-label="Redo"]'],
  ['select tool', 'button[aria-label="Select (V)"]'],
  ['hand tool', 'button[aria-label="Hand (H)"]'],
  ['snapping', 'button[aria-label="Snapping"]'],
  ['effects', 'button[aria-label="Effects"]'],
  ['agent input', '#edask'],
  ['send', 'button[aria-label="Send"]'],
  ['zoom out', 'button[aria-label="Zoom out"]'],
  ['zoom in', 'button[aria-label="Zoom in"]'],
  ['meter', '[aria-label="Audio meter"]'],
];

async function measure(page: Page, selectors: Array<[string, string]>) {
  return page.evaluate((sels) => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [name, sel] of sels) {
      const root = document.querySelector('section[aria-label="Editor"]')!;
      const el = sel.startsWith('section[aria-label="Editor"]') ? root : root.querySelector(sel);
      if (!el) throw new Error(`Missing ${name}: ${sel}`);
      const r = el.getBoundingClientRect();
      out[name] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return out;
  }, selectors);
}

/** Text-labelled controls, found by their visible text. */
async function measureByText(page: Page, texts: string[]) {
  return page.evaluate((list) => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const all = Array.from(document.querySelector('section[aria-label="Editor"]')!.querySelectorAll('button, span'));
    for (const text of list) {
      const el = all.find((e) => (e.textContent ?? '').trim() === text && (e.tagName === 'BUTTON' || e.children.length === 0));
      if (!el) throw new Error(`Missing text ${text}`);
      const r = el.getBoundingClientRect();
      out[text] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return out;
  }, texts);
}

const TEXT_CONTROLS = ['Canvas', 'Reassemble', 'Export', 'Regenerate shot8 credits', 'Open on canvas', 'Shot A, hero', '00:00:12:00'];

test.describe('editor', () => {
  for (const state of ['edit', 'editAgent'] as const) {
    test(`${state}: screenshot at 1440x900 differs from the design in at most 1% of pixels`, async ({ page }) => {
      await openDesign(page, state);
      const design = await page.screenshot();
      await openApp(page, state);
      const app = await page.screenshot();
      mkdirSync(SCREENS_OUT, { recursive: true });
      await page.screenshot({ path: `${SCREENS_OUT}${state}-1440.png` });
      await openDesign(page, state);
      await page.screenshot({ path: `${SCREENS_OUT}${state}-1440-design.png` });
      const ratio = await pixelDiffRatio(page, app, design);
      test.info().annotations.push({ type: 'pixel-diff', description: `${(ratio * 100).toFixed(3)}%` });
      console.log(`[pixel-diff] editor ${state}: ${(ratio * 100).toFixed(3)}%`);
      expect(ratio, `pixel diff ${(ratio * 100).toFixed(3)}%`).toBeLessThanOrEqual(0.01);
    });
  }

  test('regions and controls match CanvasEdit.dc.html within 2px', async ({ page }) => {
    await openDesign(page, 'edit');
    const design = { ...(await measure(page, REGIONS)), ...(await measureByText(page, TEXT_CONTROLS)) };
    await openApp(page, 'edit');
    const app = { ...(await measure(page, REGIONS)), ...(await measureByText(page, TEXT_CONTROLS)) };
    for (const name of Object.keys(design)) expectBoxClose(app[name]!, design[name]!, name);
  });

  test('proposal card matches CanvasEditAgent.dc.html within 2px', async ({ page }) => {
    const sel: Array<[string, string]> = [
      ['card', '[role="dialog"][aria-label="Proposed edit"]'],
      ['agent input', '#edask'],
    ];
    await openDesign(page, 'editAgent');
    const design = { ...(await measure(page, sel)), ...(await measureByText(page, ['Apply', 'Discard'])) };
    await openApp(page, 'editAgent');
    const app = { ...(await measure(page, sel)), ...(await measureByText(page, ['Apply', 'Discard'])) };
    for (const name of Object.keys(design)) expectBoxClose(app[name]!, design[name]!, name);
    await expect(page.locator('#edask')).toHaveValue('cut to 10s');
  });
});

/* ---------- interactions ---------- */

/** Video row center and other lane geometry at 100px/s (see timeline/geometry.ts). */
const ROW_Y = { caption: 27 + 16, video: 60 + 32, voice: 125 + 22, music: 170 + 22 };

async function lanes(page: Page) {
  return (await page.getByTestId('timeline-canvas').boundingBox())!;
}

/** Page point for a time (s) and lane y on the timeline canvas. */
async function at(page: Page, t: number, y: number) {
  const b = await lanes(page);
  return { x: b.x + t * 100, y: b.y + y };
}

async function drag(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 6, from.y);
  await page.mouse.up();
}

const clip = (page: Page, label: string) => page.getByRole('list', { name: 'Clips' }).getByRole('button', { name: label, exact: true });

/** Reads one canvas pixel (CSS coordinates inside the lanes) as [r, g, b]. */
async function canvasPixel(page: Page, x: number, y: number) {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('[data-testid="timeline-canvas"] canvas') as HTMLCanvasElement;
      const dpr = c.width / c.getBoundingClientRect().width;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(x! * dpr), Math.round(y! * dpr), 1, 1).data.slice(0, 3));
    },
    [x, y],
  );
}

const hex = (rgb: number[]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

test.describe('editor timeline', () => {
  test('opens with the assembled cut: 12s, Shot A selected, playhead at 00:00:02:14', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('monitor-timecode')).toHaveText('00:00:02:14');
    await expect(clip(page, 'Shot A, hero, 00:00:00:00 to 00:00:04:00')).toHaveAttribute('aria-pressed', 'true');
    await expect(clip(page, 'Shot C, logo, 00:00:09:00 to 00:00:12:00')).toBeAttached();
    await expect(page.getByText('00:00:12:00', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('monitor-caption')).toHaveText('Morning. The first sip of the mountains.');
  });

  test('trim: dragging the tail of Shot B 1s left shortens it to 4s', async ({ page }) => {
    await openApp(page);
    const p = await at(page, 9 - 0.02, ROW_Y.video);
    await drag(page, p, -100);
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:08:00')).toBeAttached();
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:08:00')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('section[aria-label="Inspector"], aside[aria-label="Inspector"]').getByText('Shot B, cap pop')).toBeVisible();
    // Undo restores it.
    await page.keyboard.press('Control+z');
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:09:00')).toBeAttached();
  });

  test('trim: the head of a caption trims its start', async ({ page }) => {
    await openApp(page);
    await drag(page, await at(page, 4.6 + 0.02, ROW_Y.caption), 40);
    await expect(clip(page, 'Pop it open., 00:00:05:00 to 00:00:06:14')).toBeAttached();
  });

  test('move: dragging a caption moves it by whole frames', async ({ page }) => {
    await openApp(page);
    await drag(page, await at(page, 5.5, ROW_Y.caption), 50);
    await expect(clip(page, 'Pop it open., 00:00:05:02 to 00:00:07:02')).toBeAttached();
  });

  test('move: snapping pulls a clip edge onto the cut at 4s, and is off when snapping is off', async ({ page }) => {
    await openApp(page);
    await drag(page, await at(page, 5.5, ROW_Y.caption), -55);
    await expect(clip(page, 'Pop it open., 00:00:04:00 to 00:00:06:00')).toBeAttached();
    await page.keyboard.press('Control+z');
    await page.getByRole('button', { name: 'Snapping' }).click();
    await expect(page.getByRole('button', { name: 'Snapping' })).toHaveAttribute('aria-pressed', 'false');
    await drag(page, await at(page, 5.5, ROW_Y.caption), -55);
    await expect(clip(page, 'Pop it open., 00:00:04:01 to 00:00:06:01')).toBeAttached();
  });

  test('move: a clip stops at its neighbour instead of overlapping', async ({ page }) => {
    await openApp(page);
    await drag(page, await at(page, 5.5, ROW_Y.caption), -300);
    await expect(clip(page, 'Pop it open., 00:00:04:00 to 00:00:06:00')).toBeAttached();
  });

  test('split: the razor cuts Shot A at the pointer; Cmd/Ctrl+K cuts at the playhead', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Razor (C)' }).click();
    await expect(page.getByRole('button', { name: 'Razor (C)' })).toHaveAttribute('aria-pressed', 'true');
    const p = await at(page, 1.5, ROW_Y.video);
    await page.mouse.click(p.x, p.y);
    await expect(clip(page, 'Shot A, hero, 00:00:00:00 to 00:00:01:12')).toBeAttached();
    await expect(clip(page, 'Shot A, hero, 00:00:01:12 to 00:00:04:00')).toBeAttached();
    await page.keyboard.press('v');
    const b = await at(page, 6, ROW_Y.voice);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Control+k');
    await expect(clip(page, 'Voiceover, 00:00:00:09 to 00:00:02:14')).toBeAttached();
  });

  test('ripple delete: deleting Shot B pulls Shot C back to 4s; Alt+Delete leaves the gap', async ({ page }) => {
    await openApp(page);
    const p = await at(page, 6, ROW_Y.video);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Delete');
    await expect(clip(page, 'Shot C, logo, 00:00:04:00 to 00:00:07:00')).toBeAttached();
    await expect(page.getByRole('list', { name: 'Clips' }).getByRole('button', { name: /^Shot B/ })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Alt+Delete');
    await expect(clip(page, 'Shot C, logo, 00:00:09:00 to 00:00:12:00')).toBeAttached();
  });

  test('scrub: clicking and dragging on the ruler moves the playhead and the timecodes', async ({ page }) => {
    await openApp(page);
    const b = await lanes(page);
    await page.mouse.move(b.x + 500, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 650, b.y + 10);
    await page.mouse.up();
    await expect(page.getByTestId('monitor-timecode')).toHaveText('00:00:06:12');
    await expect(page.getByTestId('monitor-caption')).toHaveText('Pop it open.');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('monitor-timecode')).toHaveText('00:00:06:13');
  });

  test('zoom: buttons and slider change the scale; the clip stays 4s long', async ({ page }) => {
    await openApp(page);
    const slider = page.getByRole('slider', { name: 'Zoom' });
    await expect(slider).toHaveAttribute('aria-valuenow', '58');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(58);
    // Zoom keeps the playhead (2.6s) in place, so the view scrolls by 2.6 * 125 - 260 = 65px.
    // Shot B (teal tiles) now ends at 9 * 125 - 65 = 1060px; at 100px/s that spot was Shot C's hatch.
    await page.waitForTimeout(100);
    expect(['#2C4850', '#31525A', '#294248']).toContain(hex(await canvasPixel(page, 9 * 125 - 65 - 12, ROW_Y.video + 20)));
    // The playhead did not move on screen.
    expect(hex(await canvasPixel(page, 260, 100))).toBe('#60A5FA');
    await expect(clip(page, 'Shot A, hero, 00:00:00:00 to 00:00:04:00')).toBeAttached();
  });

  test('play advances the playhead and the monitor', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Pause' }).click();
    const tc = await page.getByTestId('monitor-timecode').textContent();
    expect(tc! > '00:00:02:14').toBe(true);
  });

  test('generate: the not-generated shot gets its media and keeps its place', async ({ page }) => {
    await openApp(page);
    const gen = page.getByRole('button', { name: 'Generate · 8 credits' });
    await expect(gen).toBeVisible();
    await gen.click();
    await expect(gen).toHaveAttribute('aria-busy', 'true');
    await expect(gen).toHaveCount(0, { timeout: 5000 });
    await expect(clip(page, 'Shot C, logo, 00:00:09:00 to 00:00:12:00')).toBeAttached();
  });
});

test.describe('editor agent proposal', () => {
  test('asking for “cut to 10s” shows the proposal with outlines; Apply trims, Undo restores', async ({ page }) => {
    // A controlled clock makes the 320ms edit tween observable frame by frame.
    await page.clock.install();
    await openApp(page);
    await page.clock.pauseAt(Date.now() + 2000);
    await page.locator('#edask').fill('cut to 10s');
    await page.keyboard.press('Enter');
    await page.clock.runFor(600);
    const card = page.getByRole('dialog', { name: 'Proposed edit' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('You asked: cut to 10s');
    await expect(card).toContainText('Trim 2 seconds, no regeneration needed');
    await expect(card.getByRole('button', { name: 'Apply' })).toBeFocused();
    await page.clock.runFor(300);
    // The removed second of Shot B (8–9s) is outlined in red over the clip.
    const outlined = await canvasPixel(page, 850, ROW_Y.video + 15);
    expect(outlined[0]).toBeGreaterThan(outlined[2]!);
    // Nothing changed yet.
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:09:00')).toBeAttached();

    await card.getByRole('button', { name: 'Apply' }).click();
    // 80ms into the 320ms edit Shot C is still sliding in from 9–12s.
    await page.clock.runFor(80);
    const mid = hex(await canvasPixel(page, 1020, ROW_Y.video + 25));
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:08:00')).toBeAttached();
    await expect(clip(page, 'Shot C, logo, 00:00:08:00 to 00:00:10:00')).toBeAttached();
    await expect(page.getByText('00:00:10:00', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Edit applied')).toBeVisible();
    await page.clock.runFor(400);
    await expect(card).toHaveCount(0);
    const end = hex(await canvasPixel(page, 1020, ROW_Y.video + 25));
    // Shot C still covered 10.2s early on; at the end it stops at 10s.
    expect(mid).not.toBe('#111113');
    expect(end).toBe('#111113');

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:09:00')).toBeAttached();
  });

  test('Discard drops the proposal and leaves the timeline as it was', async ({ page }) => {
    await openApp(page, 'editAgent');
    const card = page.getByRole('dialog', { name: 'Proposed edit' });
    await card.getByRole('button', { name: 'Discard' }).click();
    await expect(card).toHaveCount(0);
    await expect(clip(page, 'Shot B, cap pop, 00:00:04:00 to 00:00:09:00')).toBeAttached();
  });

  test('the proposal card enters with 200ms standard and leaves with 140ms exit', async ({ page }) => {
    await page.clock.install();
    await openApp(page, 'editAgent');
    await page.clock.pauseAt(Date.now() + 2000);
    const card = page.getByRole('dialog', { name: 'Proposed edit' });
    const enter = await card.evaluate((el) => getComputedStyle(el).transition);
    expect(enter).toContain('0.2s cubic-bezier(0.2, 0, 0, 1)');
    await card.getByRole('button', { name: 'Discard' }).click();
    const exit = await card.evaluate((el) => getComputedStyle(el).transition);
    expect(exit).toContain('0.14s cubic-bezier(0.4, 0, 1, 1)');
  });
});

test.describe('editor motion and rendering', () => {
  test('editor panel enters with 320ms standard, 8px rise', async ({ page }) => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto('/dev/editor');
    const root = page.getByTestId('editor');
    await root.waitFor();
    const t = await root.evaluate((el) => getComputedStyle(el).transition);
    expect(t).toContain('opacity 0.32s cubic-bezier(0.2, 0, 0, 1)');
    expect(t).toContain('transform 0.32s cubic-bezier(0.2, 0, 0, 1)');
  });

  test('reduced motion: opacity only, and timeline edits jump into place', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: W, height: H } });
    const page = await context.newPage();
    await page.goto('/dev/editor?state=agent');
    const root = page.getByTestId('editor');
    await root.waitFor();
    expect(await root.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    expect(await root.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('opacity');
    const card = page.getByRole('dialog', { name: 'Proposed edit' });
    await card.waitFor();
    expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    expect(await card.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('opacity');
    await page.waitForTimeout(300);
    await card.getByRole('button', { name: 'Apply' }).click();
    await page.waitForTimeout(40);
    // Shot C already ends at 10s on the first frames: 11.5s is empty.
    expect(hex(await canvasPixel(page, 1150, ROW_Y.video + 25))).toBe('#111113');
    await context.close();
  });

  test('the timeline canvas is drawn at devicePixelRatio and stays crisp at 2x', async ({ browser }) => {
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: W, height: H } });
      const page = await context.newPage();
      await page.goto('/dev/editor');
      await page.locator('[data-testid="editor"][data-shown="true"]').waitFor();
      await page.waitForTimeout(400);
      const size = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="timeline-canvas"] canvas') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        return { w: c.width, h: c.height, cw: r.width, ch: r.height };
      });
      expect(size.w).toBe(Math.round(size.cw * dpr));
      expect(size.h).toBe(Math.round(size.ch * dpr));
      // The 1px rule under the captions row (y 59) fills exactly `dpr` device rows.
      const rows = await page.evaluate(
        ([d]) => {
          const c = document.querySelector('[data-testid="timeline-canvas"] canvas') as HTMLCanvasElement;
          const data = c.getContext('2d')!.getImageData(Math.round(20 * d!), Math.round(58 * d!), 1, Math.round(3 * d!)).data;
          const out: string[] = [];
          for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, '0')).join(''));
          return out;
        },
        [dpr],
      );
      const expected = [...Array(dpr).fill('111113'), ...Array(dpr).fill('1f1f23'), ...Array(dpr).fill('111113')];
      expect(rows).toEqual(expected);
      if (dpr === 2) await page.screenshot({ path: `${SCREENS_OUT}edit-1440@2x.png` });
      await context.close();
    }
  });
});
