import { expect, test } from '@playwright/test';
import { AUTO_TOP_UP, DEFAULT_CONFIRM_THRESHOLD_CREDITS, PLANS, TOP_UP, quoteTopUp } from '@rolling/core/pricing/config';
import { account, api, balance, env, errorCode, getJson, logSpend, openCanvas, seedProject, shot, waitRun } from './support';

/** Matrix: BILL-1 … BILL-9. The forced-failure refund costs nothing (the provider is never called). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

test('BILL-1 /api/billing/plans mirrors packages/core/pricing/config.ts (plans, top-up tiers, auto top-up)', async ({ request }) => {
  const plans = await getJson<{
    plans: Array<{ id: keyof typeof PLANS; monthlyCredits: number; topUpBonus: number; maxVideoResolution: string; maxImageResolution: string; prices: { month: number; year: number } }>;
    topUp: { minCents: number; maxCents: number; tiers: Array<{ minCents: number; bonus: number }>; presetsCents: number[] };
    autoTopUp: { thresholdCredits: number; amountCents: number };
    current: unknown;
  }>(request, '/api/billing/plans');
  expect(plans.current).toBeNull();
  for (const p of plans.plans) {
    const cfg = PLANS[p.id];
    expect(p.monthlyCredits, p.id).toBe(cfg.monthlyCredits);
    expect(p.topUpBonus, p.id).toBe(cfg.topUpBonus);
    expect(p.maxVideoResolution, p.id).toBe(cfg.maxVideoResolution);
    expect(p.maxImageResolution, p.id).toBe(cfg.maxImageResolution);
  }
  expect(plans.topUp.minCents).toBe(TOP_UP.minUsd * 100);
  expect(plans.topUp.maxCents).toBe(TOP_UP.maxUsd * 100);
  expect(plans.topUp.tiers).toEqual(TOP_UP.tiers.map((t) => ({ minCents: t.minUsd * 100, bonus: t.bonus })));
  expect(plans.topUp.presetsCents).toEqual(TOP_UP.presetsUsd.map((u) => u * 100));
  expect(plans.autoTopUp).toEqual({ thresholdCredits: AUTO_TOP_UP.belowCredits, amountCents: AUTO_TOP_UP.amountUsd * 100 });
});

test('BILL-2 top-up: $10 minimum, tier + plan bonus math in the UI matches quoteTopUp; checkout is clean whether or not Stripe is configured', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'topup', 'plus');
  const req = context.request;
  const low = await api(req, baseURL, 'POST', '/api/billing/checkout', { kind: 'topUp', amountCents: 999 });
  expect(low.status()).toBe(400);
  expect(await errorCode(low)).toBe('VALIDATION_FAILED');
  const frac = await api(req, baseURL, 'POST', '/api/billing/checkout', { kind: 'topUp', amountCents: 1000.5 });
  expect(frac.status()).toBe(400);
  const high = await api(req, baseURL, 'POST', '/api/billing/checkout', { kind: 'topUp', amountCents: 1_000_001 });
  expect(high.status()).toBe(400);

  const ok = await api(req, baseURL, 'POST', '/api/billing/checkout', { kind: 'topUp', amountCents: 2500, returnTo: '/settings/billing' });
  if (ok.status() === 200) {
    const body = (await ok.json()) as { url: string; credits: number };
    expect(new URL(body.url).host).toBe('checkout.stripe.com');
    expect(body.credits).toBe(quoteTopUp(2500, 'plus').credits);
    testInfo.annotations.push({ type: 'stripe', description: 'configured (checkout URL issued, not paid)' });
  } else {
    // Stripe test keys missing: a clean “not configured”, never a crash.
    expect(ok.status(), await ok.text()).toBe(503);
    testInfo.annotations.push({ type: 'stripe', description: 'not configured (503)' });
  }

  // The settings chips show credits = quoteTopUp(amount, plan).
  await page.goto('/settings/billing');
  for (const usd of TOP_UP.presetsUsd) {
    const q = quoteTopUp(usd * 100, 'plus');
    const pct = Math.round((q.tierBonus + q.planBonus) * 100);
    await expect(page.getByRole('radio', { name: new RegExp(`^${fmt(q.credits)}\\s+\\$${usd}\\b.*\\+${pct}%`) })).toBeVisible();
  }
  // Custom amount below the minimum is refused in the UI.
  const custom = page.locator('#topup-custom');
  await custom.fill('9');
  await expect(page.getByText(/minimum top-up is \$10/i)).toBeVisible();
  await custom.fill('40');
  const q40 = quoteTopUp(4000, 'plus');
  await expect(page.getByRole('button', { name: new RegExp(`Buy ${fmt(q40.credits)} credits for \\$40`) })).toBeVisible();
  await shot(page, testInfo, 'billing-topup');

  // Upgrade page calculator, Pro bonus.
  await page.goto('/upgrade');
  await page.getByRole('button', { name: '$100' }).click();
  await page.getByRole('button', { name: /^Pro \+10%/ }).click();
  await expect(page.getByTestId('topup-buy')).toContainText(fmt(quoteTopUp(10_000, 'pro').credits));
});

test('BILL-3 auto top-up settings: enable, threshold and amount persist; out-of-range is refused', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'autotopup', 'plus');
  const req = context.request;
  const on = await api(req, baseURL, 'PATCH', '/api/billing/auto-topup', { enabled: true });
  if (on.status() === 200) {
    expect(((await on.json()) as { autoTopUp: unknown }).autoTopUp).toEqual({ enabled: true, thresholdCredits: 200, amountCents: 1000 });
    expect((await api(req, baseURL, 'PATCH', '/api/billing/auto-topup', { enabled: true, amountCents: 500 })).status()).toBe(400);
    const custom = await api(req, baseURL, 'PATCH', '/api/billing/auto-topup', { enabled: true, thresholdCredits: 300, amountCents: 2500 });
    expect(custom.status()).toBe(200);
    expect((await getJson<{ autoTopUp: unknown }>(req, '/api/billing')).autoTopUp).toEqual({ enabled: true, thresholdCredits: 300, amountCents: 2500 });
    await page.goto('/settings/billing');
    await expect(page.getByRole('switch', { name: /Auto top-up/ }).or(page.getByRole('checkbox', { name: /Auto top-up/ })).first()).toBeChecked();
    const off = await api(req, baseURL, 'PATCH', '/api/billing/auto-topup', { enabled: false });
    expect(off.status()).toBe(200);
  } else {
    // Without a saved card (Stripe test keys missing) the API may refuse; it must be a clean 4xx/503.
    expect([402, 409, 503]).toContain(on.status());
  }
});

test('BILL-4 confirm-before-run: default threshold 300; at or above → needsConfirm; the preference moves it', async ({ context, baseURL }) => {
  await account(context, baseURL, 'threshold', 'pro');
  const req = context.request;
  const q = async (spec: Record<string, unknown>) => (await (await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: spec })).json()) as { total: number; needsConfirm: boolean; confirmThreshold: number };
  const cheap = await q({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A bottle' });
  expect(cheap.confirmThreshold).toBe(DEFAULT_CONFIRM_THRESHOLD_CREDITS);
  expect(cheap.needsConfirm).toBe(false);
  const dear = await q({ kind: 'video', model: 'bytedance/seedance-2.5', prompt: 'A bottle', resolution: '720p', seconds: 5 });
  expect(dear.total).toBeGreaterThanOrEqual(300);
  expect(dear.needsConfirm).toBe(true);
  const set = await api(req, baseURL, 'PATCH', '/api/me/prefs', { confirmThreshold: 5 });
  expect(set.status(), await set.text()).toBe(200);
  const cheap2 = await q({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A bottle' });
  expect(cheap2.confirmThreshold).toBe(5);
  expect(cheap2.needsConfirm).toBe(true);
});

test('BILL-5 quote → hold → release: a forced failure refunds the whole hold and shows in Activity and the ledger', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'refund', 'plus');
  const req = context.request;
  const before = await balance(req);
  const qr = await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: { kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'A glass bottle on a rock' } });
  const q = (await qr.json()) as { quoteId: string; total: number };
  const start = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId, options: { forceFailure: true } });
  expect(start.status(), await start.text()).toBe(201);
  const { runId } = (await start.json()) as { runId: string };
  // Same quote again → the same run (idempotent start).
  const again = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId, options: { forceFailure: true } });
  expect(((await again.json()) as { runId: string }).runId).toBe(runId);
  const run = await waitRun(req, runId, 3 * 60_000);
  expect(run.status).toBe('failed');
  expect(run.spent).toBe(0);
  expect(run.refunded).toBe(q.total);
  logSpend(testInfo, { runId, credits: run.spent, refunded: run.refunded, note: 'forced failure' });
  const after = await balance(req);
  expect(after.plan + after.purchased).toBe(before.plan + before.purchased);
  expect(after.held).toBe(0);
  // Ledger: hold then refund for this run (the D1 mirror is eventually consistent).
  await expect
    .poll(async () => {
      const l = await getJson<{ lines: Array<{ kind: string; runId: string | null; amount: number }> }>(req, '/api/billing/ledger?first=50');
      return l.lines.filter((x) => x.runId === runId).map((x) => x.kind).sort().join(',');
    }, { timeout: 30_000 })
    .toMatch(/hold.*refund|refund.*hold/);
  await page.goto('/activity');
  await page.getByRole('button', { name: 'Failed', exact: true }).click();
  await expect(page.getByText(new RegExp(`Refunded ${q.total} credits`)).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'activity-refund');
});

test('BILL-6 ledger and credit history: grant and purchase lines, newest first, paginated', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'ledger', 'plus', 123);
  const req = context.request;
  await expect
    .poll(async () => (await getJson<{ lines: Array<{ kind: string }> }>(req, '/api/billing/ledger?first=10')).lines.map((l) => l.kind).sort().join(','), { timeout: 30_000 })
    .toBe('grant,purchase');
  const l = await getJson<{ lines: Array<{ kind: string; bucket: string; amount: number; createdAt: number }>; pageInfo: { hasNextPage: boolean } }>(req, '/api/billing/ledger?first=1');
  expect(l.lines).toHaveLength(1);
  expect(l.pageInfo.hasNextPage).toBe(true);
  const all = await getJson<{ lines: Array<{ kind: string; bucket: string; amount: number }> }>(req, '/api/billing/ledger?first=10');
  expect(all.lines.find((x) => x.kind === 'grant')).toMatchObject({ bucket: 'plan', amount: PLANS.plus.monthlyCredits });
  expect(all.lines.find((x) => x.kind === 'purchase')).toMatchObject({ bucket: 'purchased', amount: 123 });
  await page.goto('/settings/billing');
  const ledger = page.getByTestId('ledger');
  await expect(ledger).toContainText(fmt(PLANS.plus.monthlyCredits));
  await expect(ledger).toContainText('123');
  // The header credits popover splits plan vs purchased.
  await page.getByRole('button', { name: /Credit balance/ }).click();
  const pop = page.getByRole('dialog', { name: 'Credits' });
  await expect(pop.getByText('Plan credits', { exact: true })).toBeVisible();
  await expect(pop.getByText('Purchased credits', { exact: true })).toBeVisible();
  await expect(pop.getByText(fmt(PLANS.plus.monthlyCredits + 123)).first()).toBeVisible();
});

test('BILL-7 a member with too few credits gets “Not enough credits” with needed / balance / short by (nothing is held)', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'poor', 'starter');
  // Starter has 200 plan credits; a 5 s Seedance 2.5 720p clip costs more.
  const req = context.request;
  const q = (await (await api(req, baseURL, 'POST', '/api/runs/quote', { promptSpec: { kind: 'video', model: 'bytedance/seedance-2.5', prompt: 'A bottle', resolution: '720p', seconds: 5 } })).json()) as { quoteId: string; total: number };
  expect(q.total).toBeGreaterThan(PLANS.starter.monthlyCredits);
  const start = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId });
  expect(start.status()).toBe(402);
  const body = (await start.json()) as { error: { code: string; data: { needed: number; balance: number } } };
  expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
  expect(body.error.data.needed).toBe(q.total);
  expect(body.error.data.balance).toBe(PLANS.starter.monthlyCredits);
  expect((await balance(req)).held).toBe(0);
  // UI: Run all on a canvas whose only node costs more than the balance.
  const p = await seedProject(req, baseURL, 'Too dear', [
    { op: 'addNode', tempId: 'v', kind: 'video', title: 'Dear shot', params: { prompt: 'A glass bottle on a rock', model: 'bytedance/seedance-2.5', resolution: '720p', length: 5, ratio: '9:16' } },
  ]);
  await openCanvas(page, p.id);
  await page.getByRole('button', { name: /^Run all/ }).click();
  const dialog = page.getByTestId('plan-dialog');
  await dialog.getByRole('button', { name: /^Run · [\d,]+ credits/ }).click();
  const pw = page.getByRole('dialog').filter({ hasText: 'Not enough credits' });
  await expect(pw).toBeVisible({ timeout: 20_000 });
  await expect(pw).toContainText('Short by');
  await expect(pw).toContainText(fmt(q.total - PLANS.starter.monthlyCredits));
  await shot(page, testInfo, 'credits-paywall');
  expect((await balance(req)).held).toBe(0);
});
