import { expect, test, type Page } from '@playwright/test';
import { asPlan } from './support/session';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE } from '../src/features/canvas/mocks';
import { buildDesignPage } from './support/design';
import { pixelDiffRatio, type Box } from './support/measure';

/**
 * Canvas (/p/:projectId) against Canvas.dc.html and its wrappers (CanvasAdd,
 * CanvasScript, CanvasShare, CanvasAt, CanvasPlan, CanvasEdit, CanvasEditAgent
 * → `initOverlay`). The app runs on the mock ProjectRoom; `mock=frozen` keeps
 * the running job at the design's 58%.
 */

const OUT = fileURLToPath(new URL('./__screens__/canvas/', import.meta.url));
const W = 1440;
const H = 900;
const TOL = 2;

/** Pixel-diff budget per state (fraction of pixels). Recorded values are in the annotations. */
const MAX_DIFF = 0.01;

type Overlay = '' | 'plan' | 'addMenu' | 'script' | 'share' | 'edit' | 'editAgent' | 'at';

async function openDesign(page: Page, initOverlay: Overlay = '') {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(buildDesignPage('Canvas.dc.html', { initOverlay }));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
}

async function openApp(page: Page, overlay: Overlay = '', mock = 'frozen') {
  await page.setViewportSize({ width: W, height: H });
  await page.goto(`/p/prj_demo?mock=${mock}${overlay ? `&overlay=${overlay}` : ''}`);
  await page.getByTestId('canvas').waitFor();
  await page.getByTestId(`node-${NODE.shotB}`).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(700, 880);
  // Let enter animations (≤ 320ms + stagger) finish.
  await page.waitForTimeout(400);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
}

/** Pixel diff with optional rectangles blanked in both images (regions another feature owns). */
async function diffRatio(page: Page, a: Buffer, b: Buffer, mask: Box[] = []): Promise<number> {
  if (!mask.length) return pixelDiffRatio(page, a, b);
  const blank = async (img: Buffer) =>
    Buffer.from(
      await page.evaluate(
        async ({ src, rects }) => {
          const im = new Image();
          await new Promise((r) => {
            im.onload = r;
            im.src = src;
          });
          const c = document.createElement('canvas');
          c.width = im.width;
          c.height = im.height;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(im, 0, 0);
          ctx.fillStyle = '#000';
          for (const r of rects) ctx.fillRect(r.x, r.y, r.width, r.height);
          return c.toDataURL('image/png').split(',')[1]!;
        },
        { src: `data:image/png;base64,${img.toString('base64')}`, rects: mask },
      ),
      'base64',
    );
  return pixelDiffRatio(page, await blank(a), await blank(b));
}

async function diffState(page: Page, name: string, overlay: Overlay, mask?: (page: Page) => Promise<Box[]>) {
  mkdirSync(OUT, { recursive: true });
  await openDesign(page, overlay);
  const design = await page.screenshot({ path: `${OUT}${name}-design.png` });
  await openApp(page, overlay);
  const rects = mask ? await mask(page) : [];
  const app = await page.screenshot({ path: `${OUT}${name}-app.png` });
  const ratio = await diffRatio(page, app, design, rects);
  test.info().annotations.push({ type: 'pixel-diff', description: `${name}: ${(ratio * 100).toFixed(3)}%` });
  console.log(`pixel-diff ${name}: ${(ratio * 100).toFixed(3)}%`);
  return ratio;
}

function expectBox(actual: Box, expected: Box, what: string, tol = TOL) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${what}.${k}: app ${actual[k].toFixed(1)} vs design ${expected[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

/** Finds the box of the element matching a CSS selector, or of the smallest element whose own text equals `text`. */
async function boxes(page: Page, parts: Record<string, { css?: string; text?: string; up?: number }>): Promise<Record<string, Box>> {
  return page.evaluate((p) => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [k, spec] of Object.entries(p)) {
      let el: Element | null = null;
      if (spec.css) el = document.querySelector(spec.css);
      else if (spec.text) {
        const all = Array.from(document.querySelectorAll('body *')).filter((e) => (e.textContent ?? '').trim() === spec.text);
        el = all[all.length - 1] ?? null;
      }
      for (let i = 0; el && i < (spec.up ?? 0); i++) el = el.parentElement;
      if (!el) throw new Error(`Missing ${k}`);
      const r = el.getBoundingClientRect();
      out[k] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return out;
  }, parts);
}

const roomCall = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window.__canvasRoom as unknown as Record<string, (...x: unknown[]) => unknown>)[f as string]!(...(a as unknown[])), [fn, args] as const);

async function portCenter(page: Page, nodeId: string, port: 'in' | 'out') {
  const b = (await page.getByTestId(`node-${nodeId}`).locator(`[data-port="${port}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.describe('canvas fidelity (1440×900)', () => {
  test('default state: pixel diff under 1% against Canvas.dc.html', async ({ page }) => {
    expect(await diffState(page, 'default', '')).toBeLessThan(MAX_DIFF);
  });

  for (const overlay of ['addMenu', 'script', 'share', 'at'] as const) {
    test(`${overlay} state: pixel diff under 1% against Canvas.dc.html initOverlay=${overlay}`, async ({ page }) => {
      expect(await diffState(page, overlay, overlay)).toBeLessThan(MAX_DIFF);
    });
  }

  test('plan state: scrim and canvas match CanvasPlan; the RunConfirm panel (features/overlays, not rendered by the design runtime) is masked', async ({ page }) => {
    const r = await diffState(page, 'plan', 'plan', async (p) => [(await p.getByTestId('plan-dialog').boundingBox())!]);
    expect(r).toBeLessThan(MAX_DIFF);
    await expect(page.getByTestId('plan-dialog')).toContainText('Run all');
    await expect(page.getByTestId('plan-dialog')).toContainText('Shot A: Hero shot');
  });

  for (const overlay of ['edit', 'editAgent'] as const) {
    test(`${overlay} state: the editor from features/canvas/editor mounts over the canvas`, async ({ page }) => {
      expect(await diffState(page, overlay, overlay)).toBeLessThan(MAX_DIFF);
    });
  }

  test('regions and controls are within 2px of the design', async ({ page }) => {
    const common = {
      logo: { css: 'a[aria-label="Back to Home"]' },
      project: { text: 'Ridgeline Sparkling · 15s ad' },
      saved: { text: 'Saved' },
      credits: { css: 'button[aria-label="Credit balance"]' },
      share: { text: 'Share' },
      toolbar: { css: '[role="toolbar"]' },
      zoomPill: { css: 'button[aria-label="Zoom out"]', up: 1 },
      minimap: { css: '[aria-label="Minimap"]' },
      agent: { css: 'aside[aria-label="Agent"]' },
      composer: { css: 'textarea', up: 1 },
      planBuild: { text: 'Build on canvas' },
      scriptBtn: { text: 'Generate storyboard · 2' },
      photoBody: { text: 'Product reference' },
      versionChip: { text: 'Current · 2/2' },
      duration: { text: '00:04' },
      progress: { text: '58%' },
      audioTime: { text: '00:08' },
      inputChanged: { text: 'Input changed' },
      generating: { text: 'Generating' },
      addRef: { css: 'button[aria-label="Add reference"]' },
      generate: { css: 'button[aria-label="Generate"]' },
      model: { text: 'Seedance 2.5' },
    };
    await openDesign(page);
    const design = await boxes(page, { ...common, runAll: { css: 'button[aria-expanded]:not([aria-label])' }, prompt: { css: '#prompt', up: 1 } });
    await openApp(page);
    const app = await boxes(page, { ...common, runAll: { css: 'button[aria-label^="Run all"]' }, prompt: { css: '[data-testid="prompt-panel"]' } });
    // The design's zoom label is a static "75%"; the app shows the real zoom (100%), so the pill is wider.
    expectBox({ ...app.zoomPill!, width: design.zoomPill!.width }, design.zoomPill!, 'zoomPill');
    for (const k of Object.keys(design).filter((k) => k !== 'zoomPill')) expectBox(app[k]!, design[k]!, k);
  });

  test('layers match the design boxes: add menu, script, share, @ picker', async ({ page }) => {
    const cases: Array<[Overlay, string, string]> = [
      ['addMenu', '[role="menu"]', '[role="menu"]'],
      ['script', '[role="dialog"][aria-label="Script"]', '[role="dialog"][aria-label="Script"]'],
      ['share', '[role="dialog"][aria-label="Share"]', '[role="dialog"][aria-labelledby="canvas-share-title"]'],
      ['at', '[role="dialog"][aria-label="Add a reference"]', '[data-testid="reference-picker"]'],
    ];
    for (const [overlay, dsel, asel] of cases) {
      await openDesign(page, overlay);
      const d = await boxes(page, { layer: { css: dsel } });
      await openApp(page, overlay);
      const a = await boxes(page, { layer: { css: asel } });
      expectBox(a.layer!, d.layer!, overlay);
    }
  });

  test('colors: page, agent panel, prompt panel, selected ring, cost chip, Input changed, Generating', async ({ page }) => {
    await openApp(page);
    const css = await page.evaluate(() => {
      const get = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : '');
      const byText = (t: string) => Array.from(document.querySelectorAll('span')).find((s) => s.textContent?.trim() === t) ?? null;
      return {
        agent: get(document.querySelector('aside[aria-label="Agent"]'), 'background-color'),
        prompt: get(document.querySelector('[data-testid="prompt-panel"]'), 'background-color'),
        inputChanged: get(byText('Input changed'), 'color'),
        generating: get(byText('Generating'), 'color'),
        ring: get(document.querySelector('.react-flow__node.selected [data-body]'), 'box-shadow'),
      };
    });
    expect(css.agent).toBe('rgb(20, 20, 22)');
    expect(css.prompt).toBe('rgb(22, 22, 24)');
    expect(css.inputChanged).toBe('rgb(255, 197, 61)');
    expect(css.generating).toBe('rgb(77, 156, 255)');
    expect(css.ring).toContain('rgb(59, 130, 246)');
  });
});

test.describe('canvas behavior', () => {
  test('node states from the snapshot: outdated, generating 58%, done with version, idle with cost', async ({ page }) => {
    await openApp(page);
    const a = page.getByTestId(`node-${NODE.shotA}`);
    await expect(a).toHaveAttribute('data-status', 'outdated');
    await expect(a).toContainText('Input changed');
    await expect(a.getByLabel('8 credits to run')).toBeVisible();
    const b = page.getByTestId(`node-${NODE.shotB}`);
    await expect(b).toHaveAttribute('data-status', 'generating');
    await expect(b).toContainText('58%');
    const k = page.getByTestId(`node-${NODE.keyframe}`);
    await expect(k).toContainText('Current · 2/2');
    await expect(k.getByLabel(/credits to run/)).toHaveCount(0);
    await expect(page.getByTestId(`node-${NODE.voice}`).getByLabel('2 credits to run')).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
  });

  test('connecting ports: a matching type connects and saves; the line is blue over a valid port', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('[data-testid^="edge-"]').count();
    const from = await portCenter(page, NODE.photo, 'out');
    const to = await portCenter(page, NODE.shotA, 'in');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect(page.getByTestId('connection-line')).toHaveAttribute('data-status', 'valid');
    await page.screenshot({ path: `${OUT}connecting-valid-app.png` });
    await page.mouse.up();
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(before + 1);
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    const rev = await page.evaluate(() => window.__canvasRoom!.state.revision);
    expect(rev).toBe(43);
  });

  test('refused connection: audio into an image node is refused with a reason, the port turns red, nothing changes', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('[data-testid^="edge-"]').count();
    const from = await portCenter(page, NODE.voice, 'out');
    const to = await portCenter(page, NODE.keyframe, 'in');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect(page.getByTestId('connection-line')).toHaveAttribute('data-status', 'invalid');
    await page.screenshot({ path: `${OUT}connecting-refused-app.png` });
    await page.mouse.up();
    await expect(page.getByText('Image nodes don’t take audio input.')).toBeVisible();
    const port = page.getByTestId(`node-${NODE.keyframe}`).locator('[data-port="in"]');
    await expect(port).toHaveCSS('box-shadow', /248, 113, 113/);
    await page.screenshot({ path: `${OUT}connection-refused-toast-app.png` });
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(before);
    expect(await page.evaluate(() => window.__canvasRoom!.state.revision)).toBe(42);
  });

  test('generate: real progress fills linearly, then the result fades in and the cost chip goes away', async ({ page }) => {
    await openApp(page, '', 'fast');
    const a = page.getByTestId(`node-${NODE.shotA}`);
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(a).toHaveAttribute('data-status', 'generating');
    await expect(a).toContainText('Generating');
    const widths: number[] = [];
    for (let i = 0; i < 6; i++) {
      const w = await a.evaluate((el) => {
        if (el.getAttribute('data-status') !== 'generating') return NaN;
        return parseFloat((el.querySelector('[data-body] > div') as HTMLElement).style.width);
      });
      if (!Number.isNaN(w)) widths.push(w);
      await page.waitForTimeout(100);
    }
    expect(widths.length).toBeGreaterThan(1);
    expect(widths.every((w, i) => i === 0 || w >= widths[i - 1]!)).toBe(true);
    await page.screenshot({ path: `${OUT}node-generating-app.png` });
    await expect(a).toHaveAttribute('data-status', 'done', { timeout: 5000 });
    await expect(a.getByLabel(/credits to run/)).toHaveCount(0);
    await expect(a.locator('.rl-reveal')).toHaveCount(1);
    await expect(a).toContainText('00:04');
    await page.screenshot({ path: `${OUT}node-done-app.png` });
  });

  test('failed with refund: the node and a toast say the credits were refunded, Retry starts it again', async ({ page }) => {
    await openApp(page);
    await roomCall(page, 'failJob', NODE.shotB);
    const b = page.getByTestId(`node-${NODE.shotB}`);
    await expect(b).toHaveAttribute('data-status', 'failed');
    await expect(b).toContainText('Failed');
    await expect(b).toContainText('8 credits refunded');
    await expect(page.getByText('Shot B: Cap pop failed. 8 credits refunded.')).toBeVisible();
    await page.screenshot({ path: `${OUT}node-failed-app.png` });
    await b.getByRole('button', { name: 'Retry' }).click();
    await expect(b).toHaveAttribute('data-status', 'generating');
  });

  test('editing an input marks downstream results “Input changed”; delete, undo and redo go out as patches', async ({ page }) => {
    await openApp(page);
    await page.getByTestId(`node-${NODE.photo}`).click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('Delete');
    await expect(page.getByTestId(`node-${NODE.photo}`)).toHaveCount(0);
    await expect(page.getByTestId(`node-${NODE.keyframe}`)).toHaveAttribute('data-status', 'outdated');
    await expect(page.getByText('Node deleted')).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId(`node-${NODE.photo}`)).toBeVisible();
    await expect(page.getByTestId(`node-${NODE.keyframe}`)).toHaveAttribute('data-status', 'done');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId(`node-${NODE.photo}`)).toHaveCount(0);
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    expect(await page.evaluate(() => window.__canvasRoom!.state.revision)).toBe(45);
  });

  test('agent Build on canvas applies the plan proposal as a grouped patch; nodes build 150ms apart and edges draw after', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Build on canvas' }).click();
    await expect(page.getByText('6 nodes added to the canvas. Nothing was charged.')).toBeVisible();
    const built = page.locator('.react-flow__node .rl-build');
    await expect(built).toHaveCount(6);
    const delays = await built.evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay));
    expect(delays).toEqual(['0s', '0.15s', '0.3s', '0.45s', '0.6s', '0.75s']);
    await expect(page.locator('[data-testid^="group-"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="edge-"] path[pathLength]')).toHaveCount(3);
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    expect(await page.evaluate(() => window.__canvasRoom!.state.nodes.length)).toBe(12);
    expect(await page.evaluate(() => window.__canvasRoom!.state.groups.length)).toBe(1);
  });

  test('add node menu: suggests the selected kind, adds a node at the drop point and selects it', async ({ page }) => {
    await openApp(page, 'addMenu');
    const menu = page.getByRole('menu', { name: 'Add node' });
    await expect(menu.locator('[data-active]')).toHaveText(/Video/);
    await menu.getByRole('menuitem', { name: /Image/ }).click();
    await expect(menu).toHaveCount(0);
    const added = page.locator('.react-flow__node.selected [data-node-kind="image"]');
    await expect(added).toContainText('New image');
    await page.waitForTimeout(400);
    const box = (await added.boundingBox())!;
    expect(Math.abs(box.x - 360)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - 500)).toBeLessThanOrEqual(1);
  });

  test('resolution caps (D-006): on Starter, 1080p and 4K are locked and name the plan that unlocks them', async ({ page }) => {
    await asPlan(page, 'starter');
    await openApp(page);
    await page.getByRole('button', { name: '9:16 · 720p · 5s' }).click();
    const menu = page.getByRole('menu', { name: 'Resolution' });
    await expect(menu.getByRole('menuitemradio', { name: '720p' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: '1080p, Available on Plus' })).toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByRole('menuitemradio', { name: '4K, Available on Pro' })).toHaveAttribute('aria-disabled', 'true');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}resolution-locked-app.png` });
    await menu.getByRole('menuitemradio', { name: '1080p, Available on Plus' }).click({ force: true });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: '480p' }).click();
    await expect(page.getByRole('button', { name: '9:16 · 480p · 5s' })).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
  });

  test('agent is members-only (D-007): a non-member can type, Send opens the join paywall and keeps the draft; after checkout it sends', async ({ page }) => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto('/p/prj_demo?mock=frozen&member=0');
    await page.getByTestId(`node-${NODE.shotB}`).waitFor();
    const ask = page.getByLabel('Tell the agent');
    await ask.fill('Make shot 2 slower.');
    await page.getByRole('button', { name: 'Send' }).click();
    const paywall = page.getByRole('dialog', { name: 'Pick a plan to generate' });
    await expect(paywall).toBeVisible();
    await expect(ask).toHaveValue('Make shot 2 slower.');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}agent-paywall-app.png` });
    await paywall.getByRole('button', { name: /^Continue with/ }).click();
    await expect(paywall).toHaveCount(0);
    await expect(page.locator('aside[aria-label="Agent"]')).toContainText('Make shot 2 slower.');
    await expect(ask).toHaveValue('');
  });

  test('Run all opens the quote; running it starts every node that needs a run', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /^Run all/ }).click();
    const dialog = page.getByTestId('plan-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Run · 18 credits/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`node-${NODE.shotA}`)).toHaveAttribute('data-status', 'generating');
    await expect(page.getByTestId(`node-${NODE.voice}`)).toHaveAttribute('data-status', 'generating');
  });

  test('layers close on Escape with an exit animation; the agent panel hides and the top bar moves', async ({ page }) => {
    await openApp(page, 'share');
    const share = page.locator('[role="dialog"][aria-labelledby="canvas-share-title"]');
    await expect(share).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(share).toHaveAttribute('data-state', 'closed');
    await expect(share).toHaveCount(0);

    // The exit lasts 140ms; read the state in the same frame as the click.
    const exitState = await page.evaluate(async () => {
      (document.querySelector('button[aria-label="Hide agent"]') as HTMLElement).click();
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      const aside = document.querySelector('aside[aria-label="Agent"]');
      return { state: aside?.getAttribute('data-state'), anim: aside?.getAnimations().map((x) => (x as CSSAnimation).animationName) };
    });
    expect(exitState).toEqual({ state: 'closed', anim: ['rl-panel-out'] });
    await expect(page.locator('aside[aria-label="Agent"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    const credits = (await page.getByRole('button', { name: 'Credit balance' }).boundingBox())!;
    const agentBtn = (await page.getByRole('button', { name: 'Agent', exact: true }).boundingBox())!;
    expect(credits.x).toBeGreaterThan(1000);
    expect(Math.abs(W - 16 - (agentBtn.x + agentBtn.width))).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.locator('aside[aria-label="Agent"]')).toBeVisible();
  });

  test('credits popover and run history drawer', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Credit balance' }).click();
    const pop = page.getByRole('dialog', { name: 'Credit balance' });
    await expect(pop).toContainText('Available credits');
    await expect(pop).toContainText('Expires Nov 30');
    expect((await pop.boundingBox())!.width).toBe(372);
    await page.screenshot({ path: `${OUT}credits-app.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Run history' }).click();
    const drawer = page.getByRole('region', { name: 'Run history' });
    await expect(drawer).toContainText('Shot B: Cap pop');
    await expect(drawer).toContainText('Running · 58%');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}history-app.png` });
  });
});

test.describe('reduced motion', () => {
  test('popovers and node builds become opacity-only fades', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await page.getByRole('button', { name: 'Add node' }).click();
    const menuStart = await page.getByRole('menu', { name: 'Add node' }).evaluate((el) => {
      const anims = el.getAnimations();
      anims.forEach((a) => {
        a.pause();
        a.currentTime = 0;
      });
      const cs = getComputedStyle(el);
      return { n: anims.length, transform: cs.transform, opacity: Number(cs.opacity) };
    });
    expect(menuStart.n).toBeGreaterThan(0);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(menuStart.transform);
    expect(menuStart.opacity).toBeLessThan(1);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Build on canvas' }).click();
    const node = page.locator('.react-flow__node .rl-build').first();
    const nodeStart = await node.evaluate((el) => {
      const a = el.getAnimations()[0]!;
      a.pause();
      a.currentTime = 0;
      const cs = getComputedStyle(el);
      return { transform: cs.transform, opacity: Number(cs.opacity) };
    });
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(nodeStart.transform);
    expect(nodeStart.opacity).toBe(0);
  });
});

test('with full motion a built node settles from 96% scale', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Build on canvas' }).click();
  const start = await page.locator('.react-flow__node .rl-build').first().evaluate((el) => {
    const a = el.getAnimations()[0]!;
    a.pause();
    a.currentTime = 0;
    return getComputedStyle(el).transform;
  });
  expect(start).toBe('matrix(0.96, 0, 0, 0.96, 0, 0)');
});
