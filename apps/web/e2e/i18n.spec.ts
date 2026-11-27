import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { pseudoMessage } from '../src/i18n/pseudo';

const MESSAGES = new URL('../../../messages/', import.meta.url);
/** A message's text in a locale (English for the pseudo-locale and missing keys); plain text only. */
function message(locale: string, id: string): string {
  for (const l of [locale, 'en']) {
    let dir: string[] = [];
    try {
      dir = readdirSync(new URL(`${l}/`, MESSAGES));
    } catch {
      continue;
    }
    for (const f of dir) {
      const v = (JSON.parse(readFileSync(new URL(`${l}/${f}`, MESSAGES), 'utf8')) as Record<string, string>)[id];
      if (v) return locale === 'en-XA' ? pseudoMessage(v) : v;
    }
  }
  throw new Error(`no message ${id}`);
}

/**
 * D-023: UI localization. Locale switch without a reload, browser language for signed-out
 * visitors, the English-governs note on legal pages, and an overflow sweep (buttons, pills,
 * tabs, header nav) on key screens in every locale and the pseudo-locale (en-XA, mock builds).
 * `PW_I18N_SHOTS=<dir>` also writes screenshots to <dir>/<locale>-<width>-<screen>.png;
 * `PW_I18N_LOCALES=en,ja` narrows the sweep.
 */

const LOCALES = (process.env.PW_I18N_LOCALES?.split(',') ?? ['zh-CN', 'zh-TW', 'ja', 'ko', 'en-XA']) as readonly string[];
const SCREENS = [
  ['home', '/'],
  ['create-quick', '/create/quick'],
  ['assets', '/assets'],
  ['library', '/assets/public'],
  ['templates', '/templates'],
  ['activity', '/activity'],
  ['upgrade', '/upgrade'],
  ['settings-prefs', '/settings/preferences'],
  ['settings-billing', '/settings/billing'],
  ['settings-team', '/settings/team'],
  ['project', '/p/prj_demo'],
  ['login', '/login'],
  ['legal', '/legal/terms'],
] as const;
const WIDTHS = [1440, 1280] as const;
const SHOTS = process.env.PW_I18N_SHOTS;

async function withLocale(page: Page, locale: string) {
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('rolling.locale', l);
    } catch {
      /* private mode */
    }
  }, locale);
}

/** Controls whose text is cut or spills out of their box. */
async function overflowing(page: Page) {
  return page.evaluate(() => {
    const sel = 'button, [role="tab"], [role="button"], [role="menuitem"], [role="radio"], header a, nav a, [data-pill], label';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || el.closest('[aria-hidden="true"]')) continue;
      const text = (el.innerText || '').trim();
      if (!text) continue;
      // Clipped horizontally (ellipsis or hidden overflow), or content wider than the box.
      const clipped = el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible' && style.overflowX !== 'auto' && style.overflowX !== 'scroll';
      const spills = Array.from(el.querySelectorAll<HTMLElement>('*')).some((c) => {
        const cr = c.getBoundingClientRect();
        return cr.width > 0 && (cr.right > r.right + 2 || cr.left < r.left - 2) && getComputedStyle(c).position !== 'absolute';
      });
      // A short control whose own text wrapped onto a second line (headless text only, not stacked children).
      let wrapped = false;
      if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab' || el.closest('header')) && r.width < 600 && r.height < 48 && !text.includes('\n')) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n && !wrapped; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const tops = new Set(Array.from(range.getClientRects()).filter((q) => q.width > 1).map((q) => Math.round(q.top / 4)));
          wrapped = tops.size > 1;
        }
      }
      if (clipped || spills || wrapped) out.push(`${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} "${text.replace(/\s+/g, ' ').slice(0, 40)}" ${clipped ? 'clipped' : spills ? 'spills' : 'wrapped'} (${Math.round(r.width)}px)`);
    }
    return out;
  });
}

test.describe('i18n (D-023)', () => {
  test('Settings → Preferences → Language switches without a reload and sets <html lang>', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/settings/preferences');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const select = page.getByRole('button', { name: /Language/ }).first();
    await select.click();
    for (const name of ['English', '简体中文', '繁體中文', '日本語', '한국어']) await expect(page.getByRole('option', { name, exact: false }).first()).toBeVisible();
    await page.getByRole('option', { name: '日本語' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.getByRole('heading', { level: 2 })).not.toHaveText('Preferences');
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });

  test('signed-out visitors get the browser language', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'ko-KR' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await ctx.close();
    const zh = await browser.newContext({ locale: 'zh-HK' });
    const p2 = await zh.newPage();
    await p2.goto('/login');
    await expect(p2.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await zh.close();
  });

  test('legal pages stay English with a governs note in the UI language', async ({ page }) => {
    await withLocale(page, 'ja');
    await page.goto('/legal/privacy');
    await expect(page.getByTestId('legal-governs')).toBeVisible();
    await expect(page.locator('article')).toHaveAttribute('lang', 'en');
  });

  for (const locale of LOCALES) {
    test(`no clipped controls on key screens: ${locale}`, async ({ page }) => {
      test.setTimeout(180_000);
      await withLocale(page, locale);
      const problems: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const [name, path] of SCREENS) {
          await page.goto(path);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          for (const p of await overflowing(page)) problems.push(`${width} ${name}: ${p}`);
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/${locale}-${width}-${name}.png` });
          if (name === 'home' && locale !== 'en-XA') {
            // The header credits and settings popovers, and the language list.
            await page.getByRole('button', { name: /2,480|2.480/ }).first().click();
            await page.waitForTimeout(400);
            const doc = await page.evaluate(() => document.documentElement.scrollWidth);
            if (doc > width) problems.push(`${width} credits-popover: page is ${doc}px wide`);
            for (const p of await overflowing(page)) problems.push(`${width} credits-popover: ${p}`);
            if (SHOTS) await page.screenshot({ path: `${SHOTS}/${locale}-${width}-credits.png` });
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: message(locale, 'header.settings'), exact: true }).click();
            await page.waitForTimeout(400);
            for (const p of await overflowing(page)) problems.push(`${width} settings-popover: ${p}`);
            if (SHOTS) await page.screenshot({ path: `${SHOTS}/${locale}-${width}-settings.png` });
            // Its language list (the first row).
            await page.getByRole('button', { name: new RegExp(`^${message(locale, 'settingsPopover.language').replace(/[[\]().*+?^$|\\{}]/g, '\\$&')}`) }).click();
            await page.waitForTimeout(400);
            for (const p of await overflowing(page)) problems.push(`${width} language-list: ${p}`);
            if (SHOTS) await page.screenshot({ path: `${SHOTS}/${locale}-${width}-languages.png` });
            await page.keyboard.press('Escape');
          }
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
});
