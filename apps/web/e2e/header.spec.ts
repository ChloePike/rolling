import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDesignPage } from './support/design';
import { asPlan } from './support/session';
import { routeModels } from './support/models';
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

/**
 * D-006 replaced the drawn credit packs (1,000 / 3,000 / 10,000 at $[Price])
 * with any-amount top-ups: five suggested amounts with the credits they buy
 * (Pro member, bonus included). Same card style, five columns.
 */
const D006_TOP_UPS: ReadonlyArray<readonly [string, string]> = [
  ['grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">\n            <sc-for list="{{ packs }}"', 'grid-template-columns:repeat(5,minmax(0,1fr));gap:6px">\n            <sc-for list="{{ packs }}"'],
  ['<span style="font-size:11px;color:#9A9AA0">$[Price]</span>', '<span style="font-size:11px;color:#9A9AA0">{{ k.c }}</span>'],
  ['Top up {{ packN }} credits', 'Top up {{ packN }} · {{ packC }} credits'],
  ["const pack = S.pack || '3,000';", "const pack = S.pack || '$25'; const credits = { '$10': '1,100', '$25': '2,850', '$50': '6,000', '$100': '12,500', '$250': '31,250' };"],
  ['packN: pack,', 'packN: pack, packC: credits[pack],'],
  ["packs: ['1,000', '3,000', '10,000'].map((n) => ({ n, ", "packs: ['$10', '$25', '$50', '$100', '$250'].map((n) => ({ n, c: credits[n], "],
];

/** D-010 adds a Theme row (System by default) under Notify when done in the settings popover. */
const NOTIFY_ROW = '<div style="display:flex;align-items:center;font-size:13px"><span style="flex:1;color:#C8C8CC">Notify when done</span><span style="color:#9A9AA0">On ›</span></div>';
const D010_THEME_ROW: ReadonlyArray<readonly [string, string]> = [
  [NOTIFY_ROW, `${NOTIFY_ROW}\n        <div style="display:flex;align-items:center;font-size:13px"><span style="flex:1;color:#C8C8CC">Theme</span><span style="color:#9A9AA0">System ›</span></div>`],
];

async function openDesign(page: Page, width: number, props: Record<string, unknown> = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(buildDesignPage('Main.dc.html', props, [...D006_TOP_UPS, ...D010_THEME_ROW]));
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
    // The active background is the sliding pill behind the active item.
    const pill = await page.getByTestId('nav-pill').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { background: getComputedStyle(el).backgroundColor, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
    });
    expect(pill.background).toBe(design.navItems[0]!.background);
    expectBoxClose(pill.box, design.navItems[0]!.box, 'active nav pill');
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

/** Opens a header popover in the rendered Main.dc.html by clicking its trigger. */
async function openDesignPopover(page: Page, trigger: string) {
  await openDesign(page, 1440);
  await page.locator(trigger).click();
}

const POPOVERS = [
  { name: 'credits', trigger: 'button[aria-label^="Credit balance"]', design: '[role="dialog"][aria-label="credits"]', app: (p: Page) => p.getByRole('dialog', { name: 'Credits' }) },
  { name: 'account', trigger: 'button[aria-label="Account"]', design: '[role="menu"][aria-label="Account"]', app: (p: Page) => p.getByRole('menu', { name: 'Account' }) },
  { name: 'settings', trigger: 'button[aria-label="Settings"]', design: '[role="dialog"][aria-label="Settings"]', app: (p: Page) => p.getByRole('dialog', { name: 'Settings' }) },
] as const;

test.describe('header popovers', () => {
  for (const pop of POPOVERS) {
    test(`${pop.name} popover matches Main.dc.html: box within 2px, pixel diff under 1%`, async ({ page }) => {
      await openDesignPopover(page, pop.trigger);
      const d = (await page.locator(pop.design).boundingBox())!;
      const clip = { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) };
      const design = await page.screenshot({ clip });
      mkdirSync(`${SCREENS_OUT}shell/`, { recursive: true });
      await page.screenshot({ clip, path: `${SCREENS_OUT}shell/${pop.name}-design.png` });

      await openApp(page, 1440);
      await page.locator(pop.trigger).click();
      const layer = pop.app(page);
      await expect(layer).toBeVisible();
      await page.mouse.move(10, 600);
      await page.waitForTimeout(400);
      const a = (await layer.boundingBox())!;
      const app = await page.screenshot({ clip });
      await page.screenshot({ clip, path: `${SCREENS_OUT}shell/${pop.name}.png` });
      expectBoxClose(a, d, `${pop.name} popover`);
      const ratio = await pixelDiffRatio(page, app, design);
      console.log(`pixel-diff header-${pop.name}: ${(ratio * 100).toFixed(3)}%`);
      expect(ratio).toBeLessThan(0.01);
    });
  }

  test('credits popover: top-up presets select, the button follows; only one popover open at a time', async ({ page }) => {
    await openApp(page, 1440);
    await page.getByRole('button', { name: /Credit balance/ }).click();
    const credits = page.getByRole('dialog', { name: 'Credits' });
    // D-006: suggested amounts with credits from quoteTopUp (Pro member: tier bonus + 10%).
    await expect(credits.getByRole('radio')).toHaveText([/^\$10\s*1,100$/, /^\$25\s*2,850$/, /^\$50\s*6,000$/, /^\$100\s*12,500$/, /^\$250\s*31,250$/]);
    await expect(credits.getByRole('button', { name: 'Top up $25 · 2,850 credits' })).toBeVisible();
    await credits.getByRole('radio', { name: /^\$100/ }).click();
    await expect(credits.getByRole('radio', { name: /^\$100/ })).toHaveAttribute('aria-checked', 'true');
    await expect(credits.getByRole('button', { name: 'Top up $100 · 12,500 credits' })).toBeVisible();
    await expect(credits.getByText('Expires Nov 30')).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Credits' })).toHaveCount(0);
  });

  test('credits popover: non-members see no top-ups, only a way to pick a plan (D-007)', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, 1440);
    await page.getByRole('button', { name: /Credit balance/ }).click();
    const credits = page.getByRole('dialog', { name: 'Credits' });
    await expect(credits.getByRole('radio')).toHaveCount(0);
    await expect(credits.getByRole('link', { name: 'Pick a plan to top up' })).toHaveAttribute('href', '/upgrade');
  });

  test('account menu: arrow keys move focus, workspace switch, Escape returns focus', async ({ page }) => {
    await openApp(page, 1440);
    const avatar = page.getByRole('button', { name: 'Account' });
    await avatar.click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu.getByRole('menuitemradio', { name: /Personal/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: /Ridgeline/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu.getByRole('menuitemradio', { name: /Ridgeline/ })).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Profile', 'Settings', 'Plans and billing', 'Billing and invoices', 'Members', 'Help and feedback', 'Log out']) {
      await expect(menu.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(avatar).toBeFocused();
  });
});

test.describe('header motion', () => {
  test('popover enters 200ms standard and leaves 140ms exit', async ({ page }) => {
    await openApp(page, 1440);
    await page.getByRole('button', { name: 'Settings' }).click();
    const layer = page.getByRole('dialog', { name: 'Settings' });
    const enter = await layer.evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).animationDuration, getComputedStyle(el).animationTimingFunction]);
    expect(enter).toEqual(['rl-pop-in', '0.2s', 'cubic-bezier(0.2, 0, 0, 1)']);
    await page.keyboard.press('Escape');
    const exit = await page.locator('[data-state="closed"]').evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).animationDuration]);
    expect(exit).toEqual(['rl-pop-out', '0.14s']);
    await expect(page.locator('[data-state="closed"]')).toHaveCount(0);
  });

  test('active nav pill slides to the new item over 200ms on navigation', async ({ page }) => {
    await openApp(page, 1440);
    const pill = page.getByTestId('nav-pill');
    await page.waitForTimeout(100);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
    const target = (await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).boundingBox())!;
    const transition = await pill.evaluate((el) => getComputedStyle(el).transition);
    expect(transition).toContain('transform 0.2s cubic-bezier(0.2, 0, 0, 1)');
    await page.waitForTimeout(400);
    const end = (await pill.boundingBox())!;
    expectBoxClose(end, target, 'pill after slide');
  });

  test('reduced motion: popover fades without moving, pill jumps', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, 1440);
    await page.getByRole('button', { name: /Credit balance/ }).click();
    const layer = page.getByRole('dialog', { name: 'Credits' });
    const t = await layer.evaluate((el) => [getComputedStyle(el).transform, getComputedStyle(el).animationDuration]);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(t[0]);
    expect(t[1]).toBe('0.2s');
    const pillTransition = await page.getByTestId('nav-pill').evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(pillTransition).toBe('opacity');
  });
});

test.describe('splash', () => {
  test('final frame matches Splash.dc.html (reduced motion) within 1% and stays under 1.2s when playing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setContent(buildDesignPage('Splash.dc.html'));
    await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
    await page.evaluate(() => document.fonts.ready);
    // The REC dot blinks in both; hide it so the frame is deterministic.
    await page.addStyleTag({ content: '.tc i{visibility:hidden}' });
    const clip = { x: 0, y: 0, width: 1440, height: 900 };
    const design = await page.screenshot({ clip });
    mkdirSync(`${SCREENS_OUT}splash/`, { recursive: true });
    await page.screenshot({ clip, path: `${SCREENS_OUT}splash/splash-design.png` });

    await page.goto('/?splash=hold');
    await page.getByTestId('splash').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '[data-testid="splash"] i{visibility:hidden}' });
    await page.waitForTimeout(400);
    const app = await page.screenshot({ clip });
    await page.screenshot({ clip, path: `${SCREENS_OUT}splash/splash.png` });
    const ratio = await pixelDiffRatio(page, app, design);
    console.log(`pixel-diff splash: ${(ratio * 100).toFixed(3)}%`);
    expect(ratio).toBeLessThan(0.01);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const start = Date.now();
    await page.goto('/?splash=1');
    await page.getByTestId('splash').waitFor();
    const mark = page.getByTestId('splash').locator('span').nth(1);
    expect(await mark.evaluate((el) => getComputedStyle(el).animationTimingFunction)).toBe('cubic-bezier(0.3, 1.4, 0.4, 1)');
    await expect(page.getByTestId('splash')).toHaveCount(0, { timeout: 2000 });
    expect(Date.now() - start).toBeLessThan(2500);
  });

  test('does not play in a normal browser tab', async ({ page }) => {
    await openApp(page, 1440);
    await expect(page.getByTestId('splash')).toHaveCount(0);
  });
});

/** Interaction pass: every header control does something observable (docs/interaction-pass.md). */
test.describe('header interactions', () => {
  const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
  const openSettings = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(settings(page)).toBeVisible();
  };
  const row = (page: Page, label: string) => settings(page).getByRole('button', { name: new RegExp(`^${label}:`) });

  test('settings: Language opens the language list; Deutsch formats numbers in German and survives reload', async ({ page }) => {
    await openApp(page, 1440);
    await openSettings(page);
    await row(page, 'Language').click();
    const list = settings(page).getByRole('menu', { name: 'Language' });
    await expect(list.getByRole('menuitemradio')).toHaveCount(12);
    await expect(list.getByRole('menuitemradio', { name: /^English/ })).toHaveAttribute('aria-checked', 'true');
    for (const name of ['日本語', '繁體中文（台灣）', '繁體中文（香港）', '한국어', 'Deutsch']) {
      await expect(list.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })).toContainText('Not translated yet');
    }
    await list.getByRole('menuitemradio', { name: /^Deutsch/ }).click();
    await expect(row(page, 'Language')).toContainText('Deutsch');
    // English text, German number format.
    await expect(page.getByRole('button', { name: /Credit balance/ })).toContainText('2.480');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(page.getByRole('button', { name: /Credit balance/ })).toContainText('2.480');
  });

  test('settings: Currency, Default aspect ratio and Notify when done save to prefs, show in the row and persist', async ({ page }) => {
    await routeModels(page);
    await openApp(page, 1440);
    await openSettings(page);
    await row(page, 'Currency').click();
    await settings(page).getByRole('menuitemradio', { name: /^JPY/ }).click();
    await expect(row(page, 'Currency')).toContainText('JPY');
    await row(page, 'Default aspect ratio').click();
    await settings(page).getByRole('menuitemradio', { name: /^16:9/ }).click();
    await expect(row(page, 'Default aspect ratio')).toContainText('16:9');
    await row(page, 'Notify when done').click();
    await settings(page).getByRole('menuitemradio', { name: /^Off/ }).click();
    await expect(row(page, 'Notify when done')).toContainText('Off');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rolling.prefs') ?? '{}'));
    expect(stored).toMatchObject({ currency: 'JPY', defaultAspectRatio: '16:9', notifyWhenDone: false });
    // Prices follow the currency; the Home video settings start from the default ratio.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Credit balance/ }).click();
    await expect(page.getByRole('dialog', { name: 'Credits' }).getByRole('radio').first()).toContainText('¥1,500');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('tab', { name: 'Video' }).click();
    await expect(page.getByRole('button', { name: /^16:9 · 720p/ })).toBeVisible();
    await openSettings(page);
    await expect(row(page, 'Currency')).toContainText('JPY');
    await expect(row(page, 'Notify when done')).toContainText('Off');
  });

  test('settings: Theme row sets data-theme light/dark and removes it for System (D-010)', async ({ page }) => {
    await openApp(page, 1440);
    await openSettings(page);
    await expect(row(page, 'Theme')).toContainText('System');
    await row(page, 'Theme').click();
    const list = settings(page).getByRole('menu', { name: 'Theme' });
    await expect(list.getByRole('menuitemradio')).toHaveText([/System \(default\)/, /Light/, /Dark/]);
    await list.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openSettings(page);
    await row(page, 'Theme').click();
    await settings(page).getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await row(page, 'Theme').click();
    await settings(page).getByRole('menuitemradio', { name: /System/ }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('settings keyboard: Enter opens a list on its current value, arrows move, Enter picks, Escape steps back then closes', async ({ page }) => {
    await openApp(page, 1440);
    await openSettings(page);
    await row(page, 'Default aspect ratio').focus();
    await page.keyboard.press('Enter');
    await expect(settings(page).getByRole('menuitemradio', { name: /^9:16/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(settings(page).getByRole('menuitemradio', { name: /^1:1/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row(page, 'Default aspect ratio')).toContainText('1:1');
    await expect(row(page, 'Default aspect ratio')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(settings(page)).toBeVisible();
    await expect(row(page, 'Default aspect ratio')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(settings(page)).toHaveCount(0);
  });

  test('settings lists: rows stagger in; reduced motion keeps them still', async ({ page }) => {
    await openApp(page, 1440);
    await openSettings(page);
    await row(page, 'Currency').click();
    const delays = await settings(page).getByRole('menuitemradio').evaluateAll((els) => els.slice(0, 8).map((el) => getComputedStyle(el).animationDelay));
    expect(delays).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s', '0.15s']);
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await row(page, 'Language').click();
    const t = await settings(page).getByRole('menuitemradio').first().evaluate((el) => getComputedStyle(el).transform);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(t);
  });

  test('credits: Top up runs the mock checkout, the balance increases and a toast confirms', async ({ page }) => {
    await openApp(page, 1440);
    await page.getByRole('button', { name: /Credit balance/ }).click();
    const credits = page.getByRole('dialog', { name: 'Credits' });
    await credits.getByRole('button', { name: 'Top up $25 · 2,850 credits' }).click();
    await expect(credits.getByRole('button', { name: 'Processing payment…' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Added 2,850 credits. Balance 5,330.');
    await expect(page.getByRole('button', { name: /Credit balance/ })).toContainText('5,330');
    await expect(credits.getByText('3,530')).toBeVisible(); // purchased 680 + 2,850
  });

  test('credits: a failed checkout says nothing was charged and offers Retry', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { checkout: 'fail', latencyMs: 50 };
    });
    await openApp(page, 1440);
    await page.getByRole('button', { name: /Credit balance/ }).click();
    await page.getByRole('dialog', { name: 'Credits' }).getByRole('button', { name: /^Top up \$25/ }).click();
    await expect(page.getByRole('status')).toContainText('Payment didn’t go through. Nothing was charged.');
    await expect(page.getByRole('status').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Credit balance/ })).toContainText('2,480');
  });

  test('account menu: workspace switch persists, Help opens a feedback dialog, Log out goes to /login', async ({ page }) => {
    await openApp(page, 1440);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitemradio', { name: /Ridgeline/ }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menuitemradio', { name: /Ridgeline/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitem', { name: 'Help and feedback' }).click();
    const help = page.getByRole('dialog', { name: 'Help and feedback' });
    await expect(help).toBeVisible();
    await expect(help.getByRole('button', { name: 'Send feedback' })).toBeDisabled();
    await help.getByRole('textbox', { name: 'Feedback' }).fill('The timeline needs snapping.');
    await help.getByRole('button', { name: 'Send feedback' }).click();
    await expect(page.getByRole('status')).toContainText('Feedback sent. Thank you.');
    await expect(help).toHaveCount(0);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('account menu links and Upgrade navigate', async ({ page }) => {
    await openApp(page, 1440);
    for (const [name, url] of [
      ['Profile', /\/u\/alex$/],
      ['Settings', /\/settings\/account$/],
      ['Plans and billing', /\/upgrade$/],
      ['Billing and invoices', /\/settings\/billing$/],
      ['Members', /\/settings\/team$/],
    ] as const) {
      await page.getByTestId('app-header').getByRole('button', { name: 'Account' }).click();
      await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
      await expect(page).toHaveURL(url);
    }
    await page.getByTestId('app-header').getByRole('link', { name: 'Upgrade' }).click();
    await expect(page).toHaveURL(/\/upgrade$/);
    await page.getByRole('link', { name: 'Rolling home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});
