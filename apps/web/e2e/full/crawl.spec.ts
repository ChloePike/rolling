import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { account, env, SAMPLE_OPS, seedProject, shot, watchErrors } from './support';

/**
 * Matrix: X-1 … X-5 (cross-cutting). A sandbox member account; anything that would spend, pay, sign out or
 * delete is not clicked (and run starts are answered with “Not enough credits” so nothing can be held).
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const PAGES = ['/', '/create/quick', '/create/remix', '/create/avatar', '/create/character', '/templates', '/assets', '/assets/public', '/activity', '/upgrade', '/settings/account', '/settings/preferences', '/settings/billing', '/settings/team', '/settings/notifications', 'CANVAS'];
const SKIP = /Log out|Delete|Remove|Cancel plan|Switch to|Buy |Continue with|Send feedback|Top up \$|Export MP4|Discard|^Account$/;
const NOT_IMPLEMENTED = /not implemented|coming soon|todo|lorem ipsum|\bmock\b/i;
const AXE = process.env.PW_AXE_PATH ?? '';

async function guard(page: Page) {
  await page.route('**/api/runs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'crawl guard', data: { needed: 999999, balance: 0 } } }) })
      : route.continue(),
  );
  await page.route('**/api/billing/checkout', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'crawl guard', data: {} } }) }));
  await page.route('**/api/agent/threads/*/messages', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'crawl guard', data: {} } }) }));
}

async function tag(page: Page): Promise<Array<{ id: number; name: string }>> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="menuitem"], [role="tab"], [role="switch"], [role="radio"], a[href]')] as HTMLElement[];
    const out: Array<{ id: number; name: string }> = [];
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
      if (disabled || r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') return;
      if (el.tagName === 'A' && !(el.getAttribute('href') ?? '').startsWith('#')) return; // links navigate; checked separately
      el.dataset.crawl = String(i);
      out.push({ id: i, name: (el.getAttribute('aria-label') || el.innerText || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    });
    return out;
  });
}

async function open(page: Page, path: string, canvasPath: string) {
  await page.goto(path === 'CANVAS' ? canvasPath : path);
  await expect(page.getByTestId('app-header').or(page.getByTestId('canvas')).first()).toBeVisible({ timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

for (const path of PAGES) {
  test(`X-1 no dead controls on ${path}: every enabled button does something, no console errors, no 5xx, no “not implemented”`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(10 * 60_000);
    await account(context, baseURL, `crawl${PAGES.indexOf(path)}`, 'plus');
    const p = await seedProject(context.request, baseURL, 'Crawl canvas', SAMPLE_OPS);
    const canvasPath = `/p/${p.id}`;
    await guard(page);
    const errs = watchErrors(page, { ignore: [/crawl guard/, /402/] });
    let requests = 0;
    page.on('request', () => (requests += 1));
    context.on('page', (np) => void np.close().catch(() => undefined));
    await open(page, path, canvasPath);
    const home = page.url();
    const controls = await tag(page);
    const dead: string[] = [];
    const notImpl: string[] = [];
    for (const c of controls) {
      if (SKIP.test(c.name)) continue;
      if (page.url() !== home) await open(page, path, canvasPath).then(() => tag(page));
      const el = page.locator(`[data-crawl="${c.id}"]`);
      if (!(await el.isVisible().catch(() => false)) || !(await el.isEnabled().catch(() => false))) continue;
      await page.evaluate(() => {
        const w = window as unknown as { __m: number; __o?: MutationObserver };
        w.__m = 0;
        w.__o?.disconnect();
        w.__o = new MutationObserver((ms) => (w.__m += ms.length));
        w.__o.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const req0 = requests;
      const url0 = page.url();
      const focus0 = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '');
      let downloaded = false;
      const onDl = () => (downloaded = true);
      page.once('download', onDl);
      await el.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      page.off('download', onDl);
      const muts = await page.evaluate(() => (window as unknown as { __m: number }).__m);
      const focus1 = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '');
      if (muts === 0 && requests === req0 && page.url() === url0 && !downloaded && focus0 === focus1) dead.push(c.name || `#${c.id}`);
      const body = await page.locator('[role="status"], [role="alert"], [role="dialog"]').allInnerTexts().catch(() => []);
      if (body.some((t) => NOT_IMPLEMENTED.test(t))) notImpl.push(`${c.name}: ${body.find((t) => NOT_IMPLEMENTED.test(t))!.slice(0, 80)}`);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await shot(page, testInfo, 'end');
    testInfo.annotations.push({ type: 'controls', description: `${controls.length} controls, dead: ${JSON.stringify(dead)}, notImpl: ${JSON.stringify(notImpl)}` });
    expect(dead, `dead controls on ${path}`).toEqual([]);
    expect(notImpl, `“not implemented” on ${path}`).toEqual([]);
    errs.assertClean(path);
  });
}

test('X-2 loading shows skeletons, never mock data, while the API is slow', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'skeleton', 'plus');
  await seedProject(context.request, baseURL, 'Skeleton project', []);
  const DEMO = /Ridgeline|Desk organizer pitch|Lead · Mia|Alex Chen|2,480/;
  await page.route('**/api/**', async (route) => {
    if (route.request().resourceType() === 'fetch' && !/\/api\/(me|auth)/.test(route.request().url())) await new Promise((r) => setTimeout(r, 3000));
    await route.continue().catch(() => undefined);
  });
  const results: string[] = [];
  for (const [path, testIds] of [
    ['/', ['project-skeleton', 'templates-skeleton']],
    ['/activity', ['row-skeleton', 'stat-skeleton']],
    ['/templates', ['templates-skeleton']],
  ] as const) {
    await page.goto(path);
    await page.waitForTimeout(1200);
    const text = await page.locator('body').innerText();
    if (DEMO.test(text)) results.push(`${path}: demo literal during load`);
    let any = false;
    for (const t of testIds) if ((await page.getByTestId(t).count()) > 0) any = true;
    if (!any && (await page.locator('[aria-busy="true"]').count()) === 0) results.push(`${path}: no skeleton while loading`);
    await shot(page, testInfo, `loading${path.replace(/\//g, '_')}`);
  }
  expect(results).toEqual([]);
});

test('X-3 reduced motion: popovers, dialogs and toasts use opacity only (no transform transitions or animations)', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'motion', 'plus');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const moving = async () =>
    page.evaluate(() => {
      const bad: string[] = [];
      for (const a of document.getAnimations()) {
        const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? [];
        // Keyframes built on the motion tokens keep a transform that resolves to zero movement under reduced motion.
        const moves = (v: unknown) => {
          const t = String(v ?? 'none');
          if (t === 'none') return false;
          const target = (a.effect as KeyframeEffect).target as Element | null;
          const probe = document.createElement('div');
          (target?.parentElement ?? document.body).appendChild(probe);
          probe.style.transform = t;
          const m = getComputedStyle(probe).transform;
          probe.remove();
          return m !== 'none' && m !== 'matrix(1, 0, 0, 1, 0, 0)';
        };
        if (kf.some((k) => moves((k as Record<string, unknown>).transform) || moves((k as Record<string, unknown>).translate ? `translate(${String((k as Record<string, unknown>).translate)})` : undefined)))
          bad.push(`moving animation on ${((a.effect as KeyframeEffect).target as Element | null)?.className ?? '?'}`);
      }
      for (const el of document.querySelectorAll('[role="dialog"], [role="menu"], [role="status"], [role="listbox"]')) {
        const cs = getComputedStyle(el);
        const durs = cs.transitionDuration.split(',').map((d) => Number.parseFloat(d));
        const props = cs.transitionProperty.split(',').map((s) => s.trim());
        props.forEach((p, i) => {
          if ((p === 'transform' || p === 'all' || p === 'translate' || p === 'scale') && (durs[i] ?? durs[0] ?? 0) > 0) bad.push(`${el.getAttribute('role')}: transition ${p}`);
        });
      }
      return bad;
    });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const a = await moving();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Credit balance/ }).click();
  const b = await moving();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const c = await moving();
  await shot(page, testInfo, 'reduced-motion');
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ['--m-move-popover', '--m-move-toast', '--m-scale-min', '--m-stagger'].map((v) => `${v}=${cs.getPropertyValue(v).trim()}`);
  });
  expect(tokens).toEqual(['--m-move-popover=0px', '--m-move-toast=0px', '--m-scale-min=1', '--m-stagger=0ms']);
  expect([...new Set([...a, ...b, ...c])]).toEqual([]);
});

test('X-4 focus rings only on :focus-visible — none after a mouse click in the Settings nav, one after Tab', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'focus');
  await page.goto('/settings/account');
  const ring = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { tag: 'body', ring: false, desc: '' };
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0;
      const shadow = /rgb\(59, 130, 246|rgba\(59, 130, 246|rgb\(96, 165, 250/.test(cs.boxShadow);
      return { tag: el.tagName, ring: outline || shadow, desc: `${el.tagName} ${el.textContent?.trim().slice(0, 30)} outline=${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} shadow=${cs.boxShadow}` };
    });
  const nav = page.getByTestId('settings-section').locator('xpath=preceding::nav[1]').or(page.locator('nav').filter({ hasText: 'Preferences' })).first();
  const prefs = nav.getByRole('link', { name: 'Preferences' }).or(nav.getByRole('button', { name: 'Preferences' })).first();
  await prefs.click();
  await expect(page).toHaveURL(/\/settings\/preferences/);
  await page.waitForTimeout(400);
  const afterClick = await ring();
  await shot(page, testInfo, 'after-mouse-click');
  expect(afterClick.ring, `no ring after a mouse click: ${afterClick.desc}`).toBe(false);
  // Clicking each settings nav item.
  for (const name of ['Account', 'Plan and billing', 'Team', 'Notifications']) {
    const item = nav.getByRole('link', { name }).or(nav.getByRole('button', { name })).first();
    if (!(await item.isVisible().catch(() => false))) continue;
    await item.click();
    await page.waitForTimeout(300);
    const r = await ring();
    expect(r.ring, `no ring after clicking ${name}: ${r.desc}`).toBe(false);
  }
  // Keyboard: Tab shows a ring.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const kb = await ring();
  expect(kb.ring, `ring on keyboard focus: ${kb.desc}`).toBe(true);
});

test('X-5 accessibility smoke (axe-core): no critical violations on the main pages', async ({ page, context, baseURL }, testInfo) => {
  test.skip(!AXE || !existsSync(AXE), 'PW_AXE_PATH (axe.min.js) not set');
  test.setTimeout(5 * 60_000);
  await account(context, baseURL, 'axe', 'plus');
  const source = readFileSync(AXE, 'utf8');
  const critical: string[] = [];
  const serious: string[] = [];
  for (const path of ['/', '/templates', '/assets/public', '/activity', '/upgrade', '/settings/account', '/settings/preferences', '/settings/billing', '/login']) {
    if (path === '/login') await context.clearCookies();
    await page.goto(path);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.addScriptTag({ content: source });
    const res = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }>; help: string }> }> } }).axe;
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: `${v.help} [${v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | ')}]` }));
    });
    for (const v of res) {
      const line = `${path} ${v.id} (${v.n}): ${v.help}`;
      if (v.impact === 'critical') critical.push(line);
      else if (v.impact === 'serious') serious.push(line);
    }
  }
  testInfo.annotations.push({ type: 'axe-serious', description: serious.join('\n') });
  testInfo.annotations.push({ type: 'axe-critical', description: critical.join('\n') });
  expect(critical).toEqual([]);
});
