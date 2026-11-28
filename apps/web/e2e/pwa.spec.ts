import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * PWA (handoff 8, PWA.dc.html) against the built preview: manifest, service
 * worker registration and installability, offline navigation, `/api` never
 * served from the cache, and the silent update when a new worker waits (D-038).
 *
 * Mock builds keep the service worker off; these tests opt in with
 * localStorage `rolling.sw = "on"` (lib/pwa/register.ts).
 */
test.describe.configure({ mode: 'serial' });

async function optIn(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('rolling.sw', 'on');
    } catch {
      /* storage unavailable */
    }
  });
}

/** Opens the app and waits until the service worker controls the page. */
async function controlled(page: Page, path = '/') {
  await page.goto(path);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('manifest is linked and valid: name, start_url, scope, standalone, colors, icons incl. maskable', async ({ page, request }) => {
  await page.goto('/');
  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
    appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
    themes: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('media')),
  }));
  expect(head.manifest).toBe('/manifest.webmanifest');
  expect(head.apple).toBe('/icons/apple-touch-icon-180.png');
  expect(head.appleCapable).toBe('yes');
  expect(head.themes).toEqual(['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)']);

  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const m = (await res.json()) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; type: string; purpose: string }> };
  expect(m).toMatchObject({
    id: '/',
    name: 'Rolling',
    short_name: 'Rolling',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#0B0B0C',
    background_color: '#0B0B0C',
  });
  const want: Array<[string, number, string]> = [
    ['/icons/app-icon-192.png', 192, 'any'],
    ['/icons/app-icon-512.png', 512, 'any'],
    ['/icons/app-icon-maskable-512.png', 512, 'maskable'],
  ];
  for (const [src, size, purpose] of want) {
    const icon = m.icons.find((i) => i.src === src);
    expect(icon, src).toMatchObject({ sizes: `${size}x${size}`, type: 'image/png', purpose });
    const png = await request.get(src);
    expect(png.ok(), src).toBe(true);
    expect(pngSize(await png.body())).toEqual({ width: size, height: size });
  }
  const touch = await request.get('/icons/apple-touch-icon-180.png');
  expect(pngSize(await touch.body())).toEqual({ width: 180, height: 180 });
});

test('the service worker registers, controls the page, and the app is installable', async ({ page, context }) => {
  await optIn(context);
  await controlled(page);
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { scope: reg?.scope, script: reg?.active?.scriptURL, caches: await caches.keys() };
  });
  expect(sw.scope).toBe(new URL('/', page.url()).href);
  expect(sw.script).toBe(new URL('/sw.js', page.url()).href);
  expect(sw.caches.some((k) => k.startsWith('workbox-precache'))).toBe(true);

  // Lighthouse-style installability: Chromium's own check (manifest + icons + controlling worker).
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: Array<{ errorId: string }> };
  // `in-incognito` is the test browser context itself (every Playwright context is off-the-record), not the app.
  expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);
  const manifest = (await cdp.send('Page.getAppManifest')) as { errors: Array<{ message: string; critical: number }>; url: string };
  expect(manifest.url).toBe(new URL('/manifest.webmanifest', page.url()).href);
  expect(manifest.errors.filter((e) => e.critical)).toEqual([]);
});

test('offline: pages that need the network show the offline page; the canvas still opens; back online recovers', async ({ page, context }) => {
  await optIn(context);
  await controlled(page);
  await context.setOffline(true);

  await page.goto('/activity');
  const offline = page.getByTestId('offline-page');
  await expect(offline.getByRole('heading', { level: 1 })).toHaveText('You’re offline');
  await expect(offline).toContainText('You can keep arranging the canvas and editing the timeline. Generating and exporting need a connection.');
  await expect(offline.getByRole('button', { name: 'Try again' })).toBeVisible();

  // Canvas and timeline editing work offline (handoff 8): the shell and its code come from the precache.
  await page.goto('/p/prj_demo');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Canvas');
  await expect(page.getByTestId('offline-page')).toHaveCount(0);

  await page.goto('/activity');
  await expect(page.getByTestId('offline-page')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity');
  await expect(page.getByTestId('offline-page')).toHaveCount(0);
});

test('/api is never answered from the cache', async ({ page, context }) => {
  await optIn(context);
  let hits = 0;
  await context.route('**/api/pwa-probe**', (route) => {
    hits += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'public, max-age=3600' }, body: JSON.stringify({ hit: hits }) });
  });
  await controlled(page);
  const bodies = await page.evaluate(async () => {
    const a = await (await fetch('/api/pwa-probe')).json();
    const b = await (await fetch('/api/pwa-probe')).json();
    return [a, b];
  });
  expect(bodies).toEqual([{ hit: 1 }, { hit: 2 }]);
  expect(hits).toBe(2);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((p) => p.startsWith('/api'))).toEqual([]);

  // Offline, an API call fails instead of getting a cached or shell response.
  await context.unroute('**/api/pwa-probe**');
  await context.setOffline(true);
  const offline = await page.evaluate(() =>
    fetch('/api/pwa-probe').then(
      (r) => `status ${r.status}`,
      () => 'network error',
    ),
  );
  expect(offline).toBe('network error');
  await context.setOffline(false);
});

/**
 * The preview serves this folder (playwright.config.ts: `dist-e2e/<port>`). Its
 * static server keeps each file's length from startup, so the simulated deploy
 * changes `sw.js` without changing its size: a new precache revision for
 * `index.html`, the way a real build changes it.
 */
const SW_FILE = fileURLToPath(new URL(`../dist-e2e/${process.env.PW_PORT ?? 4173}/sw.js`, import.meta.url));

function nextBuild(script: string): string {
  const next = script.replace(/("revision":")([0-9a-f])([0-9a-f]*","url":"index\.html")/, (_m, a: string, c: string, b: string) => `${a}${c === '0' ? '1' : '0'}${b}`);
  expect(next).not.toBe(script);
  expect(next.length).toBe(script.length);
  return next;
}

test('silent update (D-038): no prompt; the waiting worker switches in on the next page change', async ({ page, context }) => {
  await optIn(context);
  await controlled(page);

  const original = readFileSync(SW_FILE, 'utf8');
  try {
    // Simulate a deploy, then the app's update check.
    writeFileSync(SW_FILE, nextBuild(original));
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);

    // Nothing is shown and nothing reloads while the user stays on the page.
    const loadedAt = await page.evaluate(() => performance.timeOrigin);
    await page.waitForTimeout(500);
    await expect(page.getByText('A new version is ready')).toHaveCount(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);

    // The next in-app navigation loads the target in full on the new version.
    await Promise.all([page.waitForEvent('load'), page.getByTestId('main-nav').locator('[data-nav]').nth(1).click()]);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(loadedAt);
    const after = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: !!reg?.waiting, active: !!reg?.active };
    });
    expect(after).toEqual({ waiting: false, active: true });
  } finally {
    writeFileSync(SW_FILE, original);
  }
});

test('mock builds keep the service worker off unless a test opts in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});
