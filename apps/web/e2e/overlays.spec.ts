import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { pixelDiffRatio, type Box } from './support/measure';

/**
 * Fidelity specs for the shared overlays (features/overlays). Each design
 * artboard renders its panel at the top-left; /preview/overlays renders ours
 * the same way with the design's mock data. Both pages get the app background
 * so rounded corners compare equal.
 */
const OUT = fileURLToPath(new URL('./__screens__/overlays/', import.meta.url));
const MAX_DIFF = 0.01;

async function openDesign(page: Page, screen: string, props: Record<string, unknown> = {}, replace: Case['replace'] = []) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(buildDesignPage(screen, props, replace));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.addStyleTag({ content: 'html,body{background:#0B0B0C!important}' });
  await page.evaluate(() => document.fonts.ready);
}

async function openPreview(page: Page, query: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/preview/overlays?${query}`);
  await page.getByTestId('overlay-preview').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1439, 899);
  await page.waitForTimeout(600); // enter + stagger animations settle
}

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

function expectClose(a: Box, d: Box, what: string, tol = 2) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - d[k]), `${what}.${k}: app ${a[k].toFixed(1)} vs design ${d[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

interface Case {
  name: string;
  screen: string;
  props?: Record<string, unknown>;
  query: string;
  /** Locators for the panel in the design and in the app. */
  design: (p: Page) => Locator;
  app: (p: Page) => Locator;
  /** Known copy deviations (see report) can raise the bar for one case. */
  maxDiff?: number;
  /** Copy decided after the design was drawn, swapped into the design source before rendering. */
  replace?: ReadonlyArray<readonly [string, string]>;
}

/**
 * D-006 replaced the drawn plans (Starter / Pro / Studio, placeholder prices)
 * with Starter / Plus / Pro from packages/core/pricing/config.ts. The layout is
 * unchanged, so the design is compared with the decided copy swapped in.
 */
const D006_JOIN: Case['replace'] = [
  [
    "[['Starter', '1,000 credits a month', '$[PRICE]/mo'], ['Pro', '3,000 credits a month, images up to 4K', '$[PRICE]/mo'], ['Studio', '10,000 credits a month, 5 seats', '$[PRICE]/mo']]",
    "[['Starter', '200 credits a month, video up to 720p', '$5/mo'], ['Plus', '800 credits a month, video up to 1080p', '$15/mo'], ['Pro', '2,500 credits a month, video up to 4K', '$49/mo']]",
  ],
  ["(credits ? '1,000 credits' : 'Pro')", "(credits ? '1,000 credits' : 'Plus')"],
];
/** D-006: the confirm threshold default is 300 credits (the PRD's 20, rescaled). */
const D006_THRESHOLD: Case['replace'] = [['Skip this step for runs under 20 credits', 'Skip this step for runs under 300 credits']];

const firstDialog = (p: Page) => p.locator('[role="dialog"]').first();

const CASES: Case[] = [
  { name: 'model-picker-video', screen: 'ModelPicker.dc.html', props: { kind: 'video' }, query: 'c=modelPicker&kind=video', design: firstDialog, app: firstDialog },
  { name: 'model-picker-image', screen: 'ModelPicker.dc.html', props: { kind: 'image' }, query: 'c=modelPicker&kind=image', design: firstDialog, app: firstDialog },
  { name: 'model-picker-avatar', screen: 'ModelPicker.dc.html', props: { kind: 'avatar' }, query: 'c=modelPicker&kind=avatar', design: firstDialog, app: firstDialog },
  { name: 'params-video', screen: 'ParamPopover.dc.html', props: { kind: 'video' }, query: 'c=params&kind=video', design: firstDialog, app: firstDialog },
  { name: 'params-image', screen: 'ParamPopover.dc.html', props: { kind: 'image' }, query: 'c=params&kind=image', design: firstDialog, app: firstDialog },
  {
    name: 'run-confirm-single',
    screen: 'RunConfirm.dc.html',
    props: { variant: 'single', cost: 10, label: 'Generate video' },
    query: 'c=runConfirm&variant=single',
    replace: D006_THRESHOLD,
    design: firstDialog,
    app: (p) => p.getByTestId('overlay-slot').locator('> div'),
    // The design's button reads "ConfirmGenerate video · 10 credits" (string
    // concatenation bug in RunConfirm.dc.html); we render "Generate video · 10 credits".
    maxDiff: 0.02,
  },
  { name: 'run-confirm-graph', screen: 'RunConfirm.dc.html', props: { variant: 'graph' }, query: 'c=runConfirm&variant=graph', replace: D006_THRESHOLD, design: firstDialog, app: (p) => p.getByTestId('overlay-slot').locator('> div') },
  { name: 'paywall-join', screen: 'Paywall.dc.html', props: { variant: 'join' }, query: 'c=paywall&variant=join', replace: D006_JOIN, design: firstDialog, app: (p) => p.getByTestId('overlay-slot').locator('> div') },
];

test.describe('shared overlays match their design files', () => {
  for (const c of CASES) {
    test(`${c.name}: panel box within 2px and pixel diff under ${((c.maxDiff ?? MAX_DIFF) * 100).toFixed(0)}%`, async ({ page }) => {
      await openDesign(page, c.screen, c.props, c.replace);
      const dBox = await box(c.design(page));
      const clip = { x: Math.round(dBox.x), y: Math.round(dBox.y), width: Math.round(dBox.width), height: Math.round(dBox.height) };
      const design = await page.screenshot({ clip });
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ clip, path: `${OUT}${c.name}-design.png` });

      await openPreview(page, c.query);
      const aBox = await box(c.app(page));
      const app = await page.screenshot({ clip });
      await page.screenshot({ clip, path: `${OUT}${c.name}.png` });
      expectClose(aBox, dBox, c.name);

      const ratio = await pixelDiffRatio(page, app, design);
      test.info().annotations.push({ type: 'pixel-diff', description: `${c.name}: ${(ratio * 100).toFixed(3)}%` });
      console.log(`pixel-diff ${c.name}: ${(ratio * 100).toFixed(3)}%`);
      expect(ratio, `pixel diff ${(ratio * 100).toFixed(3)}%`).toBeLessThan(c.maxDiff ?? MAX_DIFF);
    });
  }

  test('result viewer: dialog box within 2px and pixel diff under 1% at 1440x900', async ({ page }) => {
    await openDesign(page, 'ResultViewer.dc.html', { ar: '9/16' });
    const dBox = await box(firstDialog(page));
    const clip = { x: 0, y: 0, width: 1440, height: 900 };
    const design = await page.screenshot({ clip });
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ clip, path: `${OUT}result-viewer-design.png` });

    await openPreview(page, 'c=viewer&kind=9/16');
    const dialog = page.getByRole('dialog', { name: 'Result' });
    expectClose(await box(dialog), dBox, 'viewer');
    await expect(dialog.getByText('v3 · Current')).toBeVisible();
    await expect(dialog.getByText('10 min ago · Alex')).toBeVisible();
    const app = await page.screenshot({ clip });
    await page.screenshot({ clip, path: `${OUT}result-viewer.png` });
    const ratio = await pixelDiffRatio(page, app, design);
    console.log(`pixel-diff result-viewer: ${(ratio * 100).toFixed(3)}%`);
    expect(ratio).toBeLessThan(MAX_DIFF);
  });
});

test.describe('overlay behavior and states', () => {
  test('model picker: picking a model moves the check, disabled model has a reason, search filters, Escape closes', async ({ page }) => {
    await openPreview(page, 'c=modelPicker&kind=avatar');
    const dialog = page.getByRole('dialog', { name: 'Choose model' });
    await expect(dialog.getByRole('button', { name: /Auto model/ })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: /MiniMax H3/ }).click();
    await expect(dialog.getByRole('button', { name: /MiniMax H3/ })).toHaveAttribute('aria-pressed', 'true');
    const live = dialog.getByRole('button', { name: /Live avatar/ });
    await expect(live).toBeDisabled();
    await expect(live).toHaveAttribute('title', 'Coming soon');
    await dialog.getByRole('textbox', { name: 'Search models' }).fill('cloned');
    await expect(dialog.getByRole('button', { name: /Wan 2.2 S2V/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /MiniMax H3/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toHaveCount(0);
  });

  test('param popover: unsupported option disabled with reason, cost updates, reset restores defaults', async ({ page }) => {
    await openPreview(page, 'c=params&kind=video');
    const dialog = page.getByRole('dialog', { name: 'Video settings' });
    await expect(dialog.getByText('credits · about 2 min')).toBeVisible();
    await expect(dialog.locator('b')).toHaveText('10');
    const thirty = dialog.getByRole('radio', { name: '30s' });
    await expect(thirty).toBeDisabled();
    await expect(thirty).toHaveAttribute('title', 'Not supported on this model');
    await dialog.getByRole('radio', { name: '1080p' }).click();
    await expect(dialog.locator('b')).toHaveText('18');
    await dialog.getByRole('switch', { name: 'Generate audio' }).click();
    await expect(dialog.locator('b')).toHaveText('14');
    await dialog.getByRole('button', { name: 'Reset' }).click();
    await expect(dialog.locator('b')).toHaveText('10');
    await dialog.getByRole('radio', { name: '16:9' }).click();
    await expect(dialog.getByRole('radio', { name: '16:9' })).toHaveAttribute('aria-checked', 'true');
  });

  test('param popover (image): 4K is disabled until High quality', async ({ page }) => {
    await openPreview(page, 'c=params&kind=image');
    const dialog = page.getByRole('dialog', { name: 'Image settings' });
    await expect(dialog.getByRole('radio', { name: '4K' })).toBeDisabled();
    await dialog.getByRole('radio', { name: 'High quality' }).click();
    await expect(dialog.getByRole('radio', { name: '4K' })).toBeEnabled();
  });

  test('param popover: plan caps lock resolutions with the unlocking plan (video on Starter, image on Plus)', async ({ page }) => {
    await openPreview(page, 'c=params&kind=video&plan=starter');
    const video = page.getByRole('dialog', { name: 'Video settings' });
    await expect(video.getByRole('radio', { name: '1080p, Available on Plus' })).toBeDisabled();
    await expect(video.getByRole('radio', { name: '720p' })).toBeEnabled();
    await openPreview(page, 'c=params&kind=image&plan=plus');
    const image = page.getByRole('dialog', { name: 'Image settings' });
    await image.getByRole('radio', { name: 'High quality' }).click();
    await expect(image.getByRole('radio', { name: '4K, Available on Pro' })).toBeDisabled();
    await expect(image.locator('[data-plan-lock]')).toHaveText(['Pro']);
  });

  test('run confirm (graph): stat line, row states, blocked note, totals and run button', async ({ page }) => {
    await openPreview(page, 'c=runConfirm&variant=graph');
    await expect(page.getByText('3 to generate · 1 reused · 1 blocked · ~4 min')).toBeVisible();
    await expect(page.getByText('Reuse result')).toBeVisible();
    await expect(page.getByText('Nothing to generate')).toHaveCount(2);
    await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('“Shot C” is missing an input');
    await expect(page.getByText('2,480 → 2,462')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run · 18 credits' })).toBeVisible();
    const skip = page.getByRole('checkbox', { name: 'Skip this step for runs under 300 credits' });
    await skip.check();
    await expect(skip).toBeChecked();
  });

  test('run confirm (dialog): modal with scrim, Escape closes with the exit animation', async ({ page }) => {
    await openPreview(page, 'c=runConfirm&variant=single&as=dialog');
    const dialog = page.getByRole('dialog', { name: 'Confirm' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', { name: 'Generate video · 10 credits' })).toBeVisible();
    await expect(page.getByText('~2 min · No charge if it fails')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-state="closed"]').first()).toBeAttached();
    await expect(page.getByRole('dialog', { name: 'Confirm' })).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('paywall (join): Starter / Plus / Pro from the pricing config, CTA follows the selection', async ({ page }) => {
    await openPreview(page, 'c=paywall&variant=join');
    await expect(page.getByRole('radio')).toHaveText([/Starter.*\$5\/mo/, /Plus.*\$15\/mo/, /Pro.*\$49\/mo/]);
    await expect(page.getByRole('radio', { name: /Plus/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Continue with Plus' })).toBeVisible();
    await page.getByRole('radio', { name: /^Pro/ }).click();
    await expect(page.getByRole('button', { name: 'Continue with Pro' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('button', { name: 'Continue with Plus' })).toBeVisible();
    await expect(page.getByText('Studio')).toHaveCount(0);
  });

  /**
   * PaywallCredits.dc.html predates D-006 (fixed packs and a Studio upgrade);
   * the credits variant sells any amount, so it is checked by behavior and a
   * saved screenshot instead of a pixel diff.
   */
  test('paywall (credits): shortfall, top-up presets with bonus from quoteTopUp, custom amount, CTA', async ({ page }) => {
    await openPreview(page, 'c=paywall&variant=credits');
    await expect(page.getByText('Short by')).toBeVisible();
    const amounts = page.getByRole('radiogroup', { name: 'Top-up amount' }).getByRole('radio');
    // Pro member (session default): tier bonus + 10% plan bonus.
    await expect(amounts).toHaveText([/^\$10\s*1,100$/, /^\$25\s*2,850$/, /^\$50\s*6,000$/, /^\$100\s*12,500$/, /^\$250\s*31,250$/]);
    // Short by 227 credits: the smallest preset that covers it is picked.
    await expect(amounts.first()).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Buy 1,100 credits for $10 and run' })).toBeVisible();
    await amounts.nth(1).click();
    await expect(page.getByText('You get 2,500 + 350 bonus = 2,850 credits')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy 2,850 credits for $25 and run' })).toBeVisible();
    const custom = page.getByLabel('Other amount');
    await custom.fill('5');
    await expect(page.getByRole('alert')).toHaveText('The minimum top-up is $10.');
    await expect(page.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
    await custom.fill('40.50');
    await expect(amounts.nth(1)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Buy 4,617 credits for $40.50 and run' })).toBeVisible();
    await expect(page.getByText('Charged to Visa ending 4242')).toBeVisible();
    await expect(page.getByText(/Studio|\[PRICE\]/)).toHaveCount(0);
    await page.mouse.move(1439, 899);
    await page.screenshot({ path: `${OUT}paywall-credits.png`, clip: (await page.getByTestId('overlay-slot').locator('> div').boundingBox())! });
  });

  test('result viewer: versions switch, play toggles, close animates out', async ({ page }) => {
    await openPreview(page, 'c=viewer');
    const dialog = page.getByRole('dialog', { name: 'Result' });
    await dialog.getByRole('button', { name: 'v1', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'v1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Play' }).click();
    await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Regenerate/ })).toContainText('10');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'Result' })).toHaveCount(0);
  });
});

test.describe('overlay motion', () => {
  test('popover enters with the standard curve in 200ms and exits with the exit curve in 140ms', async ({ page }) => {
    await openPreview(page, 'c=modelPicker&kind=video');
    const panel = page.getByRole('dialog', { name: 'Choose model' });
    const enter = await panel.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction };
    });
    expect(enter).toEqual({ name: 'rl-pop-in', dur: '0.2s', ease: 'cubic-bezier(0.2, 0, 0, 1)' });
    // Rows stagger 30ms apart, capped at the sixth.
    const delays = await panel.locator('.rl-stagger').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay));
    expect(delays.slice(0, 3)).toEqual(['0s', '0.03s', '0.06s']);
    await page.getByTestId('preview-toggle').click();
    const exit = await page.locator('[data-state="closed"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction };
    });
    expect(exit).toEqual({ name: 'rl-pop-out', dur: '0.14s', ease: 'cubic-bezier(0.4, 0, 1, 1)' });
    await expect(page.locator('[data-state]')).toHaveCount(0);
  });

  test('modal panel enters in 320ms (rise + scale from .96) behind a fading scrim', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/preview/overlays?c=runConfirm&variant=graph&as=dialog');
    const dialog = page.getByRole('dialog', { name: 'Run all' });
    const anim = await dialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration };
    });
    expect(anim).toEqual({ name: 'rl-modal-in', dur: '0.32s' });
    // Mid-animation the panel is still moving: sample a transform early.
    const early = await dialog.evaluate((el) => getComputedStyle(el).transform);
    expect(early).not.toBe('none');
  });

  test.describe('reduced motion', () => {
    test('overlays only fade: no transform during enter, stagger collapses', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/preview/overlays?c=modelPicker&kind=video');
      const panel = page.getByRole('dialog', { name: 'Choose model' });
      const samples: string[] = [];
      for (let i = 0; i < 5; i++) {
        samples.push(await panel.evaluate((el) => `${getComputedStyle(el).transform}|${getComputedStyle(el).animationDuration}`));
        await page.waitForTimeout(30);
      }
      for (const s of samples) {
        const [transform, dur] = s.split('|');
        expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
        expect(dur).toBe('0.2s'); // still a fade, not cut
      }
      const delays = await panel.locator('.rl-stagger').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay));
      expect(new Set(delays)).toEqual(new Set(['0s']));

      await page.goto('/preview/overlays?c=runConfirm&variant=graph&as=dialog');
      const dialog = page.getByRole('dialog', { name: 'Run all' });
      const t = await dialog.evaluate((el) => getComputedStyle(el).transform);
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(t);
    });
  });
});
