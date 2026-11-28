import { expect, test } from '@playwright/test';
import { account, env, shot } from './support';

/** Matrix: PWA-1 … PWA-4. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

test('PWA-1 manifest: standalone, theme/background #0B0B0C, start_url /, icons 192/512/maskable', async ({ page, request }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const r = await request.get(href!);
  expect(r.status()).toBe(200);
  const m = (await r.json()) as { display: string; theme_color: string; background_color: string; start_url: string; icons: Array<{ sizes: string; purpose?: string; src: string }>; name: string };
  expect(m.display).toBe('standalone');
  expect(m.theme_color.toUpperCase()).toBe('#0B0B0C');
  expect(m.background_color.toUpperCase()).toBe('#0B0B0C');
  expect(m.start_url).toBe('/');
  expect(m.icons.some((i) => i.sizes === '192x192')).toBe(true);
  expect(m.icons.some((i) => i.sizes === '512x512' && (i.purpose ?? '').includes('maskable'))).toBe(true);
  for (const i of m.icons) expect((await request.get(i.src)).status(), i.src).toBe(200);
  const apple = await page.locator('link[rel="apple-touch-icon"]').first().getAttribute('href');
  expect(apple, 'apple-touch-icon link').toBeTruthy();
  expect((await request.get(apple!)).status()).toBe(200);
});

test('PWA-2 service worker registers and controls the page', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'sw');
  await page.goto('/');
  const scope = await page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    return reg ? reg.scope : null;
  });
  expect(scope).toBe(`${new URL(baseURL!).origin}/`);
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test('PWA-3 offline: the app shell loads from the cache and shows the offline page; back online it recovers', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'offline');
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.goto('/activity').catch(() => undefined);
  await expect(page.getByTestId('offline-page').or(page.getByTestId('app-header')).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('offline-page')).toBeVisible();
  await shot(page, testInfo, 'offline');
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 30_000 });
});

test('PWA-4 silent update (D-038): a waiting service worker shows no prompt and never reloads the open page', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'update');
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const waiting = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update().catch(() => undefined);
    return !!reg?.waiting;
  });
  if (!waiting) testInfo.annotations.push({ type: 'note', description: 'No new deploy waiting; checked that the open page does not reload and shows no prompt.' });
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  await expect(page.getByText('A new version is ready')).toHaveCount(0);
});
