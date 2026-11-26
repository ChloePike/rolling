import { picker as pickerDialog } from './support/picker';
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
    // Run all's estimate uses D-006 credits (~353, the design shows the old ~10), so its badge is wider and the
    // right-anchored cluster starts further left: compare its right edge, and credits/share by size and gap.
    expect(Math.abs(app.runAll!.x + app.runAll!.width - (design.runAll!.x + design.runAll!.width))).toBeLessThanOrEqual(TOL);
    for (const k of ['credits', 'share'] as const) {
      expect(Math.abs(app[k]!.width - design[k]!.width), `${k}.width`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(app[k]!.y - design[k]!.y), `${k}.y`).toBeLessThanOrEqual(TOL);
    }
    expect(Math.abs(app.runAll!.x - (app.share!.x + app.share!.width) - (design.runAll!.x - (design.share!.x + design.share!.width)))).toBeLessThanOrEqual(TOL);
    // The D-006 cost chip ("347" vs the design's "8") is wider, so "Input changed" left of it starts further left.
    for (const k of ['inputChanged', 'generating'] as const) expect(Math.abs(app[k]!.y - design[k]!.y), `${k}.y`).toBeLessThanOrEqual(TOL);
    const skip = new Set(['zoomPill', 'runAll', 'credits', 'share', 'inputChanged', 'generating']);
    for (const k of Object.keys(design).filter((k) => !skip.has(k))) expectBox(app[k]!, design[k]!, k);
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
    await expect(a.getByLabel('347 credits to run')).toBeVisible();
    const b = page.getByTestId(`node-${NODE.shotB}`);
    await expect(b).toHaveAttribute('data-status', 'generating');
    await expect(b).toContainText('58%');
    const k = page.getByTestId(`node-${NODE.keyframe}`);
    await expect(k).toContainText('Current · 2/2');
    await expect(k.getByLabel(/credits to run/)).toHaveCount(0);
    await expect(page.getByTestId(`node-${NODE.voice}`).getByLabel('6 credits to run')).toBeVisible();
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
    // 347 credits is over the 300 confirm threshold (D-006): the run confirm comes first.
    const confirm = page.getByRole('dialog', { name: 'Confirm', exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /^Generate · 347 credits/ }).click();
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
    await expect(b).toContainText('347 credits refunded');
    await expect(page.getByText('Shot B: Cap pop failed. 347 credits refunded.')).toBeVisible();
    await page.screenshot({ path: `${OUT}node-failed-app.png` });
    await b.getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: /^Generate · 347 credits/ }).click();
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
    await expect(menu.getByRole('menuitemradio', { name: '1080p, Available on Plus' })).toHaveAttribute('data-locked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: '4K, Available on Pro' })).toHaveAttribute('data-locked', 'true');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}resolution-locked-app.png` });
    // A locked option opens the upgrade modal in place (Esc keeps everything as it was).
    await menu.getByRole('menuitemradio', { name: '1080p, Available on Plus' }).click();
    await expect(page.getByRole('dialog', { name: '1080p needs Plus' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '1080p needs Plus' })).toHaveCount(0);
    await page.getByRole('button', { name: '9:16 · 720p · 5s' }).click();
    await page.getByRole('menu', { name: 'Resolution' }).getByRole('menuitemradio', { name: '480p' }).click();
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
    const paywall = page.getByRole('dialog', { name: 'The agent needs a plan' });
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
    await dialog.getByRole('button', { name: /^Run · 700 credits/ }).click();
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

/* ---------- Interaction pass: every control does something (docs/interaction-pass.md) ---------- */

const balance = (page: Page) => page.getByTestId('credits-balance');
const nodeMenu = async (page: Page, nodeId: string) => {
  await page.getByTestId(`node-${nodeId}`).click({ button: 'right', position: { x: 60, y: 8 } });
  const menu = page.getByTestId('menu-node');
  await expect(menu).toBeVisible();
  return menu;
};

test.describe('canvas controls', () => {
  test('project menu: Rename edits the title in place and it survives a reload', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /^Project:/ }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const input = page.getByLabel('Project name');
    await input.fill('Ridgeline spring ad');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Project: Ridgeline spring ad' })).toBeVisible();
    await expect(page.getByText('Renamed to Ridgeline spring ad')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Project: Ridgeline spring ad' })).toBeVisible();
  });

  test('share: copy link toasts, downloads toggle persists, stop sharing turns the link off, share again restores it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page, 'share');
    const dialog = page.locator('[role="dialog"][aria-labelledby="canvas-share-title"]');
    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://studio.aigc.hub/s/7Kq2-mXa9');
    const downloads = dialog.getByRole('switch', { name: 'Allow downloads' });
    await expect(downloads).toHaveAttribute('aria-checked', 'false');
    await downloads.click();
    await expect(downloads).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: /^Who can view/ }).click();
    await page.getByRole('menuitemradio', { name: 'Workspace members' }).click();
    await expect(dialog).toContainText('Only members of this workspace can open the link');
    await dialog.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(dialog.getByTestId('share-link')).toHaveText('No link. Sharing is off.');
    await expect(page.getByText('Sharing stopped. The link no longer opens.')).toBeVisible();
    await page.goto('/p/prj_demo?mock=frozen');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const again = page.locator('[role="dialog"][aria-labelledby="canvas-share-title"]');
    await expect(again.getByRole('switch', { name: 'Allow downloads' })).toHaveAttribute('aria-checked', 'true');
    await again.getByRole('button', { name: 'Share again' }).click();
    await expect(again.getByTestId('share-link')).toContainText('studio.aigc.hub/s/');
    await expect(page.getByText('Sharing is on with a new link')).toBeVisible();
  });

  test('run a node under the threshold: credits are held then settled; a forced failure refunds them', async ({ page }) => {
    await openApp(page, '', 'fast');
    await expect(balance(page)).toHaveText('2,480');
    await page.getByTestId(`node-${NODE.voice}`).getByLabel('6 credits to run').click();
    await expect(page.getByTestId(`node-${NODE.voice}`)).toHaveAttribute('data-status', 'generating');
    await expect(balance(page)).toHaveText('2,474');
    await expect(page.getByTestId(`node-${NODE.voice}`)).not.toHaveAttribute('data-status', 'generating', { timeout: 8000 });
    await expect(balance(page)).toHaveText('2,474');

    await page.goto('/p/prj_demo?mock=fail');
    await page.getByTestId(`node-${NODE.voice}`).getByLabel('6 credits to run').click();
    await expect(page.getByTestId(`node-${NODE.voice}`)).toHaveAttribute('data-status', 'failed', { timeout: 8000 });
    await expect(page.getByText('Voiceover failed. 6 credits refunded.')).toBeVisible();
  });

  test('run over the threshold asks first; cancel runs nothing', async ({ page }) => {
    await openApp(page);
    await page.getByTestId(`node-${NODE.shotA}`).getByLabel('347 credits to run').click();
    const confirm = page.getByRole('dialog', { name: 'Confirm', exact: true });
    await expect(confirm).toContainText('347');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId(`node-${NODE.shotA}`)).toHaveAttribute('data-status', 'outdated');
  });

  test('non-member run opens the join paywall and resumes the run after checkout (D-007)', async ({ page }) => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto('/p/prj_demo?mock=frozen&member=0');
    await page.getByTestId(`node-${NODE.voice}`).getByLabel('6 credits to run').click();
    const paywall = page.getByRole('dialog', { name: 'Pick a plan to generate' });
    await expect(paywall).toBeVisible();
    await paywall.getByRole('button', { name: /^Continue with/ }).click();
    await expect(page.getByTestId(`node-${NODE.voice}`)).toHaveAttribute('data-status', 'generating');
  });

  test('node menu: duplicate, bypass (menu and Ctrl+B), collapse, disconnect inputs, delete', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('.react-flow__node').count();
    let menu = await nodeMenu(page, NODE.keyframe);
    await menu.getByRole('menuitem', { name: /^Duplicate/ }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
    await expect(page.getByText('Product keyframe copy')).toBeVisible();

    menu = await nodeMenu(page, NODE.shotA);
    await menu.getByRole('menuitemcheckbox', { name: /^Bypass/ }).click();
    const a = page.getByTestId(`node-${NODE.shotA}`);
    await expect(a).toHaveAttribute('data-bypass', '');
    await expect(a).toContainText('Bypassed');
    await page.keyboard.press('Control+b');
    await expect(a).not.toHaveAttribute('data-bypass', '');
    await page.keyboard.press('Control+b');
    await expect(a).toHaveAttribute('data-bypass', '');
    // Bypassed nodes are skipped in quotes.
    await page.getByRole('button', { name: /^Run all/ }).click();
    await expect(page.getByTestId('plan-dialog')).toContainText('Bypassed · skipped');
    await page.keyboard.press('Escape');

    menu = await nodeMenu(page, NODE.voice);
    await menu.getByRole('menuitem', { name: 'Collapse' }).click();
    await expect(page.getByTestId(`node-${NODE.voice}`)).toHaveAttribute('data-collapsed', '');

    const edges = await page.locator('[data-testid^="edge-"]').count();
    menu = await nodeMenu(page, NODE.shotB);
    await menu.getByRole('menuitem', { name: 'Disconnect 2 inputs' }).click();
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edges - 2);

    menu = await nodeMenu(page, NODE.shotB);
    await menu.getByRole('menuitem', { name: /^Delete/ }).click();
    await expect(page.getByTestId(`node-${NODE.shotB}`)).toHaveCount(0);
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
  });

  test('Run up to here quotes the node and its stale upstream; Run from here adds everything downstream', async ({ page }) => {
    await openApp(page);
    // Make the keyframe stale: its prompt input changes.
    let menu = await nodeMenu(page, NODE.shotA);
    await menu.getByRole('menuitem', { name: 'Run from here' }).click();
    let dialog = page.getByTestId('plan-dialog');
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await expect(dialog).toContainText('Shot A: Hero shot');
    await page.keyboard.press('Escape');
    menu = await nodeMenu(page, NODE.keyframe);
    await menu.getByRole('menuitem', { name: 'Run from here' }).click();
    dialog = page.getByTestId('plan-dialog');
    await expect(dialog).toContainText('Product keyframe');
    await expect(dialog).toContainText('Shot A: Hero shot');
    await expect(dialog).toContainText('Shot B: Cap pop');
    await page.keyboard.press('Escape');
    menu = await nodeMenu(page, NODE.shotB);
    await menu.getByRole('menuitem', { name: 'Run up to here' }).click();
    dialog = page.getByTestId('plan-dialog');
    await expect(dialog).toContainText('Voiceover');
    await expect(dialog).toContainText('Shot B: Cap pop');
    await expect(dialog).not.toContainText('Product keyframe');
  });

  test('version chip switches the active version; Play opens the result viewer', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Version 2 of 2. Switch version' }).click();
    await page.getByTestId('menu-versions').getByRole('menuitemradio', { name: /^Version 1/ }).click();
    await expect(page.getByTestId(`node-${NODE.keyframe}`)).toContainText('Current · 1/2');
    await expect(page.getByText('Product keyframe now uses version 1')).toBeVisible();
    await page.getByTestId(`node-${NODE.shotA}`).getByRole('button', { name: 'Play' }).click();
    const viewer = page.getByRole('dialog').filter({ hasText: 'Shot A: Hero shot' });
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });

  test('prompt panel: edit the prompt, quick modifier, mode, model, settings, remove a reference', async ({ page }) => {
    await openApp(page);
    const panel = page.getByTestId('prompt-panel');
    await panel.getByTestId('prompt-text').click();
    const box = panel.getByRole('textbox', { name: 'Prompt' });
    await box.fill('Slow push-in on the bottle at dawn');
    await box.press('Control+Enter');
    await expect(panel.getByTestId('prompt-text')).toHaveText('Slow push-in on the bottle at dawn');
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    expect(await page.evaluate((id) => window.__canvasRoom!.state.nodes.find((n) => n.id === id)!.params.prompt, NODE.shotA)).toBe('Slow push-in on the bottle at dawn');

    await panel.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Cinematic' }).click();
    await expect(panel.getByRole('button', { name: 'Style: Cinematic' })).toBeVisible();

    await panel.getByRole('button', { name: /First frame/ }).click();
    await page.getByRole('menuitemradio', { name: 'Text to video' }).click();
    await expect(panel.getByRole('button', { name: /Text to video/ })).toBeVisible();

    await panel.getByRole('button', { name: /Seedance 2.5/ }).click();
    await page.getByRole('dialog', { name: 'Choose model' }).getByText('MiniMax H3').click();
    await expect(panel.getByRole('button', { name: /MiniMax H3/ })).toBeVisible();

    await panel.getByRole('button', { name: /×1 · Audio on/ }).click();
    await expect(page.locator('[role="dialog"]').filter({ hasText: 'Aspect ratio' })).toBeVisible();
    await page.keyboard.press('Escape');

    await panel.getByRole('button', { name: /^Remove reference @1/ }).click();
    await expect(panel.getByRole('button', { name: /^Remove reference/ })).toHaveCount(1);
  });

  test('agent panel: Shuffle, LLM pill from the public list, Auto model, + menu, and a graph-patch proposal applies', async ({ page }) => {
    await page.route('**/api/models?kind=chat', (r) =>
      r.fulfill({
        json: {
          models: [
            { id: 'deepseek-v4.1-flash', kind: 'chat', name: 'DeepSeek V4.1 Flash', default: true, tags: [], credits: [] },
            { id: 'claude-sonnet-5.5', kind: 'chat', name: 'Claude Sonnet 5.5', default: false, tags: [], credits: [] },
          ],
        },
      }),
    );
    await openApp(page);
    const agent = page.locator('aside[aria-label="Agent"]');
    await agent.getByRole('button', { name: /^Shuffle/ }).click();
    await expect(agent.getByTestId('plan-card')).toContainText('Option B · Kitchen counter');

    await agent.getByRole('button', { name: /^Agent model/ }).click();
    await page.getByRole('menuitemradio', { name: 'Claude Sonnet 5.5' }).click();
    await expect(agent.getByRole('button', { name: 'Agent model: Claude Sonnet 5.5' })).toBeVisible();
    await page.reload();
    await expect(page.locator('aside[aria-label="Agent"]').getByRole('button', { name: 'Agent model: Claude Sonnet 5.5' })).toBeVisible();

    await page.locator('aside[aria-label="Agent"]').getByRole('button', { name: /^Model for new shots/ }).click();
    await page.getByRole('dialog', { name: 'Choose model' }).getByText('Wan 3.0').click();
    await expect(page.locator('aside[aria-label="Agent"]').getByRole('button', { name: 'Model for new shots: Wan 3.0' })).toBeVisible();

    await page.locator('aside[aria-label="Agent"]').getByRole('button', { name: 'Add assets or skills' }).click();
    await page.getByRole('menuitemradio', { name: '/Product showcase' }).click();
    await expect(page.locator('aside[aria-label="Agent"]').getByRole('button', { name: 'Remove skill /Product showcase' })).toBeVisible();

    const ask = page.getByLabel('Tell the agent');
    await ask.fill('Make shot 1 warmer');
    await ask.press('Enter');
    const proposal = page.getByTestId('graph-proposal');
    await expect(proposal).toContainText('Update Shot A: Hero shot');
    await expect(page.getByTestId(`node-${NODE.shotA}`)).toHaveAttribute('data-proposed', '');
    await proposal.getByRole('button', { name: 'Apply' }).click();
    await expect(proposal).toHaveAttribute('data-outcome', 'applied');
    await expect(page.getByTestId(`node-${NODE.shotA}`)).not.toHaveAttribute('data-proposed', '');
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    const params = await page.evaluate((id) => window.__canvasRoom!.state.nodes.find((n) => n.id === id)!.params, NODE.shotA);
    expect(params.prompt).toContain('warmer color temperature');
    expect((params.modifiers as Record<string, string>).Lighting).toBe('Golden hour');

    await ask.fill('Make shot 2 slower');
    await ask.press('Enter');
    const second = page.getByTestId('graph-proposal').last();
    await second.getByRole('button', { name: 'Discard' }).click();
    await expect(second).toHaveAttribute('data-outcome', 'discarded');
  });

  test('tool rail: assets panel adds asset nodes, templates insert a connected group, director explains, history selects', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('.react-flow__node').count();
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    // The shared asset picker modal (never a side panel); My assets first.
    const assets = pickerDialog(page, 'Add assets to the canvas');
    await expect(assets).toBeVisible();
    await expect(assets.getByRole('tab', { name: 'My assets' })).toHaveAttribute('aria-selected', 'true');
    await assets.getByRole('option').first().click();
    await assets.getByRole('button', { name: 'Add to canvas' }).click();
    await expect(assets).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);

    await page.getByRole('button', { name: 'Workflows and templates' }).click();
    await page.getByRole('menuitem', { name: /Product hero shot/ }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 3);
    await expect(page.getByText('Product hero shot added (2 nodes)')).toBeVisible();

    // aria-disabled with a reason: it still responds (toast), so force past Playwright's enabled check.
    await page.getByRole('button', { name: 'Director' }).click({ force: true });
    await expect(page.getByText(/Director is coming soon/).last()).toBeVisible();

    await page.getByRole('button', { name: 'Run history' }).click();
    await page.getByRole('region', { name: 'Run history' }).getByRole('menuitem', { name: 'Show Product keyframe on the canvas' }).click();
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', NODE.keyframe);
  });

  test('zoom percentage opens presets; the minimap pans by click, drag and arrow keys', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('zoom-value').click();
    await page.getByRole('menuitemradio', { name: '50%', exact: true }).click();
    await expect(page.getByTestId('zoom-value')).toHaveText('50%');
    const transform = () => page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);
    const t0 = await transform();
    const mm = (await page.getByTestId('minimap').boundingBox())!;
    await page.mouse.move(mm.x + 20, mm.y + 20);
    await page.mouse.down();
    await page.mouse.move(mm.x + 120, mm.y + 70, { steps: 5 });
    await page.mouse.up();
    await expect.poll(transform).not.toBe(t0);
    const t1 = await transform();
    await page.getByTestId('minimap').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(transform).not.toBe(t1);
  });

  test('dropping a wire on empty canvas opens a filtered node search; picking connects the new node in one patch', async ({ page }) => {
    await openApp(page);
    const rev = await page.evaluate(() => window.__canvasRoom!.state.revision);
    const edges = await page.locator('[data-testid^="edge-"]').count();
    const from = await portCenter(page, NODE.voice, 'out');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 40, { steps: 6 });
    // Incompatible inputs dim while dragging audio: the image node's input does not take audio.
    await expect(page.getByTestId(`node-${NODE.keyframe}`).locator('[data-port="in"]')).toHaveCSS('opacity', '0.25');
    await page.mouse.move(from.x + 200, from.y + 60, { steps: 6 });
    await page.mouse.up();
    const menu = page.getByRole('menu', { name: 'Add node' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([/Video/]);
    await menu.getByRole('menuitem', { name: /Video/ }).click();
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edges + 1);
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    expect(await page.evaluate(() => window.__canvasRoom!.state.revision)).toBe(rev + 1);
  });

  test('double-click on empty canvas opens node search; arrows and Enter add a node', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('.react-flow__node').count();
    await page.mouse.dblclick(620, 760);
    const menu = page.getByRole('menu', { name: 'Add node' });
    await expect(menu).toBeVisible();
    await page.getByPlaceholder(/Search/).fill('ima');
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  });

  test('reroute: double-click a wire adds a point; double-click the point removes it', async ({ page }) => {
    await openApp(page);
    const edge = page.locator('[data-testid^="edge-"]').first();
    const id = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
    const hit = (await edge.locator('path').first().boundingBox())!;
    await page.mouse.dblclick(hit.x + hit.width / 2, hit.y + hit.height / 2);
    const point = page.getByTestId(`reroute-${id}-0`);
    await expect(point).toBeAttached();
    expect(await page.evaluate((e) => window.__canvasRoom!.state.edges.find((x) => x.id === e)?.reroutes?.length ?? 0, id)).toBe(0); // pending until ack
    await expect(page.getByTestId('sync-status')).toHaveText('Saved');
    expect(await page.evaluate((e) => window.__canvasRoom!.state.edges.find((x) => x.id === e)?.reroutes?.length ?? 0, id)).toBe(1);
    await point.dispatchEvent('dblclick');
    await expect(point).toHaveCount(0);
  });

  test('script full screen: edit a cell, add and remove shots, hide a field, filter, generate storyboard', async ({ page }) => {
    await openApp(page, 'script');
    const dialog = page.getByRole('dialog', { name: 'Script' });
    const visual = dialog.getByRole('textbox', { name: 'Visual, shot 03' });
    await visual.click();
    await page.keyboard.press('End');
    await page.keyboard.type(', slow tilt up');
    await page.keyboard.press('Enter');
    await expect(visual).toHaveText('Bottle centered, tagline comes in, slow tilt up');
    await dialog.getByRole('button', { name: 'Add shot' }).click();
    await expect(dialog.locator('[data-row="05"]')).toBeVisible();
    await page.keyboard.type('Logo end card');
    await page.keyboard.press('Enter');
    await dialog.locator('[data-row="05"]').hover();
    await dialog.getByRole('button', { name: 'Remove shot 05' }).click();
    await expect(dialog.locator('[data-row="05"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Field visibility' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Lines' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('columnheader', { name: 'Lines' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Filter' }).click();
    await page.getByRole('menuitemradio', { name: 'Selected' }).click();
    await expect(dialog.locator('[data-row]')).toHaveCount(3);
    const before = await page.locator('.react-flow__node').count();
    await dialog.getByRole('button', { name: /^Generate storyboard · Selected 3/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 6);
    await expect(page.getByText('6 nodes added for the storyboard. Nothing was charged.')).toBeVisible();
  });

  test('run all over built nodes: keyframes generate first, the videos they feed wait as queued', async ({ page }) => {
    await openApp(page, '', 'fast');
    await page.getByRole('button', { name: 'Build on canvas' }).click();
    await page.getByRole('button', { name: /^Run all/ }).click();
    await page.getByTestId('plan-dialog').getByRole('button', { name: /^Run · / }).click();
    await expect(page.locator('.react-flow__node [data-status="queued"]').first()).toBeVisible();
    await expect(page.locator('.react-flow__node [data-node-kind="image"][data-status="generating"]').first()).toBeVisible();
  });

  test('editor “Open on canvas” closes the editor and selects the shot', async ({ page }) => {
    await openApp(page, 'edit');
    await page.getByRole('button', { name: 'Open on canvas' }).click();
    await expect(page.getByTestId('editor')).toHaveCount(0);
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', NODE.shotA);
  });
});
