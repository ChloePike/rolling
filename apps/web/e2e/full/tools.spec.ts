import { expect, test } from '@playwright/test';
import { account, api, env, getJson, logSpend, shot, waitRun, watchErrors } from './support';

/** Matrix: TOOL-1 … TOOL-5. Nothing spends except TOOL-5 (PW_GENERATE: one Character, cheapest image model). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

test('TOOL-1 Quick Create: composer, cost, Generate asks to confirm when over the threshold and Cancel spends nothing', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'quick', 'plus');
  const errs = watchErrors(page);
  await page.goto('/create/quick');
  await expect(page.getByTestId('tool-composer')).toBeVisible();
  await page.getByTestId('tool-composer').getByRole('textbox').first().fill('A bottle on a rock, slow push-in');
  // HO §4 “Quotes everywhere”: every prompt box shows its cost before running.
  await expect(page.getByTestId('tool-composer')).toContainText(/\d+\s+credits/, { timeout: 20_000 });
  // Default Quick Create costs less than the 300-credit threshold and would start straight away (by design):
  // lower the threshold so Generate has to ask first.
  expect((await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { confirmThreshold: 1 })).status()).toBe(200);
  await page.reload();
  await page.getByTestId('tool-composer').getByRole('textbox').first().fill('A bottle on a rock, slow push-in');
  await page.getByRole('button', { name: /Generate video|^Generate$|Send|Start/ }).last().click();
  const confirm = page.getByRole('dialog', { name: 'Confirm', exact: true });
  const paywall = page.getByRole('dialog').filter({ hasText: /Not enough credits|Pick a plan/ });
  await expect(confirm.or(paywall).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'quick-confirm');
  await page.keyboard.press('Escape');
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
  errs.assertClean();
});

test('TOOL-2 Remix: without a reference video the run is blocked with a reason (quote) and the UI asks for the video', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'remix', 'plus');
  const q = (await (await api(page.request, baseURL, 'POST', '/api/runs/quote', { promptSpec: { kind: 'remix', prompt: 'Same moves, new outfit' } })).json()) as { quoteId: string | null; items: Array<{ action: string; code?: string }> };
  expect(q.quoteId).toBeNull();
  expect(q.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input' });
  await page.goto('/create/remix');
  // Default Quick Create costs less than the 300-credit threshold and would start straight away (by design):
  // lower the threshold so Generate has to ask first.
  expect((await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { confirmThreshold: 1 })).status()).toBe(200);
  await page.reload();
  await page.getByTestId('tool-composer').getByRole('textbox').first().fill('A bottle on a rock, slow push-in');
  await page.getByRole('button', { name: /Generate video|^Generate$|Send|Start/ }).last().click();
  await expect(page.getByText(/Upload the video|reference video/i).first()).toBeVisible();
  await shot(page, testInfo, 'remix-needs-video');
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
});

test('TOOL-3 Avatar: TTS provider undecided → the designed unavailable state; quotes ask for an uploaded voice track', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'avatar', 'plus');
  const q = (await (await api(page.request, baseURL, 'POST', '/api/runs/quote', { promptSpec: { kind: 'avatar', prompt: 'Hello and welcome' } })).json()) as { items: Array<{ action: string; code?: string; reason?: string }> };
  expect(q.items[0]!.action).toBe('blocked');
  expect(q.items[0]!.code).toBe('missing_input');
  await page.goto('/create/avatar');
  await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Upload a voice track/ })).toBeVisible();
  // No built-in TTS voices are offered as if they worked.
  const voices = await getJson<{ items: Array<{ kind: string; status: string }> }>(page.request, '/api/voices');
  for (const v of voices.items.filter((x) => x.kind === 'builtin')) expect(v.status, 'built-in voices are marked unavailable until a TTS provider exists').not.toBe('ready');
  await page.getByRole('button', { name: 'Write script' }).click();
  await expect(page.getByText(/Upload a voice track|voice track|not available|coming soon/i).first()).toBeVisible();
  await shot(page, testInfo, 'avatar-unavailable');
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
});

test('TOOL-4 Characters page: options, views and the cost line', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'charui', 'plus');
  await page.goto('/create/character');
  await expect(page.getByRole('button', { name: /Generate 2 views/ })).toBeVisible();
  await page.getByRole('button', { name: 'Anime' }).first().click();
  await expect(page.getByRole('button', { name: 'Anime' }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-composer')).toContainText(/\d+\s+credits/, { timeout: 20_000 });
  await shot(page, testInfo, 'character');
});

test.describe('character generation (PW_GENERATE=1)', () => {
  test.skip(!env.generate, 'spends a few credits');
  test('TOOL-5 Character run makes body + face and saves to Characters', async ({ context, baseURL }, testInfo) => {
    test.setTimeout(8 * 60_000);
    await account(context, baseURL, 'chargen', 'plus');
    const req = context.request;
    const q = (await (await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: { kind: 'character', model: 'bytedance/seedream-5.0-flash', name: 'Full test hero', prompt: 'A friendly adult barista with short hair, photoreal' } })).json()) as { quoteId: string; total: number; items: Array<{ ref: string; dependsOn: string[] }> };
    expect(q.items.map((i) => i.ref)).toEqual(['body', 'face']);
    expect(q.items[1]!.dependsOn).toEqual(['body']);
    const s = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId });
    expect(s.status(), await s.text()).toBe(201);
    const run = await waitRun(req, ((await s.json()) as { runId: string }).runId, 6 * 60_000);
    logSpend(testInfo, { runId: run.id, model: 'bytedance/seedream-5.0-flash', credits: run.spent, refunded: run.refunded, note: 'character' });
    expect(run.status).toBe('done');
    const chars = await getJson<{ items: Array<{ name: string; versions: unknown[] }> }>(req, '/api/characters');
    expect(chars.items.find((c) => c.name === 'Full test hero')).toBeTruthy();
  });
});
