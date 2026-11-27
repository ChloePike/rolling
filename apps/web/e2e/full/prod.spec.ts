import { expect, test } from '@playwright/test';
import { checkAdminGrantLocked, checkReplicaHeaders, checkStaticAssets } from './platform-checks';
import { watchErrors } from './support';

/**
 * Production smoke (project `full-prod`, base https://rolling.actor). Signed out and read-only: nothing here
 * creates accounts, sends email or writes data.
 */
const LEGAL = ['/privacy', '/terms', '/acceptable-use', '/subprocessors'];

test('PROD-1 health says production; test routes are 404', async ({ request }) => {
  const h = await request.get('/api/health');
  expect(h.status()).toBe(200);
  expect(((await h.json()) as { environment: string }).environment).toBe('production');
  expect((await request.get('/api/test/inbox?to=a@b.c', { headers: { authorization: 'Bearer x' } })).status()).toBe(404);
  expect((await request.post('/api/test/plan', { data: { planId: 'pro' }, headers: { authorization: 'Bearer x' } })).status()).toBe(404);
  expect((await request.get('/api/test/inbox')).status()).toBe(404);
});

test('PROD-2 signed-out pages load without console errors: login, signup, upgrade, legal', async ({ page }) => {
  const errs = watchErrors(page);
  for (const path of ['/login', '/signup', '/upgrade', ...LEGAL]) {
    const r = await page.goto(path);
    expect(r?.status(), path).toBe(200);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  }
  // App routes bounce to login.
  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login\?redirect=/);
  errs.assertClean();
});

test('PROD-3 legal pages are full static HTML; robots and sitemap; www → apex 301', async ({ request }) => {
  for (const p of LEGAL) {
    const r = await request.get(p);
    expect(r.status(), p).toBe(200);
    const text = (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text.length, `${p}: static text`).toBeGreaterThan(2000);
  }
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/Sitemap:\s*https:\/\/rolling\.actor\/sitemap\.xml/);
  const sm = await request.get('/sitemap.xml');
  expect(sm.status()).toBe(200);
  expect(await sm.text()).toContain('https://rolling.actor/privacy</loc>');
  const www = await request.get('https://www.rolling.actor/terms?x=1', { maxRedirects: 0 });
  expect(www.status()).toBe(301);
  expect(www.headers()['location']).toBe('https://rolling.actor/terms?x=1');
});

test('PROD-4 auth providers and plans are public; paid features answer cleanly while unconfigured', async ({ request }) => {
  const p = (await (await request.get('/api/auth/providers')).json()) as { emailCode: boolean; google: unknown };
  expect(p.emailCode).toBe(true);
  expect(p.google).toBeTruthy();
  const plans = await request.get('/api/billing/plans');
  expect(plans.status()).toBe(200);
  expect(((await plans.json()) as { current: unknown }).current).toBeNull();
  expect((await request.get('/api/me')).status()).toBe(401);
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
});

test('PROD-5 admin grant is locked: 401 without the owner token (wrong or missing), never a grant', async ({ request }) => {
  await checkAdminGrantLocked(request, 401);
});

test('PROD-6 platform: Server-Timing and D1 bookmarks on API responses; Workers static assets with Early Hints', async ({ request }) => {
  await checkReplicaHeaders(request);
  await checkStaticAssets(request);
});
