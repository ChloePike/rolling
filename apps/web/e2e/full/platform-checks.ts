import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Platform checks shared by the staging suite (platform.spec.ts) and the production smoke (prod.spec.ts):
 * D1 read replicas (Server-Timing, `x-d1-bookmark`), the admin grant route and Workers static assets.
 * Read-only: nothing here writes data.
 */
const BOOKMARK = /^[0-9a-f]{1,32}(-[0-9a-f]{1,64}){1,7}$/i;

/** PLAT-1: every API response says how long D1 took and hands back a session bookmark. */
export async function checkReplicaHeaders(request: APIRequestContext) {
  const h = await request.get('/api/health?timing=1');
  expect(h.status()).toBe(200);
  const health = (await h.json()) as { d1?: { ms: number; region: string; primary: boolean; start: string }; r2?: { ms: number }; colo?: string };
  expect(health.d1, 'health?timing=1 reports D1').toBeTruthy();
  expect(typeof health.d1!.ms).toBe('number');
  expect(health.d1!.region).toBeTruthy();
  expect(typeof health.d1!.primary).toBe('boolean');
  expect(health.colo).toBeTruthy();

  const r = await request.get('/api/models');
  expect(r.status()).toBe(200);
  const timing = r.headers()['server-timing'] ?? '';
  expect(timing, 'Server-Timing on API responses').toMatch(/(^|,\s*)d1;dur=\d+/);
  expect(timing).toMatch(/total;dur=\d+/);
  const bookmark = r.headers()['x-d1-bookmark'] ?? '';
  expect(bookmark, 'x-d1-bookmark on API responses').toMatch(BOOKMARK);

  // The client sends the newest bookmark back: the session starts there and never hands back an older one.
  const again = await request.get('/api/models', { headers: { 'x-d1-bookmark': bookmark } });
  expect(again.status()).toBe(200);
  const next = again.headers()['x-d1-bookmark'] ?? '';
  expect(next).toMatch(BOOKMARK);
  expect(next >= bookmark, `bookmark ${next} is not older than ${bookmark}`).toBe(true);

  // Garbage bookmarks are ignored (never passed to D1), not a 5xx.
  for (const junk of ['not-a-bookmark', "'; drop table users; --", 'f'.repeat(300)]) {
    const bad = await request.get('/api/models', { headers: { 'x-d1-bookmark': junk } });
    expect(bad.status(), `bookmark ${junk.slice(0, 20)}`).toBe(200);
  }
}

/** PLAT-3: the admin grant route answers 404 (no ADMIN_TOKEN on this env) or 401 (wrong / no token); never grants. */
export async function checkAdminGrantLocked(request: APIRequestContext, expected: 404 | 401) {
  const body = { email: 'nobody@rolling.test', planId: 'pro', months: 1 };
  const none = await request.post('/api/admin/grant', { data: body });
  expect(none.status(), 'no token').toBe(expected);
  const wrong = await request.post('/api/admin/grant', { data: body, headers: { authorization: 'Bearer definitely-not-the-admin-token' } });
  expect(wrong.status(), 'wrong token').toBe(expected);
  const code = ((await wrong.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
  expect(code).toBe(expected === 404 ? 'NOT_FOUND' : 'UNAUTHENTICATED');
  // Other methods do not exist.
  expect((await request.get('/api/admin/grant')).status()).toBe(404);
}

/** PLAT-4: the SPA is Workers static assets: hashed files immutable, the shell revalidated, sw.js never cached, Early Hints. */
export async function checkStaticAssets(request: APIRequestContext) {
  const shell = await request.get('/');
  expect(shell.status()).toBe(200);
  expect(shell.headers()['content-type']).toContain('text/html');
  const html = await shell.text();
  const cc = shell.headers()['cache-control'] ?? '';
  expect(cc, 'the app shell is revalidated').toMatch(/no-cache|max-age=0/);
  const link = shell.headers()['link'] ?? '';
  const entry = html.match(/<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1];
  const css = html.match(/<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+\.css)"/)?.[1];
  expect(entry, 'entry module in index.html').toBeTruthy();
  expect(link, 'Link preloads for Early Hints').toContain(entry!);
  if (css) expect(link).toContain(css);
  expect(link).toMatch(/\.woff2>; rel=preload; as=font/);

  const js = await request.get(entry!);
  expect(js.status()).toBe(200);
  expect(js.headers()['cache-control']).toMatch(/max-age=31536000.*immutable|immutable.*max-age=31536000/);

  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toMatch(/no-cache/);
  expect(sw.headers()['service-worker-allowed']).toBe('/');

  // SPA fallback: a deep app route gets the shell; the prerendered legal pages carry no app preloads.
  const deep = await request.get('/settings/account');
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toContain(entry!);
  const legal = await request.get('/privacy');
  expect(legal.status()).toBe(200);
  expect(legal.headers()['link'] ?? '', 'legal pages detach the app preloads').not.toContain(entry!);
}
