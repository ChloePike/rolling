import { expect, test, type APIRequestContext } from '@playwright/test';
import { account, api, balance, env, getJson, logSpend, shot, waitRun, watchErrors, type RunView } from './support';

/**
 * Matrix: MAT-1 … MAT-6 (D-005 amendments: mature auto-routing for mature-allowed callers, hard limits incl.
 * ANIMAL_SEXUAL, the mature text-to-video keyframe chain, poster frames from clips, the mature public library).
 *
 * Content rules for this file: only mildly explicit prompts about fictional adults. Hard limits are only ever
 * checked at quote time (the deterministic rules refuse them before anything is held), so no generation is ever
 * started for them. Real generations (PW_GENERATE=1) use the cheapest mature models with Enhance prompt off.
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

/** Mildly explicit, fictional adult; matches the deterministic explicit terms (“fully nude”). */
const MILD = 'A fully nude fictional adult woman reclining on a sofa, tasteful artistic photo, soft window light';
const MILD_VIDEO = 'A fully nude fictional adult woman stretching slowly by a window, tasteful, soft morning light';

interface QuoteItem { ref: string; action: string; code?: string; reason?: string; matureAccess?: string; model: string | null; credits: number; step?: 'keyframe' | 'animate'; dependsOn?: string[]; kind?: string }
interface Quote { quoteId: string | null; total: number; items: QuoteItem[] }

async function quote(req: APIRequestContext, baseURL: string | undefined, spec: Record<string, unknown>): Promise<Quote> {
  const r = await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: spec });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Quote;
}

async function matureModels(req: APIRequestContext) {
  const { models } = await getJson<{ models: Array<{ id: string; kind: string; mature: boolean; matureOnly?: boolean }> }>(req, '/api/models');
  return models;
}

async function turnMatureOn(req: APIRequestContext, baseURL: string | undefined) {
  const on = await api(req, baseURL, 'PATCH', '/api/me/prefs', { matureContent: true });
  expect(on.status(), await on.text()).toBe(200);
  expect(((await on.json()) as { matureAllowed: boolean }).matureAllowed).toBe(true);
}

test('MAT-1 access per caller: an explicit prompt gets MATURE_REQUIRED with copy for the caller’s situation; a mature-allowed caller is routed to a mature model automatically (no toggle)', async ({ browser, baseURL }) => {
  const spec = { kind: 'image', model: 'auto', prompt: MILD, promptExpand: false };
  // Non-member: “needs a paid plan” (the UI opens the upgrade modal with reason mature).
  const free = await browser.newContext({ baseURL });
  await account(free, baseURL, 'matnoplan');
  const q0 = (await quote(free.request, baseURL, spec)).items[0]!;
  expect(q0).toMatchObject({ action: 'blocked', code: 'MATURE_REQUIRED', matureAccess: 'no_plan' });
  expect(q0.reason).toBe('Mature content needs a paid plan. Join a plan to generate this, or change the prompt.');
  await free.close();
  // Member with the preference off: “turn it on in Settings”.
  const off = await browser.newContext({ baseURL });
  await account(off, baseURL, 'matprefoff', 'plus');
  const q1 = (await quote(off.request, baseURL, spec)).items[0]!;
  expect(q1).toMatchObject({ action: 'blocked', code: 'MATURE_REQUIRED', matureAccess: 'preference_off' });
  expect(q1.reason).toBe('Turn on mature content in Settings to generate this, or change the prompt.');
  // Same member with it on: never “turn it on”; planned as a mature run on a model that takes mature content,
  // including when the request names a model that does not (it falls back within the hold).
  await turnMatureOn(off.request, baseURL);
  const catalog = await matureModels(off.request);
  const capable = new Set(catalog.filter((m) => m.mature || m.matureOnly).map((m) => m.id));
  expect(capable.size, 'mature-capable models are listed for an allowed caller').toBeGreaterThan(0);
  for (const model of ['auto', 'bytedance/seedream-5.0-flash']) {
    const q = await quote(off.request, baseURL, { ...spec, model });
    expect(q.items[0]!.action, `${model}: ${JSON.stringify(q.items[0])}`).toBe('run');
    expect(capable.has(q.items[0]!.model!), `${model} → ${q.items[0]!.model} takes mature content`).toBe(true);
    expect(q.quoteId).toBeTruthy();
  }
  // A benign prompt from the same caller stays on its own model.
  const benign = await quote(off.request, baseURL, { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A cat asleep on a sofa', promptExpand: false });
  expect(benign.items[0]).toMatchObject({ action: 'run', model: 'bytedance/seedream-5.0-flash' });
  await off.close();
});

test('MAT-2 hard limits block a mature-allowed caller at quote time (minors, animals: ANIMAL_SEXUAL), for images and videos; nothing is held', async ({ context, baseURL }) => {
  await account(context, baseURL, 'mathard', 'plus');
  const req = context.request;
  await turnMatureOn(req, baseURL);
  const before = await balance(req);
  // Quote-time refusals only (deterministic rules); no run is ever started with these prompts.
  const cases = [
    { name: 'minor', prompt: 'nude 15 year old girl' },
    { name: 'animal (strong term)', prompt: 'bestiality' },
    { name: 'animal (act directed at an animal)', prompt: 'sex with a dog' },
  ];
  for (const c of cases) {
    for (const spec of [
      { kind: 'image', model: 'auto', prompt: c.prompt, promptExpand: false },
      { kind: 'video', model: 'x-ai/grok-imagine-video-1.5-lite', prompt: c.prompt, resolution: '480p', seconds: 1, ratio: '9:16', promptExpand: false },
    ]) {
      const q = await quote(req, baseURL, spec);
      expect(q.quoteId, `${c.name} / ${spec.kind}: no quote to start`).toBeNull();
      expect(q.items.some((i) => i.action === 'blocked' && i.code === 'SAFETY_BLOCKED'), `${c.name} / ${spec.kind}: ${JSON.stringify(q.items)}`).toBe(true);
      expect(q.total).toBe(0);
    }
  }
  // An animal in a non-sexual scene is fine; so is a pet next to adults in a non-sexual scene.
  const pet = await quote(req, baseURL, { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'An adult couple relaxing on a sofa with their dog, cozy evening', promptExpand: false });
  expect(pet.items[0]!.action).toBe('run');
  const after = await balance(req);
  expect(after).toEqual(before);
});

test('MAT-3 mature text-to-video is one quote with two steps: a keyframe on a mature picture model, then the animation on a spicy image-to-video model; non-mature text-to-video is unchanged', async ({ context, baseURL }) => {
  await account(context, baseURL, 'matchain', 'plus');
  const req = context.request;
  await turnMatureOn(req, baseURL);
  const capable = new Set((await matureModels(req)).filter((m) => m.mature || m.matureOnly).map((m) => m.id));
  const video = { kind: 'video', model: 'x-ai/grok-imagine-video-1.5-lite', prompt: MILD_VIDEO, resolution: '480p', seconds: 1, ratio: '9:16', promptExpand: false };
  const q = await quote(req, baseURL, video);
  expect(q.quoteId, JSON.stringify(q.items)).toBeTruthy();
  expect(q.items.map((i) => i.step)).toEqual(['keyframe', 'animate']);
  const [key, anim] = q.items as [QuoteItem, QuoteItem];
  for (const i of q.items) {
    expect(i.action).toBe('run');
    expect(capable.has(i.model!), `${i.step} on ${i.model}`).toBe(true);
  }
  expect(anim.model).toMatch(/i2v-spicy/);
  expect(anim.dependsOn ?? []).toContain(key.ref);
  expect(q.total).toBe(key.credits + anim.credits);
  // Auto picks the chain only for mature text-only video.
  const auto = await quote(req, baseURL, { ...video, model: 'auto' });
  expect(auto.items.map((i) => i.step)).toEqual(['keyframe', 'animate']);
  const plain = await quote(req, baseURL, { ...video, prompt: 'Slow push-in on a glass bottle on a mossy rock at dawn' });
  expect(plain.items).toHaveLength(1);
  expect(plain.items[0]).toMatchObject({ action: 'run', model: 'x-ai/grok-imagine-video-1.5-lite' });
  expect(plain.items[0]!.step).toBeUndefined();
});

test('MAT-4 mature public library: allowed members get the mature items and counts (signed private URLs, Mature chip, no edge cache); everyone else gets exactly the general set', async ({ page, context, request, browser, baseURL }, testInfo) => {
  const CATS = '{ publicCategories { key count } }';
  const ITEMS = 'query($c: String) { publicItems(category: $c, first: 100) { edges { node { id mature thumbUrl } } } }';
  const gql = async (req: APIRequestContext, query: string, variables: Record<string, unknown> = {}) => {
    const r = await req.post('/api/graphql', { data: { query, variables } });
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { data: Record<string, unknown>; errors?: unknown };
    expect(body.errors).toBeUndefined();
    return { body: body.data, headers: r.headers() };
  };
  type Cat = { key: string; count: number };
  type Items = { publicItems: { edges: Array<{ node: { id: string; mature: boolean; thumbUrl: string } }> } };
  const total = (cs: Cat[]) => cs.reduce((s, c) => s + c.count, 0);
  const anon = (await gql(request, CATS)).body.publicCategories as Cat[];
  const anonPose = ((await gql(request, ITEMS, { c: 'pose' })).body as Items).publicItems.edges.map((e) => e.node);
  expect(anonPose.filter((n) => n.mature)).toEqual([]);

  // A member with the preference off: the general set, exactly.
  const off = await browser.newContext({ baseURL });
  await account(off, baseURL, 'matliboff', 'plus');
  expect((await gql(off.request, CATS)).body.publicCategories).toEqual(anon);
  await off.close();

  // Allowed: more items, mature ones flagged and signed from the private host; never the public edge cache.
  await account(context, baseURL, 'matlibon', 'plus');
  await turnMatureOn(context.request, baseURL);
  const on = await gql(context.request, CATS);
  expect(on.headers['cache-control']).toMatch(/private|no-store/);
  expect(on.headers['x-edge-cache'] ?? 'BYPASS').toBe('BYPASS');
  const onCats = on.body.publicCategories as Cat[];
  expect(total(onCats)).toBeGreaterThan(total(anon));
  const pose = ((await gql(context.request, ITEMS, { c: 'pose' })).body as Items).publicItems.edges.map((e) => e.node);
  const mature = pose.filter((n) => n.mature);
  expect(mature.length).toBeGreaterThan(0);
  for (const m of mature.slice(0, 5)) {
    const u = new URL(m.thumbUrl);
    expect(u.hostname, m.id).toMatch(/^cdn-private/);
    expect(u.searchParams.get('sig')).toBeTruthy();
    expect((await request.get(m.thumbUrl)).status(), `${m.id} loads from its signed URL`).toBe(200);
  }
  // The signature is the key: the same object from the public host is not served.
  const sample = new URL(mature[0]!.thumbUrl);
  const unsigned = await request.get(`${sample.origin}${sample.pathname}`);
  expect([403, 404]).toContain(unsigned.status());
  // Signed out, the same request still gets the general set (the allowed caller's answer was not cached).
  expect((await gql(request, CATS)).body.publicCategories).toEqual(anon);

  // UI: the Mature chip on cards for the allowed member; images load.
  const errs = watchErrors(page);
  await page.goto('/assets/public?cat=pose');
  const chip = page.locator('[data-item] [data-mature]').first();
  await expect(chip).toHaveText('Mature', { timeout: 30_000 });
  // The mature card's picture loads from its signed URL (not a placeholder).
  const img = page.locator('[data-item]').filter({ has: page.locator('[data-mature]') }).first().locator('img');
  await expect(img).toHaveAttribute('src', /cdn-private.*sig=/);
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await shot(page, testInfo, 'mature-library');
  errs.assertClean();
});

test('MAT-5 CharaDB import: hairstyles (and CharaDB anime outfits) are listed with CharaDB attribution, CC0, and images on the public media host', async ({ request }) => {
  const r = await request.post('/api/graphql', {
    data: { query: '{ publicCategories { key count } publicItems(category: "hairstyle", first: 24) { edges { node { id title license attribution { name url } thumbUrl angles { url } mature } } } }' },
  });
  const data = ((await r.json()) as { data: { publicCategories: Array<{ key: string; count: number }>; publicItems: { edges: Array<{ node: { id: string; license: string; attribution: { name: string; url: string | null }; thumbUrl: string; angles: Array<{ url: string }>; mature: boolean } }> } } }).data;
  expect(data.publicCategories.find((c) => c.key === 'hairstyle')?.count).toBeGreaterThanOrEqual(100);
  const items = data.publicItems.edges.map((e) => e.node);
  expect(items.length).toBe(24);
  for (const i of items) {
    expect(i.license).toBe('CC0');
    expect(i.attribution.name).toBe('CharaDB');
    expect(i.mature).toBe(false);
    expect(new URL(i.thumbUrl).hostname).toMatch(/^media(-staging)?\.rolling\.actor$/);
  }
  for (const u of [items[0]!.thumbUrl, ...items[0]!.angles.map((a) => a.url)].slice(0, 4)) {
    const img = await request.get(u);
    expect(img.status(), u).toBe(200);
    expect(img.headers()['content-type']).toMatch(/^image\//);
  }
  const anime = await request.post('/api/graphql', { data: { query: '{ publicItems(category: "outfit_anime", q: "charadb", first: 5) { edges { node { id attribution { name } } } } }' } });
  test.info().annotations.push({ type: 'charadb-anime', description: (await anime.text()).slice(0, 300) });
});

test.describe('real mature generation (PW_GENERATE=1)', () => {
  test.skip(!env.generate, 'Set PW_GENERATE=1 to spend real (cheap) credits on staging');

  test('MAT-6 mature chain run: keyframe then animation, held once and settled per step; the clip gets a poster from its own frames; the outputs are mature and blurred off public surfaces', async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(15 * 60_000);
    await account(context, baseURL, 'matrun', 'plus');
    const req = context.request;
    await turnMatureOn(req, baseURL);
    const before = await balance(req);
    const q = await quote(req, baseURL, { kind: 'video', model: 'x-ai/grok-imagine-video-1.5-lite', prompt: MILD_VIDEO, resolution: '480p', seconds: 1, ratio: '9:16', promptExpand: false });
    expect(q.items.map((i) => i.step)).toEqual(['keyframe', 'animate']);
    expect(q.total, 'budget: a mature chain under 60 credits').toBeLessThan(60);
    const s = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId });
    expect(s.status(), await s.text()).toBe(201);
    const runId = ((await s.json()) as { runId: string }).runId;
    const run = await waitRun(req, runId, 12 * 60_000);
    logSpend(testInfo, { runId, model: q.items.map((i) => i.model).join(' → '), credits: run.spent, refunded: run.refunded, note: 'mature chain' });
    expect(run.status, JSON.stringify(run.items)).toBe('done');
    expect(run.spent).toBeLessThanOrEqual(q.total);
    const after = await balance(req);
    expect(after.held).toBe(0);
    expect(before.plan + before.purchased - (after.plan + after.purchased)).toBe(run.spent);
    // Two items, both kept: the keyframe is a visible result of its own.
    const assets = run.items.map((i) => i.assetId).filter(Boolean) as string[];
    expect(assets.length, JSON.stringify(run.items)).toBe(2);
    type Asset = { id: string; kind: string; mature: boolean; url: string | null; meta?: Record<string, unknown> };
    const got = await Promise.all(assets.map(async (id) => (await getJson<{ asset: Asset }>(req, `/api/assets/${id}`)).asset));
    const clip = got.find((a) => a.kind === 'video')!;
    expect(clip, JSON.stringify(got)).toBeTruthy();
    for (const a of got) expect(a.mature, `${a.id} is mature`).toBe(true);
    // Poster from the clip's own frames (the spicy models return no poster).
    const poster = await req.get(`/api/media/private/${clip.id}?variant=poster`, { maxRedirects: 0 });
    expect([301, 302, 303, 307]).toContain(poster.status());
    const img = await req.get(poster.headers()['location']!);
    expect(img.status()).toBe(200);
    expect(img.headers()['content-type']).toMatch(/^image\//);
    testInfo.annotations.push({ type: 'poster', description: JSON.stringify({ posterSource: clip.meta?.posterSource, thumbKey: clip.meta?.thumbKey, rating: clip.meta?.rating }) });
    // Activity shows the run with its poster; mature thumbnails are blurred until clicked.
    await page.goto('/activity');
    await expect(page.getByRole('main')).toContainText(/fully nude|stretching/i, { timeout: 30_000 });
    await shot(page, testInfo, 'mature-activity');
    const r = (await getJson<{ run: RunView & { surface?: string } }>(req, `/api/runs/${runId}`)).run;
    expect(r.items.map((i) => i.status)).toEqual(['succeeded', 'succeeded']);
  });
});
