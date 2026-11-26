import { expect, test } from '@playwright/test';
import { account, api, env, getJson } from './support';

/** Matrix: MEDIA-1 … MEDIA-3 (D-008, D-015): media is served from media hosts, never streamed through /api in production config. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d4b0b4f20000000049454e44ae426082', 'hex');

test('MEDIA-1 public library and template images come from the public media host, not /api', async ({ context, baseURL }) => {
  await account(context, baseURL, 'pubmedia');
  const req = context.request;
  const pub = await getJson<{ items: Array<{ url: string; thumbUrl: string }> }>(req, '/api/assets?scope=public&first=5');
  for (const it of pub.items) {
    const u = new URL(it.url, baseURL);
    expect(u.pathname.startsWith('/api/'), `${u.href}`).toBe(false);
    expect(u.host).toMatch(/^media(-staging)?\.rolling\.actor$/);
    const r = await req.get(u.href);
    expect(r.status()).toBe(200);
    expect(r.headers()['cache-control'] ?? '').toMatch(/max-age=\d{5,}|immutable/);
  }
  const t = await getJson<{ items: Array<{ coverUrl: string | null }> }>(req, '/api/templates');
  for (const c of t.items.map((x) => x.coverUrl).filter(Boolean) as string[]) {
    expect(new URL(c, baseURL).pathname.startsWith('/api/'), c).toBe(false);
  }
});

test('MEDIA-2 private media: signed URLs on the private media host; tampered or expired signatures are refused; Range works', async ({ context, baseURL }) => {
  await account(context, baseURL, 'privmedia');
  const req = context.request;
  const up = (await (await api(req, baseURL, 'POST', '/api/assets/uploads', { filename: 'p.png', contentType: 'image/png', size: PNG.length })).json()) as { assetId: string };
  const urls = (await (await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/part-urls`, { partNumbers: [1] })).json()) as { urls: Array<{ url: string }> };
  expect((await req.fetch(urls.urls[0]!.url, { method: 'PUT', data: PNG })).status()).toBe(200);
  expect((await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/complete`)).status()).toBe(200);
  const { asset } = await getJson<{ asset: { url: string } }>(req, `/api/assets/${up.assetId}`);
  const u = new URL(asset.url, baseURL);
  expect(u.pathname.startsWith('/api/'), u.href).toBe(false);
  expect(u.host).toMatch(/^cdn-private(-staging)?\.rolling\.actor$/);
  expect(u.searchParams.get('sig')).toBeTruthy();
  const ok = await req.get(u.href, { headers: { cookie: '' } });
  expect(ok.status()).toBe(200);
  const ranged = await req.get(u.href, { headers: { range: 'bytes=0-7' } });
  expect(ranged.status()).toBe(206);
  const bad = new URL(u.href);
  bad.searchParams.set('sig', `${u.searchParams.get('sig')!.slice(0, -2)}AA`);
  expect([401, 403]).toContain((await req.get(bad.href)).status());
  const expired = new URL(u.href);
  expired.searchParams.set('exp', '1000');
  expect([401, 403, 410]).toContain((await req.get(expired.href)).status());
  // The convenience route only redirects; it never carries bytes.
  const conv = await req.get(`/api/media/private/${up.assetId}`, { maxRedirects: 0 });
  expect(conv.status()).toBe(302);
});

test('MEDIA-3 a page’s <img>/<video> sources are on media hosts (no /api/media in the DOM)', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'dommedia');
  const seen: string[] = [];
  page.on('request', (r) => {
    if (['image', 'media'].includes(r.resourceType())) seen.push(r.url());
  });
  for (const path of ['/', '/templates', '/assets/public']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  }
  const viaApi = seen.filter((u) => new URL(u).pathname.startsWith('/api/media/'));
  expect(viaApi, 'images streamed through /api').toEqual([]);
});
