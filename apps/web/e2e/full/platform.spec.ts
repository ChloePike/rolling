import { expect, test } from '@playwright/test';
import { checkAdminGrantLocked, checkReplicaHeaders, checkStaticAssets } from './platform-checks';
import { account, api, env, getJson } from './support';

/** Matrix: PLAT-1 … PLAT-4 (D1 read replicas and bookmarks, admin grant route, Workers static assets). */

test('PLAT-1 D1 replicas: Server-Timing and x-d1-bookmark on API responses; bookmarks go back and junk is ignored', async ({ request }) => {
  await checkReplicaHeaders(request);
});

test('PLAT-2 read-your-writes: a write returns a bookmark; a read that sends it sees the write', async ({ context, baseURL }) => {
  test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');
  await account(context, baseURL, 'bookmark');
  const req = context.request;
  const bio = `Bookmark check ${Date.now()}`;
  const w = await api(req, baseURL, 'PATCH', '/api/me/profile', { bio });
  expect(w.status(), await w.text()).toBe(200);
  const bm = w.headers()['x-d1-bookmark'];
  expect(bm, 'a mutation hands back the session bookmark').toBeTruthy();
  // The bookmark cookie (rolling.d1b) also carries it for clients that drop the header.
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === 'rolling.d1b'), 'rolling.d1b cookie after a write').toBe(true);
  const r = await req.get('/api/me', { headers: { 'x-d1-bookmark': bm! } });
  expect(r.status()).toBe(200);
  const me = (await r.json()) as { user: { bio?: string | null } };
  expect(me.user.bio).toBe(bio);
  expect((await getJson<{ user: { bio?: string | null } }>(req, '/api/me')).user.bio).toBe(bio);
});

test('PLAT-3 admin grant: staging has no ADMIN_TOKEN, so the route is 404 with or without a token', async ({ request }) => {
  await checkAdminGrantLocked(request, 404);
});

test('PLAT-4 Workers static assets: immutable hashed files, revalidated shell, sw.js no-cache, Early Hints preloads, SPA fallback', async ({ request }) => {
  await checkStaticAssets(request);
});
