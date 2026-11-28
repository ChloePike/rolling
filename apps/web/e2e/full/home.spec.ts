import { expect, test, type Page } from '@playwright/test';
import { account, balance, env, getJson, shot, watchErrors, type RunView } from './support';

/**
 * Matrix: HOME-1 … HOME-3 (Home run cards, an agent brief opening its canvas (D-038), Blank canvas / All projects).
 * Nothing here spends: the run card's start is sent with `options.forceFailure` (refunded in full),
 * agent turns run on DeepSeek (unmetered).
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

/** Every run start from this page fails on purpose (staging only): the hold is released in full. */
async function forceFailures(page: Page) {
  await page.route('**/api/runs', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    return route.fallback({ postData: JSON.stringify({ ...body, options: { ...((body.options as object) ?? {}), forceFailure: true } }) });
  });
}

async function pickImageModel(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await page.getByRole('button', { name: /^Model:|Auto model/ }).first().click();
  await page.getByRole('dialog', { name: 'Choose model' }).getByText(name, { exact: true }).first().click();
}

test('HOME-1 run cards: an Image send becomes a card under the prompt box (no toast) that follows the run; a failure shows the reason, “No credits were charged”, Retry; the card survives a reload; the run is a Home run', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(4 * 60_000);
  await account(context, baseURL, 'homecard', 'plus');
  const before = await balance(page.request);
  const errs = watchErrors(page);
  await forceFailures(page);
  await page.goto('/');
  await pickImageModel(page, 'Seedream 5.0 Flash');
  const prompt = 'A glass bottle on a mossy rock at dawn, product photo';
  await page.locator('#brief').fill(prompt);
  const started = page.waitForResponse((r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await page.locator('#brief').press('Enter');
  expect((await started).status()).toBe(201);
  const card = page.getByTestId('home-run').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(prompt.slice(0, 20));
  // Toasts are gone: the card carries the state.
  await expect(page.getByText(/started · \d+ credits? held/)).toHaveCount(0);
  await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 120_000 });
  await expect(card.getByTestId('home-run-error')).not.toBeEmpty();
  // Said once, in the cost line; the reason above it does not repeat it.
  await expect(card.getByTestId('home-run-error')).not.toContainText('No credits were charged');
  await expect(card.getByText(/No credits were charged/)).toHaveCount(1);
  await expect(card.getByTestId('home-run-cost')).toHaveText(/^No credits were charged · \d+ held credits? released$/);
  await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
  await shot(page, testInfo, 'home-card-failed');
  const after = await balance(page.request);
  expect(after.held).toBe(0);
  expect(after.plan + after.purchased).toBe(before.plan + before.purchased);
  // The run records where it started (Activity's Source).
  const runs = (await getJson<{ runs: Array<RunView & { surface?: string }> }>(page.request, '/api/runs?first=5')).runs;
  expect(runs[0]?.surface).toBe('home');
  await page.reload();
  await expect(page.getByTestId('home-run').first()).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
  await page.goto('/activity');
  await expect(page.getByRole('main')).toContainText('Home');
  errs.assertClean();
});

test('HOME-2 agent brief (D-038): Home opens a new canvas with the agent panel; small talk gets a short reply (no plan), a brief gets a plan card in view that builds into that project; the thread survives a reload and comes back on a “new device”', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(8 * 60_000);
  await account(context, baseURL, 'homeagent', 'plus');
  const errs = watchErrors(page);
  await page.goto('/');
  // No conversation UI on Home.
  await expect(page.getByRole('button', { name: 'New conversation' })).toHaveCount(0);
  await page.locator('#brief').fill('hello');
  await page.locator('#brief').press('Enter');
  await expect(page).toHaveURL(/\/p\/prj_[A-Za-z0-9]+$/, { timeout: 30_000 });
  const projectId = new URL(page.url()).pathname.split('/').pop()!;
  const agent = page.locator('aside[aria-label="Agent"]');
  await expect(agent.getByTestId('agent-user')).toHaveText('hello');
  const reply = agent.getByTestId('agent-reply').last();
  await expect(reply).toBeVisible({ timeout: 120_000 });
  const smallTalk = (await reply.innerText()).trim();
  expect(smallTalk.length).toBeGreaterThan(0);
  expect(smallTalk.length, `a short reply to small talk: “${smallTalk}”`).toBeLessThan(600);
  // No tool narration (“I’ll check the models first”).
  expect(smallTalk).not.toMatch(/^(I['’]ll|Let me) (check|look|read|fetch)/i);
  await expect(agent.getByTestId('plan-card')).toHaveCount(0);

  const box = agent.getByLabel('Tell the agent');
  await box.fill('A 10-second vertical ad for a desk lamp: the switch, then the warm glow on a notebook.');
  await box.press('Enter');
  const plan = agent.getByTestId('plan-card');
  await expect(plan).toBeVisible({ timeout: 4 * 60_000 });
  await expect(plan.getByRole('button', { name: 'Build on canvas' })).toBeInViewport({ timeout: 10_000 });
  await shot(page, testInfo, 'home-agent-canvas-plan');
  await plan.getByRole('button', { name: 'Build on canvas' }).click();
  await expect(plan.getByRole('status')).toContainText('Nothing was charged', { timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(`/p/${projectId}`);

  await page.reload();
  await expect(agent.getByTestId('agent-user')).toHaveCount(2, { timeout: 30_000 });
  // The server lists the thread under its project: another device restores it.
  const threads = await getJson<{ items: Array<{ id: string; surface: string }> }>(page.request, `/api/agent/threads?projectId=${projectId}`);
  expect(threads.items.map((t) => t.surface)).toContain('canvas');
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (/agent|thread/i.test(k)) localStorage.removeItem(k);
  });
  await page.reload();
  await expect(agent.getByTestId('agent-user').first()).toHaveText('hello', { timeout: 30_000 });
  errs.assertClean();
});

test('HOME-3 Blank canvas creates one project and opens it (double click makes one); All projects opens the full list in place', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'homeblank');
  await page.goto('/');
  const entry = page.getByRole('link', { name: 'Blank canvas' }).first();
  await expect(entry).toBeVisible();
  await entry.dblclick();
  await page.waitForURL(/\/p\/prj_/, { timeout: 30_000 });
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('This canvas doesn’t exist')).toHaveCount(0);
  const projects = await page.request.post('/api/graphql', { data: { query: '{ projects(first: 20) { edges { node { id } } } }' } });
  expect(((await projects.json()) as { data: { projects: { edges: unknown[] } } }).data.projects.edges).toHaveLength(1);
  // Five more projects: Home shows four, All projects shows them all in place.
  for (let i = 0; i < 5; i++) await page.request.post('/api/projects', { data: { title: `List ${i + 1}` }, headers: { origin: new URL(baseURL!).origin } });
  await page.goto('/');
  const all = page.getByRole('button', { name: /^All projects/ });
  await expect(all).toBeVisible({ timeout: 20_000 });
  const grid = page.locator('#home-projects-grid');
  const shown = await grid.getByText(/^List \d$/).count();
  await all.click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(async () => grid.getByText(/^List \d$/).count(), { timeout: 15_000 }).toBeGreaterThan(shown);
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
});
