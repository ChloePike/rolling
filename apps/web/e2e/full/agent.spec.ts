import { expect, test } from '@playwright/test';
import { AGENT_ALLOWANCE_USD } from '@rolling/core/pricing/config';
import { account, api, balance, env, getJson, grantPlan, openCanvas, projectSnapshot, SAMPLE_OPS, seedProject, shot } from './support';

/** Matrix: AGENT-1 … AGENT-7. Agent turns cost gateway USD (DeepSeek is unmetered for the user), never credits. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

interface Allowance {
  plan: string;
  allowanceUsd: number;
  usedUsd: number;
  resetsAt: number;
  models: Array<{ id: string; name: string; unlimited: boolean; estTurnUsd?: number; turnsLeft?: number }>;
}

test('AGENT-1 allowance per plan (D-012): Starter $1.20 / Plus $3.50 / Pro $12.50; DeepSeek (incl. 1017) unmetered; pricier LLMs get fewer turns', async ({ context, baseURL }) => {
  await account(context, baseURL, 'allow', 'starter');
  const req = context.request;
  for (const plan of ['starter', 'plus', 'pro'] as const) {
    if (plan !== 'starter') await grantPlan(req, plan);
    const a = await getJson<Allowance>(req, '/api/agent/allowance');
    expect(a.plan).toBe(plan);
    expect(a.allowanceUsd).toBe(AGENT_ALLOWANCE_USD[plan]);
    expect(a.resetsAt).toBeGreaterThan(Date.now());
    const ids = a.models.map((m) => m.id);
    expect(ids).toContain('deepseek-v4.1-flash');
    expect(ids).toContain('deepseek-v4.1-flash-1017');
    for (const m of a.models.filter((x) => x.id.startsWith('deepseek'))) expect(m.unlimited, m.id).toBe(true);
    // Public ids only — never gateway ids.
    for (const id of ids) expect(id, 'public LLM id').not.toContain('/');
    const metered = a.models.filter((m) => !m.unlimited);
    expect(metered.length).toBeGreaterThan(0);
    for (const m of metered) {
      expect(Math.abs(m.turnsLeft! - (a.allowanceUsd - a.usedUsd) / m.estTurnUsd!), m.id).toBeLessThanOrEqual(1);
    }
    const opus = metered.find((m) => m.id === 'claude-opus-5.5');
    const haiku = metered.find((m) => m.id === 'claude-haiku-5.5');
    if (opus && haiku) expect(opus.turnsLeft!).toBeLessThan(haiku.turnsLeft!);
  }
});

test('AGENT-2 LLM routing: a turn on DeepSeek V4.1 Flash 1017 answers on that public id; unknown ids are refused', async ({ context, baseURL }) => {
  test.setTimeout(4 * 60_000);
  await account(context, baseURL, 'llm', 'plus');
  const req = context.request;
  const t = await api(req, baseURL, 'POST', '/api/agent/threads', { surface: 'home' });
  expect(t.status(), await t.text()).toBe(201);
  const { thread } = (await t.json()) as { thread: { id: string } };
  const bad = await api(req, baseURL, 'POST', `/api/agent/threads/${thread.id}/messages`, { text: 'Hi', llm: 'deepseek/deepseek-v4.1-flash' });
  expect(bad.status()).toBe(400);
  const r = await api(req, baseURL, 'POST', `/api/agent/threads/${thread.id}/messages`, { text: 'In one sentence: what can you help me make?', llm: 'deepseek-v4.1-flash-1017' });
  expect(r.status(), await r.text()).toBe(200);
  const body = (await r.json()) as { llm: string; text: string; error: unknown; proposal: unknown };
  expect(body.llm).toBe('deepseek-v4.1-flash-1017');
  expect(body.error).toBeNull();
  expect(body.text.length).toBeGreaterThan(0);
  // Unmetered: the allowance is untouched.
  expect((await getJson<Allowance>(req, '/api/agent/allowance')).usedUsd).toBe(0);
});

test('AGENT-3 Home agent: brief → plan options with estimates → Build on canvas creates nodes and spends nothing', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(6 * 60_000);
  await account(context, baseURL, 'agentplan', 'plus');
  const before = await balance(page.request);
  await page.goto('/');
  await page.locator('#brief').fill('15-second vertical ad for a sparkling water brand: morning by a river, the bottle on a rock, a fresh pop and the logo.');
  await page.locator('#brief').press('Enter');
  const plan = page.getByTestId('home-plan');
  await expect(plan).toBeVisible({ timeout: 4 * 60_000 });
  await shot(page, testInfo, 'home-plan');
  const options = page.locator('[data-testid^="home-plan-option-"]');
  expect(await options.count()).toBeGreaterThanOrEqual(2);
  await expect(options.first()).toContainText(/credits/);
  await options.first().click();
  await plan.getByRole('button', { name: 'Build on canvas' }).click();
  await page.waitForURL(/\/p\/prj_/, { timeout: 60_000 });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('[data-node-kind="video"]').first()).toBeVisible({ timeout: 30_000 });
  // Approval gate: building is free, no run exists.
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
  const after = await balance(page.request);
  expect(after.plan + after.purchased).toBe(before.plan + before.purchased);
});

test('AGENT-4 canvas agent: graph-patch proposal with diff highlight; Apply applies exactly it; Discard drops the next one', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(8 * 60_000);
  await account(context, baseURL, 'agentpatch', 'plus');
  const p = await seedProject(page.request, baseURL, 'Agent patch', [
    ...SAMPLE_OPS,
    { op: 'addNode', tempId: 'v2', kind: 'video', title: 'Shot B', position: { x: 840, y: 360 }, params: { prompt: 'The bottle pops open, spray in the sun', model: 'x-ai/grok-imagine-video-1.5-lite', resolution: '480p', length: 2, ratio: '9:16' } },
  ]);
  await openCanvas(page, p.id);
  const ask = page.locator('#canvas-ask');
  await ask.fill('make shot 2 warmer');
  await ask.press('Enter');
  const proposal = page.getByTestId('graph-proposal').last();
  await expect(proposal).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.locator('[data-proposed]').first()).toBeVisible();
  await shot(page, testInfo, 'graph-proposal');
  const threads = await getJson<{ items: Array<{ id: string }> }>(page.request, `/api/agent/threads?projectId=${p.id}`);
  const thread = await getJson<{ thread: { proposals: Array<{ id: string; kind: string; status: string; body: { ops: Array<{ op: string; nodeId?: string; params?: Record<string, unknown> }> } }> } }>(page.request, `/api/agent/threads/${threads.items[0]!.id}`);
  const prop = thread.thread.proposals.filter((x) => x.kind === 'graphPatch').at(-1)!;
  const before = (await getJson<{ snapshot: { revision: number } }>(page.request, `/api/projects/${p.id}`)).snapshot;
  await proposal.getByRole('button', { name: 'Apply' }).click();
  await expect(proposal).toHaveAttribute('data-outcome', 'applied', { timeout: 30_000 });
  const after = await projectSnapshot(page.request, p.id);
  expect(after.revision).toBe(before.revision + 1);
  for (const op of prop.body.ops.filter((o) => o.op === 'updateNode')) {
    const n = after.nodes.find((x) => x.id === op.nodeId)!;
    for (const [k, v] of Object.entries(op.params ?? {})) expect(n.params[k], `${op.nodeId}.${k}`).toEqual(v);
  }
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);

  await ask.fill('make shot 1 cooler');
  await ask.press('Enter');
  const second = page.getByTestId('graph-proposal').last();
  await expect(second).toHaveAttribute('data-outcome', 'open', { timeout: 4 * 60_000 });
  const rev = (await getJson<{ snapshot: { revision: number } }>(page.request, `/api/projects/${p.id}`)).snapshot.revision;
  await second.getByRole('button', { name: 'Discard' }).click();
  await expect(second).toHaveAttribute('data-outcome', 'discarded');
  expect((await getJson<{ snapshot: { revision: number } }>(page.request, `/api/projects/${p.id}`)).snapshot.revision).toBe(rev);
});

test('AGENT-5 editor agent: “cut to 10s” proposes a timeline patch; Apply changes the cut duration', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(8 * 60_000);
  await account(context, baseURL, 'agenttl', 'plus');
  const p = await seedProject(page.request, baseURL, 'Agent timeline', [
    { op: 'addNode', tempId: 's', kind: 'script', title: 'Script', params: { rows: [
      { n: 1, visual: 'Bottle on a rock', seconds: 5 },
      { n: 2, visual: 'Cap pops', seconds: 5 },
      { n: 3, visual: 'Logo', seconds: 5 },
    ] } },
    { op: 'addNode', tempId: 'a', kind: 'video', title: 'Shot 1', params: { prompt: 'Bottle on a rock', resolution: '480p', length: 5 } },
    { op: 'addNode', tempId: 'b', kind: 'video', title: 'Shot 2', params: { prompt: 'Cap pops', resolution: '480p', length: 5 } },
    { op: 'addNode', tempId: 'c', kind: 'video', title: 'Shot 3', params: { prompt: 'Logo', resolution: '480p', length: 5 } },
  ]);
  await page.goto(`/p/${p.id}?overlay=edit`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 });
  const snap = (await getJson<{ snapshot: { canvases: Array<{ id: string }> } }>(page.request, `/api/projects/${p.id}`)).snapshot;
  const canvasId = snap.canvases[0]!.id;
  const tl0 = await getJson<{ revision: number; edl: { tracks: Array<{ kind: string; clips: Array<{ start: number; in: number; out: number }> }> } }>(page.request, `/api/canvases/${canvasId}/timeline`);
  const dur = (edl: typeof tl0.edl) => Math.max(0, ...edl.tracks.filter((t) => t.kind !== 'caption').flatMap((t) => t.clips.map((c) => c.start + (c.out - c.in))));
  expect(dur(tl0.edl)).toBeCloseTo(15, 0);
  const field = page.getByPlaceholder(/Ask for an edit/).first();
  await field.fill('cut to 10s');
  await field.press('Enter');
  const card = page.getByRole('button', { name: 'Apply' }).first();
  await expect(card).toBeVisible({ timeout: 4 * 60_000 });
  await shot(page, testInfo, 'timeline-proposal');
  await card.click();
  await expect.poll(async () => dur((await getJson<typeof tl0>(page.request, `/api/canvases/${canvasId}/timeline`)).edl), { timeout: 30_000 }).toBeCloseTo(10, 0);
});

test('AGENT-6 agent UI: the canvas agent model pill lists public LLMs with turns left; DeepSeek shows no count', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'agentpill', 'starter');
  const p = await seedProject(page.request, baseURL, 'Pill', []);
  await openCanvas(page, p.id);
  await page.getByRole('button', { name: /^Agent model:/ }).click();
  const menu = page.getByRole('menu').or(page.getByRole('listbox')).or(page.getByRole('dialog')).last();
  await expect(menu).toContainText('DeepSeek V4.1 Flash');
  await expect(menu).toContainText('DeepSeek V4.1 Flash 1017');
  await expect(menu).toContainText(/Claude Opus 5\.5/);
  await expect(menu).toContainText(/~[\d,]+ turns left/);
  await shot(page, testInfo, 'agent-llm-menu');
  const deepseekRow = menu.getByText('DeepSeek V4.1 Flash', { exact: true }).first().locator('xpath=ancestor::*[@role="menuitemradio" or @role="option" or self::button][1]');
  await expect(deepseekRow).not.toContainText(/turns left/);
});
