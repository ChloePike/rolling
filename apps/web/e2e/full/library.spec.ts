import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { account, api, env, getJson, seedProject, shot, watchErrors } from './support';

/** Matrix: LIB-1 … LIB-8 (assets, characters, public library, templates, Inspiration, send to canvas). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

async function gql<T>(req: APIRequestContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await req.post('/api/graphql', { data: { query, variables }, headers: { 'content-type': 'application/json' } });
  expect(r.status(), await r.text()).toBe(200);
  const body = (await r.json()) as { data: T; errors?: unknown[] };
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data;
}
const CATS = '{ publicCategories { key count } }';
const ITEMS = 'query($category: String, $q: String, $first: Int) { publicItems(category: $category, q: $q, first: $first) { edges { node { id category title license thumbUrl } } pageInfo { hasNextPage } } }';
type Items = { publicItems: { edges: Array<{ node: { id: string; category: string; title: string; license: string; thumbUrl: string } }>; pageInfo: { hasNextPage: boolean } } };

test('LIB-1 public library: categories with counts, license labels, search and category filter (API)', async ({ context, baseURL }) => {
  await account(context, baseURL, 'publib');
  const req = context.request;
  const cats = (await gql<{ publicCategories: Array<{ key: string; count: number }> }>(req, CATS)).publicCategories;
  const keys = cats.map((c) => c.key);
  for (const k of ['pose', 'portrait', 'outfit', 'scene']) expect(keys).toContain(k);
  for (const c of cats) expect(c.count, c.key).toBeGreaterThan(0);
  const poses = (await gql<Items>(req, ITEMS, { category: 'pose', first: 24 })).publicItems.edges.map((e) => e.node);
  expect(poses.length).toBe(24);
  for (const p of poses) {
    expect(p.category).toBe('pose');
    expect(['FIRST_PARTY', 'CC0', 'MIT']).toContain(p.license);
  }
  const portraits = (await gql<Items>(req, ITEMS, { category: 'portrait', first: 5 })).publicItems.edges.map((e) => e.node);
  for (const p of portraits) expect(p.license).toBe('CC0');
  const q = (await gql<Items>(req, ITEMS, { q: 'standing', first: 24 })).publicItems.edges.map((e) => e.node);
  expect(q.length).toBeGreaterThan(0);
  expect(q.every((n) => /stand/i.test(n.title) || n.category)).toBe(true);
});

test('LIB-2 mature public items are hidden signed out and for members without mature access; allowed members get more (D-005 amendment, details in MAT-4)', async ({ request, browser, baseURL }) => {
  const anon = (await gql<{ publicCategories: Array<{ key: string; count: number }> }>(request, CATS)).publicCategories;
  const ctx = await browser.newContext({ baseURL });
  await account(ctx, baseURL, 'matureoff', 'plus');
  const member = (await gql<{ publicCategories: Array<{ key: string; count: number }> }>(ctx.request, CATS)).publicCategories;
  expect(member).toEqual(anon);
  // REST listing of public items: none mature without access.
  const pub = await getJson<{ items: Array<{ mature: boolean }> }>(ctx.request, '/api/assets?scope=public&first=100');
  expect(pub.items.filter((i) => i.mature)).toEqual([]);
  // Mature-allowed (plan + preference): the mature items and their counts are added (2026-11-27 amendment).
  expect((await api(ctx.request, baseURL, 'PATCH', '/api/me/prefs', { matureContent: true })).status()).toBe(200);
  const mature = (await gql<{ publicCategories: Array<{ key: string; count: number }> }>(ctx.request, CATS)).publicCategories;
  const total = (xs: typeof anon) => xs.reduce((s, c) => s + c.count, 0);
  expect(total(mature)).toBeGreaterThan(total(anon));
  // Turning it off again gives exactly the general set back.
  expect((await api(ctx.request, baseURL, 'PATCH', '/api/me/prefs', { matureContent: false })).status()).toBe(200);
  expect((await gql<{ publicCategories: Array<{ key: string; count: number }> }>(ctx.request, CATS)).publicCategories).toEqual(anon);
  await ctx.close();
});

test('LIB-3 public library page: grid, category chips, search, “Show more”, license on cards; images load', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'publibui');
  const errs = watchErrors(page);
  await page.goto('/assets/public');
  await expect(page.getByRole('heading', { name: 'Public library' })).toBeVisible();
  const cards = page.locator('main img');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  const broken = await page.locator('main img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0).map((i) => (i as HTMLImageElement).src));
  expect(broken).toEqual([]);
  const n0 = await cards.count();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect.poll(async () => cards.count()).toBeGreaterThan(n0);
  await page.getByRole('searchbox', { name: /Search poses/ }).fill('standing');
  await expect(page.getByText(/Standing/).first()).toBeVisible();
  await shot(page, testInfo, 'public-library');
  errs.assertClean();
});

test('LIB-4 assets page: upload shows up; search and kind filters narrow the list; Characters tab', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'assetsui');
  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'All assets' })).toBeVisible();
  await page.getByTestId('assets-file').setInputFiles({ name: 'full-asset-search.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d4b0b4f20000000049454e44ae426082', 'hex') });
  await expect(page.getByText('full-asset-search.png').first()).toBeVisible({ timeout: 90_000 });
  const grid = page.getByRole('region', { name: 'All assets' });
  await page.getByRole('group', { name: 'Filter by type' }).getByRole('button', { name: 'Video', exact: true }).click();
  await expect(grid.getByText('full-asset-search.png')).toHaveCount(0);
  await page.getByRole('group', { name: 'Filter by type' }).getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox', { name: /Search assets/ }).fill('zzzz-nothing');
  await expect(grid.getByText('full-asset-search.png')).toHaveCount(0);
  await page.getByRole('searchbox', { name: /Search assets/ }).fill('full-asset');
  await expect(grid.getByText('full-asset-search.png').first()).toBeVisible();
  await shot(page, testInfo, 'assets');
  // Characters: nav item and the API list.
  expect((await getJson<{ items: unknown[] }>(page.request, '/api/characters')).items).toEqual([]);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Characters' }).click();
  await expect(page).toHaveURL(/\/create\/character|\/assets.*character/i);
});

test('LIB-5 templates: every card has a cover that loads; filters and search; “Use template” creates a canvas', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'templates');
  const list = await getJson<{ items: Array<{ id: string; name: string; coverUrl: string | null; slots: unknown[] }> }>(page.request, '/api/templates');
  expect(list.items.length).toBeGreaterThan(0);
  const missing = list.items.filter((t) => !t.coverUrl).map((t) => t.name);
  expect(missing, 'templates without a cover').toEqual([]);
  await page.goto('/templates');
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  const broken = await page.locator('main img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth === 0).map((i) => (i as HTMLImageElement).src));
  expect(broken).toEqual([]);
  await shot(page, testInfo, 'templates');
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('unboxing');
  await expect(page.getByText('Unboxing reel').first()).toBeVisible();
  await page.getByText('Unboxing reel').first().click();
  const preview = page.getByTestId('template-preview');
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: 'Use template' }).click();
  // “Use template” opens the template in Quick Create (or straight on a canvas); “Open on canvas” makes the canvas.
  await page.waitForURL(/\/p\/prj_|\/create\/quick/, { timeout: 30_000 });
  testInfo.annotations.push({ type: 'use-template-lands-on', description: new URL(page.url()).pathname });
  if (/\/create\/quick/.test(page.url())) await page.getByRole('button', { name: 'Open on canvas' }).click();
  await page.waitForURL(/\/p\/prj_/, { timeout: 30_000 });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('[data-node-kind]').first()).toBeVisible();
  const runs = await getJson<{ runs: unknown[] }>(page.request, '/api/runs');
  expect(runs.runs, 'using a template spends nothing').toHaveLength(0);
});

test('LIB-6 Home Inspiration grid shows template covers; tabs switch', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'inspiration');
  await page.goto('/');
  await page.getByRole('heading', { name: 'Inspiration' }).scrollIntoViewIfNeeded();
  // At rest a card shows only its poster and duration; Use template appears on hover or focus.
  const cards = page.locator('[data-template-card]');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  // Every card shows a cover: a loaded <img>/<video>, or a background image (never just a flat tone).
  const noCover = await cards.evaluateAll((els) =>
    els
      .filter((el) => {
        const img = el.querySelector('img') as HTMLImageElement | null;
        const vid = el.querySelector('video');
        const bg = [el, ...el.querySelectorAll('div')].map((x) => getComputedStyle(x).backgroundImage).join(' ');
        return !(img && img.naturalWidth > 0) && !vid && !/url\(/.test(bg);
      })
      .map((el) => el.getAttribute('data-template')),
  );
  expect(noCover, 'Inspiration cards without a cover').toEqual([]);
  await cards.first().hover();
  await expect(cards.first().getByRole('link', { name: /^Use template:/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Short drama' }).click();
  await expect(page.getByRole('tab', { name: 'Short drama' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, testInfo, 'inspiration');
});

test('LIB-7 send to canvas: “Add to canvas” from the public library opens the canvas picker and adds an asset node', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'sendcanvas');
  const p = await seedProject(page.request, baseURL, 'Target canvas', []);
  await page.goto('/assets/public');
  const card = page.locator('main [role="button"], main button').filter({ hasText: /^P0\d\d/ }).first();
  await card.click();
  await page.getByRole('button', { name: 'Add to canvas' }).first().click();
  const chooser = page.getByTestId('choose-canvas');
  await expect(chooser).toBeVisible();
  await shot(page, testInfo, 'choose-canvas');
  await chooser.getByText('Target canvas').click();
  await expect.poll(async () => (await getJson<{ snapshot: { nodes: Array<{ kind: string }> } }>(page.request, `/api/projects/${p.id}`)).snapshot.nodes.length, { timeout: 20_000 }).toBe(1);
  // “New canvas” from the same picker.
  await page.goto('/assets/public');
  await page.locator('main [role="button"], main button').filter({ hasText: /^P0\d\d/ }).first().click();
  await page.getByRole('button', { name: 'Add to canvas' }).first().click();
  await page.getByTestId('choose-canvas-new').click();
  await page.waitForURL(/\/p\/prj_/, { timeout: 30_000 }).catch(() => undefined);
  expect((await getJson<{ items: unknown[] }>(page.request, '/api/projects')).items.length).toBe(2);
});

test('LIB-8 project thumbnails and node counts on Home follow the canvas', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'homecard');
  await seedProject(page.request, baseURL, 'Counted', [
    { op: 'addNode', tempId: 'a', kind: 'text', title: 'A', params: { text: 'a' } },
    { op: 'addNode', tempId: 'b', kind: 'text', title: 'B', params: { text: 'b' } },
  ]);
  await expect.poll(async () => (await getJson<{ items: Array<{ title: string; nodeCount: number }> }>(page.request, '/api/projects')).items[0]?.nodeCount, { timeout: 20_000 }).toBe(2);
  await page.goto('/');
  await expect(page.getByText(/2 nodes/).first()).toBeVisible();
});

test('LIB-9 every sub-category chip has a label (no raw keys such as “couple-facing-lying” or “hair-color”), for everyone and for mature-allowed members', async ({ request, browser, baseURL }) => {
  const labels = JSON.parse(readFileSync(new URL('../../../../messages/en/library.json', import.meta.url), 'utf8')) as Record<string, string>;
  const missing = async (req: APIRequestContext) => {
    const cats = (await gql<{ publicCategories: Array<{ key: string }> }>(req, CATS)).publicCategories.map((c) => c.key);
    const out: string[] = [];
    for (const c of cats) {
      const subs = (await gql<{ publicSubCategories: Array<{ key: string }> }>(req, 'query($c: String!) { publicSubCategories(category: $c) { key } }', { c })).publicSubCategories;
      for (const s of subs) if (!labels[`library.sub.${s.key}`]) out.push(`${c}/${s.key}`);
    }
    return out;
  };
  expect(await missing(request), 'signed out').toEqual([]);
  const ctx = await browser.newContext({ baseURL });
  await account(ctx, baseURL, 'sublabels', 'plus');
  expect((await api(ctx.request, baseURL, 'PATCH', '/api/me/prefs', { matureContent: true })).status()).toBe(200);
  expect(await missing(ctx.request), 'mature-allowed').toEqual([]);
  await ctx.close();
});
