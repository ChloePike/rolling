import { expect, test } from '@playwright/test';
import { account, api, env, getJson, openCanvas, seedProject, shot, watchErrors } from './support';

/**
 * Matrix: ENH-1 … ENH-3. Enhance prompt (D-020): Hyperouter prompt expansion, on by default for people,
 * priced in the quote, a per-run pill on Home, a switch in the tools, a pill on canvas nodes. Quotes only.
 * The spoken-line locale (follows the prompt, never the UI language) is only visible in the gateway request:
 * it is covered by `promptLocale` unit tests in packages/core, not here.
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const IMAGE = { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A glass bottle on a mossy rock at dawn' };
type Q = { quoteId: string | null; total: number; items: Array<{ action: string; credits: number; promptExpand?: boolean }> };

test('ENH-1 API: the preference defaults on; models list promptExpand; the quote prices the rewrite (“Includes prompt enhancement”) and follows the per-run choice, else the preference', async ({ context, baseURL }) => {
  await account(context, baseURL, 'enhapi', 'plus');
  const req = context.request;
  expect((await getJson<{ prefs: { enhancePrompt: boolean } }>(req, '/api/me')).prefs.enhancePrompt).toBe(true);
  const { models } = await getJson<{ models: Array<{ id: string; promptExpand: string | null }> }>(req, '/api/models');
  const flash = models.find((m) => m.id === IMAGE.model)!;
  expect(['available', 'unavailable']).toContain(flash.promptExpand);
  test.skip(flash.promptExpand !== 'available', 'the gateway refuses prompt expansion in this environment');
  const quote = async (extra: Record<string, unknown>) => (await (await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: { ...IMAGE, ...extra } })).json()) as Q;
  const byPref = await quote({});
  const on = await quote({ promptExpand: true });
  const off = await quote({ promptExpand: false });
  expect(byPref.items[0]!.promptExpand).toBe(true);
  expect(on.items[0]!.promptExpand).toBe(true);
  expect(off.items[0]!.promptExpand).toBeFalsy();
  expect(on.total).toBeGreaterThan(off.total);
  expect(on.total - off.total, 'the DeepSeek rewrite bound is about 1 credit').toBeLessThanOrEqual(3);
  // The preference off: quotes without a per-run choice follow it; a per-run “on” still wins.
  expect((await api(req, baseURL, 'PATCH', '/api/me/prefs', { enhancePrompt: false })).status()).toBe(200);
  expect((await quote({})).items[0]!.promptExpand).toBeFalsy();
  expect((await quote({ promptExpand: true })).items[0]!.promptExpand).toBe(true);
  // Only on creates: a model without prompt_expand never prices it.
  const lite = await quote({ model: 'x-ai/grok-imagine-image', promptExpand: true });
  expect(lite.items[0]!.promptExpand).toBeFalsy();
});

test('ENH-2 Home pill and Preferences: “Enhance prompt: on” by default, switching it off lowers the live cost; the Preferences switch sets the default and survives a reload', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'enhui', 'plus');
  const errs = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await page.getByRole('button', { name: /^Model:|Auto model/ }).first().click();
  await page.getByRole('dialog', { name: 'Choose model' }).getByText('Seedream 5.0 Flash', { exact: true }).first().click();
  await page.locator('#brief').fill(IMAGE.prompt);
  const pill = page.getByRole('button', { name: /^Enhance prompt: on/ });
  await expect(pill).toBeVisible();
  const cost = page.getByTestId('prompt-cost');
  await expect(cost).toContainText(/\d+ credits?/, { timeout: 20_000 });
  const onCredits = Number((await cost.innerText()).match(/(\d+) credits?/)![1]);
  await pill.click();
  await page.getByText('Off: render the prompt as written').click();
  await expect(page.getByRole('button', { name: /^Enhance prompt: off/ })).toBeVisible();
  await expect.poll(async () => Number((await cost.innerText()).match(/(\d+) credits?/)?.[1] ?? NaN), { timeout: 20_000 }).toBeLessThan(onCredits);
  await shot(page, testInfo, 'home-enhance-off');
  // Preferences: the default.
  await page.goto('/settings/preferences');
  const sw = page.getByRole('switch', { name: 'Enhance prompt' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await getJson<{ prefs: { enhancePrompt: boolean } }>(page.request, '/api/me')).prefs.enhancePrompt).toBe(false);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Enhance prompt' })).toHaveAttribute('aria-checked', 'false');
  await page.goto('/');
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Enhance prompt: off/ })).toBeVisible();
  errs.assertClean();
});

test('ENH-3 tools and canvas: Quick Create shows the Enhance prompt switch; a user-made canvas image node shows the pill and its Run quote says “Includes prompt enhancement”', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'enhtools', 'plus');
  await page.goto('/create/quick');
  await expect(page.getByRole('switch', { name: /Enhance prompt/ })).toHaveAttribute('aria-checked', 'true');
  const p = await seedProject(page.request, baseURL, 'Enhance', [
    { op: 'addNode', tempId: 'k', kind: 'image', title: 'Still', position: { x: 0, y: 0 }, params: { prompt: IMAGE.prompt, model: IMAGE.model, ratio: '9:16' } },
  ]);
  const q = (await (await api(page.request, baseURL, 'POST', '/api/runs/quote', { projectId: p.id, scope: 'all' })).json()) as Q;
  expect(q.items[0]!.promptExpand, 'a user-made node follows the preference (on)').toBe(true);
  await openCanvas(page, p.id);
  await page.locator('[data-node-kind="image"]').first().click();
  await expect(page.getByText(/^Enhance prompt: on$/).first()).toBeVisible({ timeout: 20_000 });
  // Run all always opens the plan dialog (Run node would start at once below the confirm threshold).
  await page.getByRole('button', { name: /^Run all/ }).first().click();
  const dlg = page.getByRole('dialog').filter({ hasText: /credits/ }).first();
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  await expect(dlg).toContainText('Includes prompt enhancement');
  // The dialog's total is the server quote, rewrite included.
  await expect(dlg).toContainText(`${q.total} credits`);
  await shot(page, testInfo, 'canvas-enhance-quote');
  await page.keyboard.press('Escape');
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
});
