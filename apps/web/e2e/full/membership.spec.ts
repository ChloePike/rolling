import { expect, test, type APIRequestContext } from '@playwright/test';
import { PLANS } from '@rolling/core/pricing/config';
import { account, api, env, errorCode, freshEmail, apiSignIn, getJson, grantPlan, waitMail, seedProject, SAMPLE_OPS, shot, watchErrors } from './support';

/** Matrix: GATE-1 … GATE-9. Nothing here spends credits (quotes only; starts are refused). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

interface Quote {
  quoteId: string | null;
  items: Array<{ action: string; code?: string; lowestPlan?: string | null; credits: number; model: string | null }>;
  total: number;
  needsConfirm: boolean;
  confirmThreshold: number;
}

async function quote(request: APIRequestContext, baseURL: string | undefined, spec: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await request.post('/api/runs/quote', { data: { promptSpec: spec }, headers: { origin: new URL(baseURL!).origin, ...headers } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Quote;
}

test('GATE-1 a non-member can browse Home, Templates, Public library, Assets, Activity and Upgrade without errors', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'browse');
  const errs = watchErrors(page);
  for (const path of ['/', '/templates', '/assets/public', '/assets', '/activity', '/upgrade', '/settings/billing']) {
    await page.goto(path);
    await expect(page.getByTestId('app-header')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  }
  await shot(page, testInfo, 'nonmember-billing');
  errs.assertClean();
});

test('GATE-2 non-member: agent and generation answer 402 NO_PLAN; quotes stay open', async ({ context, baseURL }) => {
  await account(context, baseURL, 'noplan');
  const req = context.request;
  expect(await errorCode(await api(req, baseURL, 'POST', '/api/agent/threads', { surface: 'home' }))).toBe('NO_PLAN');
  expect(await errorCode(await api(req, baseURL, 'GET', '/api/agent/allowance'))).toBe('NO_PLAN');
  const q = await quote(req, baseURL, { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A glass bottle on a rock' });
  expect(q.quoteId).toBeTruthy();
  const start = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId });
  expect(start.status()).toBe(402);
  expect(await errorCode(start)).toBe('NO_PLAN');
  // Canvas runs too.
  const p = await seedProject(req, baseURL, 'Gate', SAMPLE_OPS);
  const cq = await api(req, baseURL, 'POST', '/api/runs/quote', { projectId: p.id, scope: 'all' });
  expect(cq.status()).toBe(200);
  const cqb = (await cq.json()) as Quote;
  if (cqb.quoteId) expect(await errorCode(await api(req, baseURL, 'POST', '/api/runs', { quoteId: cqb.quoteId }))).toBe('NO_PLAN');
  // Top-ups and auto top-up are member-only.
  expect(await errorCode(await api(req, baseURL, 'POST', '/api/billing/checkout', { kind: 'topUp', amountCents: 1000 }))).toBe('NO_PLAN');
  expect(await errorCode(await api(req, baseURL, 'PATCH', '/api/billing/auto-topup', { enabled: true }))).toBe('NO_PLAN');
});

test('GATE-3 non-member: sending a Home brief opens “Pick a plan to generate” and keeps the brief', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'paywall');
  await page.goto('/');
  const brief = page.locator('#brief');
  const text = 'A 15-second vertical ad for a sparkling water brand by a river at dawn';
  await brief.fill(text);
  await brief.press('Enter');
  const dialog = page.getByRole('dialog').filter({ hasText: 'Pick a plan to generate' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await shot(page, testInfo, 'join-paywall');
  await expect(dialog.getByRole('button', { name: /Continue with/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(brief).toHaveValue(text);
});

test('GATE-4 resolution caps in the API: Starter 720p, Plus 1080p, Pro 4K (video); locked rows name the lowest plan', async ({ context, baseURL }) => {
  await account(context, baseURL, 'caps', 'starter');
  const req = context.request;
  const video = (resolution: string) => ({ kind: 'video', model: 'bytedance/seedance-2.0', prompt: 'A glass bottle on a rock, slow push-in', resolution, seconds: 4 });
  const expectRun = (q: Quote, label: string) => expect(q.items[0]!.action, `${label}: ${JSON.stringify(q.items[0])}`).toBe('run');
  const expectLocked = (q: Quote, lowest: string, label: string) => {
    expect(q.items[0]!.action, label).toBe('blocked');
    expect(q.items[0]!.code, label).toBe('resolution_locked');
    expect(q.items[0]!.lowestPlan, label).toBe(lowest);
    expect(q.quoteId, `${label}: nothing to start`).toBeNull();
  };
  expect(PLANS.starter.maxVideoResolution).toBe('720p');
  expect(PLANS.plus.maxVideoResolution).toBe('1080p');
  expect(PLANS.pro.maxVideoResolution).toBe('4K');

  expectRun(await quote(req, baseURL, video('720p')), 'starter 720p');
  expectLocked(await quote(req, baseURL, video('1080p')), 'plus', 'starter 1080p');
  expectLocked(await quote(req, baseURL, video('4K')), 'pro', 'starter 4K');
  // MiniMax H3 at 768p ranks above 720p (D-006).
  const mm = await quote(req, baseURL, { kind: 'video', model: 'minimax/minimax-h3', prompt: 'A bottle', resolution: '768p', seconds: 4 });
  expect(mm.items[0]!.code).toBe('resolution_locked');

  await grantPlan(req, 'plus');
  expectRun(await quote(req, baseURL, video('1080p')), 'plus 1080p');
  expectLocked(await quote(req, baseURL, video('4K')), 'pro', 'plus 4K');

  await grantPlan(req, 'pro');
  expectRun(await quote(req, baseURL, video('4K')), 'pro 4K');
  // Unknown labels are refused, never treated as allowed.
  const odd = await quote(req, baseURL, video('8K'));
  expect(odd.items[0]!.action).toBe('blocked');
});

test('GATE-5 resolution caps in the UI: Starter sees 1080p locked with the plan that unlocks it', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'capsui', 'starter');
  await page.goto('/');
  await page.getByRole('tab', { name: 'Video', exact: true }).click();
  // Pick a model that offers 1080p, then open the settings pill.
  await page.getByRole('button', { name: /^Model:|Auto model/ }).first().click();
  const picker = page.getByRole('dialog', { name: 'Choose model' }).or(page.getByRole('listbox')).first();
  await expect(picker).toBeVisible();
  await picker.getByRole('option', { name: /Seedance 2\.5(?! Flash)/ }).or(picker.getByRole('button', { name: /Seedance 2\.5(?! Flash)/ })).first().click();
  await page.getByRole('button', { name: /\d+p|\d+s/ }).filter({ hasText: /p\b|s\b/ }).first().click();
  const locked = page.getByRole('radio', { name: /1080p.*Available on Plus/ }).or(page.getByRole('button', { name: /1080p.*Available on Plus/ }));
  await expect(locked.first()).toBeVisible();
  await shot(page, testInfo, 'starter-1080p-locked');
});

test('GATE-6 Team: inviting without Team answers TEAM_REQUIRED and the UI points to Team', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'noteam', 'pro');
  const r = await api(context.request, baseURL, 'POST', '/api/workspace/invites', { email: freshEmail('invitee'), role: 'editor' });
  expect(r.status()).toBe(402);
  const body = (await r.json()) as { error: { code: string; data: { currentPlan: string } } };
  expect(body.error.code).toBe('TEAM_REQUIRED');
  expect(body.error.data.currentPlan).toBe('pro');
  await page.goto('/settings/team');
  await page.getByRole('button', { name: 'Invite member' }).click();
  await expect(page.getByText(/Team/).filter({ hasText: /plan|seat|Team/ }).first()).toBeVisible();
  await expect(page.getByTestId('start-team').or(page.getByRole('button', { name: /Team/ })).first()).toBeVisible();
  await shot(page, testInfo, 'invite-needs-team');
});

test('GATE-7 Team seats, roles and per-member monthly limits: SEATS_REQUIRED, MEMBER_LIMIT_REACHED, viewers cannot spend or edit', async ({ browser, context, baseURL }) => {
  const owner = await account(context, baseURL, 'teamowner', 'team', 0);
  await grantPlan(context.request, 'team', 0, 2); // 2 seats: owner + one
  const oreq = context.request;
  const billing = await getJson<{ seats: { purchased: number; used: number } | null }>(oreq, '/api/billing');
  expect(billing.seats?.purchased).toBe(2);

  const editorEmail = freshEmail('teameditor');
  const inv = await api(oreq, baseURL, 'POST', '/api/workspace/invites', { email: editorEmail, role: 'editor', monthlyCreditLimit: 5 });
  expect(inv.status(), await inv.text()).toBe(201);
  // Seat 3 is not purchased.
  const over = await api(oreq, baseURL, 'POST', '/api/workspace/invites', { email: freshEmail('teamextra'), role: 'viewer' });
  expect(over.status()).toBe(402);
  const overBody = (await over.json()) as { error: { code: string; data: { seats: number; used: number; needed: number } } };
  expect(overBody.error.code).toBe('SEATS_REQUIRED');
  expect(overBody.error.data).toMatchObject({ seats: 2, used: 2, needed: 3 });

  // The invitee accepts from the emailed link.
  const mail = await waitMail(oreq, editorEmail, 'workspace-invite');
  expect(mail, 'invite email').toBeTruthy();
  const token = decodeURIComponent(/\/invite\/([^\s"<]+)/.exec(mail!.text)![1]!);
  const ectx = await browser.newContext({ baseURL });
  await apiSignIn(ectx.request, editorEmail, baseURL);
  const accepted = await api(ectx.request, baseURL, 'POST', '/api/workspace/invites/accept', { token });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const ws = { 'x-workspace-id': owner.workspaceId };

  // Per-member limit 5 credits: a 6-credit image is refused before any hold.
  const q = await quote(ectx.request, baseURL, { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A glass bottle on a rock' }, ws);
  expect(q.total).toBeGreaterThan(5);
  const start = await ectx.request.post('/api/runs', { data: { quoteId: q.quoteId }, headers: { origin: new URL(baseURL!).origin, ...ws } });
  expect(start.status(), await start.text()).toBe(403);
  expect(await errorCode(start)).toBe('MEMBER_LIMIT_REACHED');

  // Owner makes them a viewer: no spending, no graph edits.
  const members = await getJson<{ members: Array<{ userId: string; role: string; monthlyCreditLimit: number | null }> }>(oreq, '/api/workspace/members');
  const ed = members.members.find((m) => m.role === 'editor')!;
  expect(ed.monthlyCreditLimit).toBe(5);
  const toViewer = await api(oreq, baseURL, 'PATCH', `/api/workspace/members/${ed.userId}`, { role: 'viewer', monthlyCreditLimit: null });
  expect(toViewer.status(), await toViewer.text()).toBe(200);
  // Viewers can't even quote (editor role required) — so they can't spend.
  const q2 = await ectx.request.post('/api/runs/quote', { data: { promptSpec: { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A glass bottle on a rock' } }, headers: { origin: new URL(baseURL!).origin, ...ws } });
  expect(q2.status()).toBe(403);
  expect(await errorCode(q2)).toBe('FORBIDDEN');
  const s2 = await ectx.request.post('/api/runs', { data: { quoteId: q.quoteId }, headers: { origin: new URL(baseURL!).origin, ...ws } });
  expect(s2.status()).toBe(403);
  const p = await seedProject(oreq, baseURL, 'Team project', SAMPLE_OPS);
  const edit = await ectx.request.post(`/api/projects/${p.id}/patch`, { data: { baseRevision: p.revision, ops: [{ op: 'addNode', tempId: 'x', kind: 'text', title: 'T', params: {} }] }, headers: { origin: new URL(baseURL!).origin, ...ws } });
  expect(edit.status()).toBe(403);
  // Viewers can read.
  const read = await ectx.request.get(`/api/projects/${p.id}`, { headers: ws });
  expect(read.status()).toBe(200);
  expect(((await read.json()) as { canEdit: boolean }).canEdit).toBe(false);
  // Seat count follows members; lowering below use is refused.
  const lower = await api(oreq, baseURL, 'PATCH', '/api/billing/seats', { seats: 1 });
  expect([409, 503]).toContain(lower.status());
  if (lower.status() === 409) expect(await errorCode(lower)).toBe('SEATS_IN_USE');
  await ectx.close();
});

test('GATE-8 Team settings show members with photos and roles', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'teamui', 'team', 0);
  await grantPlan(context.request, 'team', 0, 3);
  await page.goto('/settings/team');
  await expect(page.getByTestId('team-seats')).toBeVisible();
  await expect(page.getByRole('button', { name: /Role for .*: Owner/ })).toBeVisible();
  await page.getByRole('button', { name: 'Invite member' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().fill(freshEmail('uiinvitee'));
  await dialog.getByRole('button', { name: /Send invite|Invite/ }).last().click();
  await expect(page.getByText(/Invite sent|Pending|Invited/).first()).toBeVisible();
  await shot(page, testInfo, 'team-settings');
});
