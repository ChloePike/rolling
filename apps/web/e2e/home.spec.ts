import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { pixelDiffRatio, type Box } from './support/measure';
import { routeModels } from './support/models';
import { asPlan } from './support/session';
import { mockPublicLibrary, PNG_2X2, type PublicCall } from './support/publicLibrary';

/**
 * Home (Main.dc.html) and its states: `/` palette (MainSlash), `+` menu
 * (MainPlus), `@` picker (MainAt). The settings popover (MainSettings) is
 * covered by header.spec.ts.
 *
 * The design's mock state starts with the “TV ad” skill selected; the app
 * starts without a skill, so each state first picks TV ad from the `+` menu.
 */

const OUT = fileURLToPath(new URL('./__screens__/home/', import.meta.url));
const W = 1440;
const H = 900;
const TOL = 2;
/** Recorded pixel-diff ratios per state (fraction of pixels), asserted below. */
const MAX_DIFF = 0.01;

async function openDesign(page: Page, props: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: W, height: H });
  // D-007: the agent is members-only, so the cost line no longer says planning is free.
  await page.setContent(buildDesignPage('Main.dc.html', props, [['Planning is free', 'Planning uses no credits']]));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
}

async function openApp(page: Page, width = W) {
  // Model names and prices come from the catalog (useModels); serve a fixture that matches the design.
  await routeModels(page);
  await page.setViewportSize({ width, height: H });
  await page.goto('/');
  await page.locator('[data-testid="app-header"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Lets enter animations finish and parks the pointer where it hovers nothing. */
async function settle(page: Page) {
  // Clicking cards near the fold can scroll the page; the design is captured at the top.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('[role="listbox"]').forEach((el) => (el.scrollTop = 0));
  });
  await page.mouse.move(2, H - 2);
  await page.waitForTimeout(450);
}

async function pickSkill(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add assets or skills' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^/${name}`) }).click();
  await expect(page.getByRole('menu', { name: 'Add assets or skills' })).toHaveCount(0);
}

const box = async (l: Locator): Promise<Box> => {
  const b = await l.boundingBox();
  if (!b) throw new Error(`no box for ${l}`);
  return b;
};

function expectClose(a: Box, d: Box, what: string, tol = TOL) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - d[k]), `${what}.${k}: app ${a[k].toFixed(1)} vs design ${d[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

/** Selectors that resolve in both the design render and the app. */
const S = {
  title: 'h1',
  box: 'section[aria-label="Start creating"] > div:first-of-type',
  modes: '[role="tablist"][aria-label="Creation mode"]',
  textarea: 'textarea',
  plus: 'button[aria-label="Add assets or skills"]',
  send: '[aria-label="Start"]',
  palette: '[role="listbox"][aria-label="Commands"]',
  menu: '[role="menu"][aria-label="Add assets or skills"]',
  picker: '[role="dialog"][aria-label="Add a reference"]',
  recent: 'section[aria-labelledby="h-recent"]',
  insp: 'section[aria-labelledby="h-insp"]',
};

async function measure(page: Page, extra: Record<string, string> = {}) {
  const out: Record<string, Box> = {};
  for (const [k, sel] of Object.entries({ ...S, ...extra })) {
    const l = page.locator(sel).first();
    if (await l.count()) out[k] = await box(l);
  }
  out.modelPill = await box(page.locator('button:has-text("DeepSeek")').first());
  out.lastPill = await box(page.locator('button:has-text("15s")').first());
  out.cost = await box(page.getByText(/Planning (is free|uses no credits)/).first());
  return out;
}

async function compare(page: Page, name: string, app: Buffer, design: Buffer) {
  mkdirSync(OUT, { recursive: true });
  const ratio = await pixelDiffRatio(page, app, design);
  test.info().annotations.push({ type: 'pixel-diff', description: `${name}: ${(ratio * 100).toFixed(3)}%` });
  console.log(`[pixel-diff] home/${name}: ${(ratio * 100).toFixed(3)}%`);
  return ratio;
}

async function shoot(page: Page, file: string) {
  mkdirSync(OUT, { recursive: true });
  return page.screenshot({ path: `${OUT}${file}`, clip: { x: 0, y: 0, width: W, height: H } });
}

type StateDef = {
  name: string;
  design: Record<string, unknown>;
  open: (page: Page) => Promise<void>;
  extra?: Record<string, string>;
};

const STATES: StateDef[] = [
  { name: 'default', design: {}, open: async () => {} },
  {
    name: 'slash',
    design: { initText: '/' },
    open: async (page) => {
      await page.locator('textarea').click();
      await page.keyboard.type('/');
    },
  },
  {
    name: 'plus',
    design: { initPlus: true },
    open: async (page) => {
      await page.getByRole('button', { name: 'Add assets or skills' }).click();
    },
  },
  {
    name: 'at',
    design: { initAt: true },
    open: async (page) => {
      const plus = page.getByRole('button', { name: 'Add assets or skills' });
      await plus.click();
      await page.getByRole('menuitem', { name: /Add a character or asset/ }).click();
      await page.getByRole('option', { name: /Product photo/ }).click();
      await page.getByRole('button', { name: 'Add 1' }).click();
      await expect(page.locator(S.picker)).toHaveCount(0);
      await plus.click();
      await page.getByRole('menuitem', { name: /Add a character or asset/ }).click();
      await page.getByRole('option', { name: /Mia/ }).click();
      await page.getByRole('option', { name: /Sitting sideways/ }).click();
    },
  },
];

test.describe('home screen fidelity at 1440x900', () => {
  for (const s of STATES) {
    test(`${s.name}: pixel diff under 1% and main boxes within 2px of Main.dc.html`, async ({ page }) => {
      await openDesign(page, s.design);
      const design = await shoot(page, `${s.name}-design.png`);
      const dm = await measure(page, s.extra);

      await openApp(page);
      await pickSkill(page, 'TV ad');
      await s.open(page);
      await settle(page);
      const app = await shoot(page, `${s.name}.png`);
      const am = await measure(page, s.extra);

      for (const k of Object.keys(dm)) {
        expect(am[k], `app is missing ${k}`).toBeTruthy();
        expectClose(am[k]!, dm[k]!, `${s.name}/${k}`);
      }
      const ratio = await compare(page, s.name, app, design);
      expect(ratio, `pixel diff ${(ratio * 100).toFixed(3)}%`).toBeLessThan(MAX_DIFF);
    });
  }
});

test.describe('home interactions', () => {
  test('mode tabs switch placeholder, pills (model pill first) and cost', async ({ page }) => {
    await openApp(page);
    const tabs = page.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab');
    await expect(tabs).toHaveText(['Agent', 'Image', 'Video', 'Avatar']);
    await expect(page.getByTestId('prompt-cost')).toHaveText('Planning uses no credits');
    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('textarea')).toHaveAttribute('placeholder', /Describe the shot and camera move/);
    await expect(page.getByRole('button', { name: 'Model: Seedance 2.5' })).toBeVisible();
    await expect(page.getByTestId('prompt-cost')).toHaveText('8 credits');
    // Arrow keys move between modes.
    await tabs.nth(2).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(3)).toBeFocused();
  });

  test('`/` palette: opens on leading slash without a space, filters, ↑↓ Enter runs a skill, Esc clears', async ({ page }) => {
    await openApp(page);
    const ta = page.locator('textarea');
    await ta.click();
    await page.keyboard.type('/');
    const palette = page.getByRole('listbox', { name: 'Commands' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('group')).toHaveCount(3);
    await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.type('voi');
    await expect(palette.getByRole('option')).toHaveText([/\/Voice/]);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');

    await page.keyboard.press('ArrowDown');
    await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(palette.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); // second row: /AI comic
    await expect(page.getByTestId('skill-chip')).toHaveText(/\/AI comic/);
    await expect(ta).toHaveValue('');
    await expect(palette).toHaveCount(0);

    await page.keyboard.type('/zzz');
    await expect(palette.getByText('No matching commands')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ta).toHaveValue('');
    await expect(palette).toHaveCount(0);

    // A space closes it.
    await page.keyboard.type('/tv ad');
    await expect(palette).toHaveCount(0);
    await ta.fill('');

    // /Clear removes the skill.
    await page.keyboard.type('/clear');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('skill-chip')).toHaveCount(0);
  });

  test('`+` menu: arrow keys move, Esc returns focus, skills and “Add a character or asset” open the picker', async ({ page }) => {
    await openApp(page);
    const plus = page.getByRole('button', { name: 'Add assets or skills' });
    await plus.click();
    const menu = page.getByRole('menu', { name: 'Add assets or skills' });
    await expect(plus).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem')).toHaveCount(8);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(plus).toBeFocused();

    await plus.click();
    await menu.getByRole('menuitem', { name: /Add a character or asset/ }).click();
    await expect(page.getByRole('dialog', { name: 'Add a reference' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search references' })).toBeFocused();
  });

  test('agent is members-only (D-007): a non-member’s send opens the upgrade modal and keeps the brief; checkout resumes it', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page);
    const ta = page.locator('textarea');
    await ta.fill('A 15s ad for a sparkling water');
    await page.getByRole('button', { name: 'Start' }).click();
    const paywall = page.getByRole('dialog', { name: 'The agent needs a plan' });
    await expect(paywall).toBeVisible();
    await expect(paywall.getByRole('radiogroup', { name: 'Plans' }).getByRole('radio')).toHaveText([/Starter/, /Plus/, /Pro/]);
    await expect(ta).toHaveValue('A 15s ad for a sparkling water');
    await expect(page).toHaveURL(/\/$/);
    await paywall.getByRole('button', { name: /^Continue with/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
  });

  test('`@` picker: opens on @ at the end, filters by the query, multi-selects, Enter adds chips with source, Esc closes and strips the @', async ({ page }) => {
    await openApp(page);
    const ta = page.locator('textarea');
    await ta.click();
    await page.keyboard.type('Ad for @');
    const picker = page.getByRole('dialog', { name: 'Add a reference' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('tab')).toHaveText([/^All\s*21$/, /^My assets\s*4$/, /^Characters\s*4$/, /^Voices\s*3$/, /^Public library\s*10$/]);
    await page.keyboard.type('mia');
    await expect(picker.getByText('@mia')).toBeVisible();
    await expect(picker.getByText('1 result')).toBeVisible();
    await picker.getByRole('option', { name: /Mia/ }).click();
    await expect(picker.getByText('1 selected')).toBeVisible();
    await ta.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(ta).toHaveValue('Ad for ');
    const chips = page.getByTestId('ref-chips');
    await expect(chips).toContainText('@Mia');
    await expect(chips).toContainText('Mine');

    // Multi-select from the + menu; Esc closes without adding.
    await page.keyboard.type('@');
    await picker.getByRole('tab', { name: /Voices/ }).click();
    await picker.getByRole('option', { name: /Clear female/ }).click();
    await picker.getByRole('option', { name: /Steady male/ }).click();
    await expect(picker.getByRole('button', { name: 'Add 2' })).toBeEnabled();
    await picker.getByRole('button', { name: 'Add 2' }).click();
    await expect(chips).toContainText('@Clear female');
    await expect(chips).toContainText('Built-in');

    await page.keyboard.type('@');
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(ta).toHaveValue('Ad for ');

    // Remove a chip.
    await chips.getByRole('button', { name: 'Remove reference' }).first().click();
    await expect(chips).not.toContainText('@Mia');
  });

  test('`@` picker public library tab: categories and counts from GraphQL facets, items with real thumbnails, filters by category', async ({ page }) => {
    const calls: PublicCall[] = [];
    await page.route('**/api/media/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG_2X2 }));
    await mockPublicLibrary(
      page,
      (category) =>
        category === 'outfit' || category === null
          ? ['W001', 'W009'].map((id, i) => ({
              id: `pw_outfit_${id}`,
              category: 'outfit',
              sub: 'spring',
              title: i ? 'Linen shirt' : 'Beige trench',
              promptEn: null,
              tags: [],
              assetId: `ast_${id}`,
              license: 'FIRST_PARTY',
              source: 'https://posewear.pages.dev/',
              thumbUrl: `/api/media/public/outfit/pw_outfit_${id}/front.webp`,
              angles: [{ name: 'front', url: `/api/media/public/outfit/pw_outfit_${id}/front.webp`, depthUrl: null }],
            }))
          : [],
      calls,
    );
    await openApp(page);
    await page.locator('textarea').click();
    await page.keyboard.type('@');
    const picker = page.getByRole('dialog', { name: 'Add a reference' });
    await expect(picker.getByRole('tab', { name: /Public library/ })).toHaveText(/^Public library\s*4,084$/);
    await picker.getByRole('tab', { name: /Public library/ }).click();
    await expect(picker.getByText('Public library · from PoseWear')).toBeVisible();
    const cats = picker.getByRole('group', { name: 'Public library categories' }).getByRole('button');
    // Hairstyles have no items on the server (D-004), so the chip is hidden.
    await expect(cats).toHaveText(['All', 'Poses', 'Depth poses', 'Portraits', 'Expressions', 'Outfits', 'Anime outfits', 'Historical', 'Scenes', 'Lighting', 'Props', 'Furniture']);
    await cats.filter({ hasText: /^Outfits$/ }).click();
    await expect(picker.getByRole('option')).toHaveCount(2);
    expect(calls.filter((c) => c.op === 'items').at(-1)?.variables).toMatchObject({ category: 'outfit' });
    const first = picker.getByRole('option').first();
    await expect(first).toContainText('Public');
    await expect(first).toContainText('Outfits');
    await expect(first.locator('img')).toHaveAttribute('data-loaded', 'true');
    await first.click();
    await cats.filter({ hasText: /^Furniture$/ }).click();
    await expect(picker.getByText(/Nothing in this category yet/)).toBeVisible();
    // A pick from another category is still added.
    await picker.getByRole('button', { name: 'Add 1' }).click();
    await expect(page.getByTestId('ref-chips')).toContainText('@Beige trench');
    await page.keyboard.type('@');
    await picker.getByRole('tab', { name: /Public library/ }).click();
    await page.mouse.move(2, H - 2);
    await mkdirSync(OUT, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}at-public.png` });
  });

  test('control row: left cluster wraps, right cluster (cost, send) never wraps', async ({ page }) => {
    await openApp(page, 760);
    await page.getByRole('tab', { name: 'Image' }).click();
    await pickSkill(page, 'TV ad');
    const send = await box(page.getByRole('button', { name: 'Start' }));
    const cost = await box(page.getByTestId('prompt-cost'));
    expect(Math.abs(cost.y + cost.height / 2 - (send.y + send.height / 2))).toBeLessThanOrEqual(1);
    const right = page.getByTestId('prompt-cost').locator('..');
    expect(await right.evaluate((el) => getComputedStyle(el).flexWrap)).toBe('nowrap');
    expect(await right.evaluate((el) => getComputedStyle(el.previousElementSibling!).flexWrap)).toBe('wrap');
    await page.setViewportSize({ width: 560, height: H });
    const send2 = await box(page.getByRole('button', { name: 'Start' }));
    const cost2 = await box(page.getByTestId('prompt-cost'));
    expect(Math.abs(cost2.y + cost2.height / 2 - (send2.y + send2.height / 2))).toBeLessThanOrEqual(1);
    const plus = await box(page.getByRole('button', { name: 'Add assets or skills' }));
    const lastPill = await box(page.locator('button:has-text("2K")'));
    expect(lastPill.y, 'left cluster wrapped onto a second line').toBeGreaterThan(plus.y + 10);
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}wrap-560.png`, fullPage: false });
  });

  test('pills open the shared overlays below the pill: ModelPicker (catalog models) and ParamPopover; picks update pill and cost', async ({ page }) => {
    await openApp(page);
    await page.getByRole('tab', { name: 'Video' }).click();
    await expect(page.getByTestId('prompt-cost')).toHaveText('8 credits');
    const model = page.getByRole('button', { name: 'Model: Seedance 2.5' });
    await model.click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await expect(picker).toBeVisible();
    const pb = await box(picker);
    const mb = await box(model);
    expect(pb.y).toBeGreaterThan(mb.y + mb.height);
    await picker.getByText('MiniMax H3').click();
    await expect(page.getByRole('button', { name: 'Model: MiniMax H3' })).toBeVisible();
    await expect(page.getByTestId('prompt-cost')).toHaveText('6 credits');

    await page.getByRole('button', { name: /9:16 · 720p · 5s/ }).click();
    const params = page.getByRole('dialog', { name: 'Video settings' });
    await expect(params).toBeVisible();
    await params.getByRole('radio', { name: /16:9/ }).click();
    await expect(page.getByRole('button', { name: /16:9 · 720p · 5s/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(params).toHaveCount(0);

    await page.getByRole('tab', { name: 'Image' }).click();
    await expect(page.getByTestId('prompt-cost')).toHaveText('2 credits');
  });

  test('full page (below the fold: projects, Inspiration) differs from Main.dc.html in under 1% of pixels', async ({ page }) => {
    await openDesign(page);
    // Owner decision (Inspiration cards): at rest a card shows only the poster and the duration; the name and
    // Use template appear on hover. The design still draws them at rest, so its card footers are hidden here.
    await page.addStyleTag({ content: 'a[href="QuickCreate.dc.html"] > div{visibility:hidden}' });
    const design = await page.screenshot({ fullPage: true, path: `${OUT}full-page-design.png` });
    await openApp(page);
    await pickSkill(page, 'TV ad');
    await settle(page);
    mkdirSync(OUT, { recursive: true });
    const app = await page.screenshot({ fullPage: true, path: `${OUT}full-page.png` });
    const ratio = await compare(page, 'full-page', app, design);
    expect(ratio).toBeLessThan(MAX_DIFF);
  });
});

test.describe('home motion', () => {
  /** Samples a layer's opacity and transform `ms` after it mounts. */
  async function sample(page: Page, selector: string, ms: number) {
    return page.evaluate(
      ([sel, wait]) =>
        new Promise<{ opacity: number; transform: string; state: string | null }>((resolve) => {
          const read = () => {
            const el = document.querySelector(sel as string)?.parentElement;
            if (!el) return void requestAnimationFrame(read);
            setTimeout(() => {
              const cs = getComputedStyle(el);
              resolve({ opacity: Number(cs.opacity), transform: cs.transform, state: el.getAttribute('data-state') });
            }, wait as number);
          };
          read();
        }),
      [selector, ms] as const,
    );
  }

  test('popovers enter in 200ms from 6px with the standard curve and exit in 140ms with the exit curve', async ({ page }) => {
    await openApp(page);
    const plus = page.getByRole('button', { name: 'Add assets or skills' });
    const pending = sample(page, S.menu, 40);
    await plus.click();
    const early = await pending;
    expect(early.opacity).toBeLessThan(1);
    expect(early.transform).not.toBe('none');
    const anim = await page.locator(S.menu).locator('..').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction };
    });
    expect(anim).toEqual({ name: 'rl-pop-in', dur: '0.2s', ease: 'cubic-bezier(0.2, 0, 0, 1)' });
    await page.waitForTimeout(300);
    expect(await page.locator(S.menu).locator('..').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    await page.keyboard.press('Escape');
    const closing = await page.locator(S.menu).locator('..').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { state: el.getAttribute('data-state'), name: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction };
    });
    expect(closing).toEqual({ state: 'closed', name: 'rl-pop-out', dur: '0.14s', ease: 'cubic-bezier(0.4, 0, 1, 1)' });
    await expect(page.locator(S.menu)).toHaveCount(0);
  });

  test('palette rows and picker cards stagger 30ms apart, capped at the sixth', async ({ page }) => {
    await openApp(page);
    await page.locator('textarea').click();
    await page.keyboard.type('/');
    const delays = await page
      .getByRole('listbox', { name: 'Commands' })
      .getByRole('option')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationDelay));
    expect(delays.slice(0, 8)).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s', '0.15s']);
    await page.keyboard.press('Escape');
    await page.keyboard.type('@');
    const cardDelays = await page
      .getByRole('dialog', { name: 'Add a reference' })
      .getByRole('option')
      .evaluateAll((els) => els.slice(0, 7).map((el) => getComputedStyle(el).animationDelay));
    expect(cardDelays).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s']);
  });

  test('mode tab indicator slides with the standard curve', async ({ page }) => {
    await openApp(page);
    await page.waitForTimeout(100);
    const ind = page.locator(`${S.modes} > span`).first();
    const before = await box(ind);
    await page.getByRole('tab', { name: 'Video' }).click();
    const t = await ind.evaluate((el) => getComputedStyle(el).transition);
    expect(t).toContain('transform');
    await page.waitForTimeout(400);
    const after = await box(ind);
    const tab = await box(page.getByRole('tab', { name: 'Video' }));
    expect(after.x).not.toBe(before.x);
    expectClose(after, tab, 'indicator', 1);
  });

  test('reduced motion: layers only fade (no transform), list stagger collapses', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    const pending = sample(page, S.menu, 20);
    await page.getByRole('button', { name: 'Add assets or skills' }).click();
    const s = await pending;
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(s.transform);
    const delays = await page
      .locator(S.menu)
      .getByRole('menuitem')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationDelay));
    expect(new Set(delays)).toEqual(new Set(['0s']));
    await page.keyboard.press('Escape');
    await page.locator('textarea').click();
    await page.keyboard.type('@');
    const card = page.getByRole('dialog', { name: 'Add a reference' }).getByRole('option').first();
    await card.click();
    const check = card.locator('span > span').last();
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(await check.evaluate((el) => getComputedStyle(el).transform));
  });
});

/** Interaction pass (docs/interaction-pass.md): Home controls run their flows end to end. */
test.describe('home flows', () => {
  /** Fast mock checkout and runs; optional starting prefs and credits. */
  async function seed(page: Page, opts: { prefs?: Record<string, unknown>; mocks?: Record<string, unknown> } = {}) {
    await page.addInitScript((o) => {
      const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
      w.__rollingMocks = { ...w.__rollingMocks, latencyMs: 80, ...o.mocks };
      if (o.prefs && !sessionStorage.getItem('seeded')) {
        localStorage.setItem('rolling.prefs', JSON.stringify(o.prefs));
        sessionStorage.setItem('seeded', '1');
      }
    }, opts);
  }
  const mode = (page: Page, name: string) => page.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab', { name }).click();
  const balance = (page: Page) => page.getByRole('button', { name: /Credit balance/ });

  test('empty send asks for a brief instead of doing nothing', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('status')).toContainText('Describe what you want first');
    await expect(page.locator('textarea')).toBeFocused();
  });

  test('member agent send creates a project and opens its canvas; it shows in My projects', async ({ page }) => {
    await openApp(page);
    await page.locator('textarea').fill('Launch video for a desk lamp');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
    await page.goto('/');
    await expect(page.locator('#projects').getByRole('link', { name: /Launch video for a desk lamp/ })).toBeVisible();
  });

  test('Enter sends the brief; Shift+Enter adds a line; Enter while an IME is composing does not send', async ({ page }) => {
    await openApp(page);
    const brief = page.locator('textarea');
    await brief.fill('Launch video');
    await brief.press('Shift+Enter');
    await brief.pressSequentially('for a desk lamp');
    await expect(brief).toHaveValue('Launch video\nfor a desk lamp');
    // An IME confirming a candidate fires Enter with isComposing: it must not send.
    await brief.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })));
    await expect(page).toHaveURL(/\/$/);
    await brief.press('Enter');
    await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
  });

  test('image send under the confirm threshold runs at once; View opens the result viewer', async ({ page }) => {
    await seed(page);
    await openApp(page);
    await mode(page, 'Image');
    await page.locator('textarea').fill('A glass bottle on wet stone');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm' })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Generate images is ready');
    await expect(balance(page)).toContainText('2,478');
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    const viewer = page.getByRole('dialog', { name: 'Result' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'v1' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('video send at or over the threshold opens RunConfirm; confirm runs, closes and charges the quote', async ({ page }) => {
    await seed(page, { prefs: { confirmThreshold: 0 } });
    await openApp(page);
    await mode(page, 'Video');
    await page.locator('textarea').fill('Slow push-in on a sneaker');
    await page.getByRole('button', { name: 'Start' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Seedance 2.5 · 9:16 · 720p · 5s');
    const skip = confirm.getByRole('checkbox', { name: /Skip this step for runs under 300 credits/ });
    await expect(skip).not.toBeChecked();
    await skip.check();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rolling.prefs') ?? '{}').confirmThreshold)).toBe(300);
    await confirm.getByRole('button', { name: 'Generate video · 8 credits' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Generate video is ready');
    await expect(balance(page)).toContainText('2,472');
  });

  test('non-member generate: join paywall → checkout → the same run continues', async ({ page }) => {
    await asPlan(page, null);
    await seed(page);
    await openApp(page);
    await mode(page, 'Video');
    await page.locator('textarea').fill('Product turntable');
    await page.getByRole('button', { name: 'Start' }).click();
    const paywall = page.getByRole('dialog', { name: 'Pick a plan to generate' });
    await paywall.getByRole('radio', { name: /^Plus/ }).click();
    await paywall.getByRole('button', { name: 'Continue with Plus' }).click();
    await expect(paywall).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Generate video is ready');
    // 2,480 + 800 (Plus) − 8.
    await expect(balance(page)).toContainText('3,272');
  });

  test('non-member image send: join paywall → checkout redirect (Stripe-style reload) → the same run resumes', async ({ page }) => {
    await asPlan(page, null);
    await seed(page, { mocks: { checkoutRedirect: true } });
    await openApp(page);
    await mode(page, 'Image');
    await page.locator('textarea').fill('A glass bottle on wet stone');
    await page.getByRole('button', { name: 'Start' }).click();
    const paywall = page.getByRole('dialog', { name: 'Pick a plan to generate' });
    const left = page.waitForURL(/checkout=success&session_id=cs_mock_/);
    await paywall.getByRole('radio', { name: /^Plus/ }).click();
    await paywall.getByRole('button', { name: 'Continue with Plus' }).click();
    await left;
    // Back from checkout: the return params are stripped, the brief and mode are restored and the run continues.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab', { name: 'Image' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('textarea')).toHaveValue('A glass bottle on wet stone');
    await expect(page.getByRole('status').filter({ hasText: 'Generate images is ready' })).toBeVisible();
    // 2,480 + 800 (Plus) − 2.
    await expect(balance(page)).toContainText('3,278');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('rolling.pendingAction')))).toEqual([]);
  });

  test('result viewer Regenerate short of credits: top-up redirect → the viewer reopens and the new version runs', async ({ page }) => {
    await seed(page, { mocks: { checkoutRedirect: true, credits: { available: 10, plan: 10, purchased: 0 } } });
    await openApp(page);
    await mode(page, 'Video');
    await page.locator('textarea').fill('Product turntable');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    const viewer = page.getByRole('dialog', { name: 'Result' });
    await viewer.getByRole('button', { name: /^Regenerate/ }).click();
    const paywall = page.getByRole('dialog', { name: 'Not enough credits' });
    const left = page.waitForURL(/checkout=success&session_id=cs_mock_/);
    await paywall.getByRole('button', { name: /^Buy 1,100 credits for \$10 and run$/ }).click();
    await left;
    await expect(page).toHaveURL(/\/$/);
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'v2' })).toHaveAttribute('aria-pressed', 'true');
    // 10 (seeded again after the reload) + 1,100 − 8.
    await expect(balance(page)).toContainText('1,102');
  });

  test('not enough credits: top-up paywall → checkout → the run continues', async ({ page }) => {
    await seed(page, { mocks: { credits: { available: 5, plan: 5, purchased: 0 } } });
    await openApp(page);
    await mode(page, 'Video');
    await page.locator('textarea').fill('Product turntable');
    await page.getByRole('button', { name: 'Start' }).click();
    const paywall = page.getByRole('dialog', { name: 'Not enough credits' });
    await expect(paywall).toBeVisible();
    await paywall.getByRole('button', { name: /^Buy 1,100 credits for \$10 and run$/ }).click();
    await expect(paywall).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Generate video is ready');
    await expect(balance(page)).toContainText('1,097');
  });

  test('a failed run is refunded and offers Retry', async ({ page }) => {
    await seed(page, { mocks: { run: 'fail' } });
    await openApp(page);
    await mode(page, 'Image');
    await page.locator('textarea').fill('Bottle');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('status')).toContainText('Generate images failed. Refunded 2 credits.');
    await expect(page.getByRole('status').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(balance(page)).toContainText('2,480');
  });

  test('result viewer: favorite, regenerate adds a version, download saves a file, Send to canvas opens a project', async ({ page }) => {
    await seed(page);
    await openApp(page);
    await mode(page, 'Image');
    await page.locator('textarea').fill('A glass bottle');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    const viewer = page.getByRole('dialog', { name: 'Result' });
    const fav = viewer.getByRole('button', { name: 'Favorites' });
    await fav.click();
    await expect(fav).toHaveAttribute('aria-pressed', 'true');
    await viewer.getByRole('button', { name: /^Regenerate/ }).click();
    await expect(viewer.getByRole('button', { name: 'v2' })).toHaveAttribute('aria-pressed', 'true');
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: /^Download/ }).click();
    expect((await download).suggestedFilename()).toMatch(/^A-glass-bottle-v2\.svg$/);
    await viewer.getByRole('button', { name: /^Send to canvas/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
  });

  test('+ Upload opens the file chooser and adds the file as a My assets reference', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Add assets or skills' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Upload images, video or audio' }).click();
    await (await chooser).setFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: PNG_2X2 });
    await expect(page.getByRole('status')).toContainText('1 file added to My assets');
    await expect(page.getByRole('button', { name: 'Remove reference' }).first()).toBeVisible();
    await expect(page.locator('section[aria-label="Start creating"]')).toContainText('bottle');
  });

  test('palette: Voice opens Voices, settings commands appear only where the mode has that pill', async ({ page }) => {
    await openApp(page);
    await mode(page, 'Image');
    const ta = page.locator('textarea');
    await ta.fill('/dur');
    await expect(page.getByRole('listbox', { name: 'Commands' })).toContainText('No matching commands');
    await ta.fill('/voice');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/assets\?folder=voices$/);
  });

  test('model pills and picker rows show provider marks; Lumina models keep the letter tile', async ({ page }) => {
    await openApp(page);
    await mode(page, 'Video');
    const pill = page.getByRole('button', { name: 'Model: Seedance 2.5' });
    await expect(pill.locator('[data-brand="bytedance"]')).toBeVisible();
    await pill.click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await expect(picker.locator('[data-model-icon="minimax"]')).toBeVisible();
    await expect(picker.locator('[data-model-icon="alibaba"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await mode(page, 'Avatar');
    await page.getByRole('button', { name: /^Model:/ }).click();
    await expect(page.getByRole('dialog', { name: 'Choose model' }).locator('[data-model-icon]')).toHaveCount(0);
  });

  test('recent project cards open their canvas; Inspiration tabs filter; a feed card previews, its Use template opens Quick Create', async ({ page }) => {
    await openApp(page);
    const feed = page.locator('section[aria-labelledby="h-insp"]');
    await feed.getByRole('tab', { name: 'Short drama' }).click();
    const cards = feed.locator('[data-template-card]');
    await expect(cards).toHaveCount(1);
    await cards.first().getByRole('button', { name: 'Preview Period drama opener' }).click();
    await expect(page.getByRole('dialog', { name: 'Period drama opener' })).toBeVisible();
    await page.keyboard.press('Escape');
    await cards.first().hover();
    await feed.getByRole('link', { name: 'Use template: Period drama opener' }).click();
    await expect(page).toHaveURL(/\/create\/quick\?template=tpl_09$/);
    await page.goto('/');
    await page.locator('#projects').getByRole('link', { name: /Desk organizer pitch/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_02$/);
  });
});
