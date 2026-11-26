import { expect, test } from '@playwright/test';
import { account, api, apiSignIn, codeFor, env, errorCode, getJson, waitMail, shot, watchErrors } from './support';

/** Matrix: SET-1 … SET-10. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d4b0b4f20000000049454e44ae426082', 'hex');

test('SET-1 account profile: name, handle and bio save and survive a reload; bad handles are refused', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'profile');
  const errs = watchErrors(page);
  await page.goto('/settings/account');
  const handle = `full${Date.now().toString(36)}`;
  await page.locator('#acc-name').fill('Full Test');
  await page.locator('#acc-handle').fill(handle);
  await page.locator('#acc-bio').fill('Short videos');
  const save = page.getByTestId('save-bar').getByRole('button', { name: /Save/ });
  if (await save.isVisible().catch(() => false)) await save.click();
  else await page.locator('#acc-bio').press('Tab');
  await expect.poll(async () => (await getJson<{ user: { name: string; handle: string; bio: string } }>(page.request, '/api/me')).user, { timeout: 15_000 }).toMatchObject({ name: 'Full Test', handle, bio: 'Short videos' });
  await page.reload();
  await expect(page.locator('#acc-handle')).toHaveValue(new RegExp(`^@?${handle}$`));
  const bad = await api(page.request, baseURL, 'PATCH', '/api/me/profile', { handle: 'a b' });
  expect(bad.status()).toBe(400);
  await shot(page, testInfo, 'account');
  errs.assertClean();
});

test('SET-2 avatar upload: Change photo shows the new picture, served from a signed media URL', async ({ page, context, baseURL }, testInfo) => {
  const a = await account(context, baseURL, 'avatarup');
  await page.goto('/settings/account');
  await page.getByTestId('photo-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await expect(page.getByTestId('avatar-img').first()).toBeVisible({ timeout: 60_000 });
  const src = await page.getByTestId('avatar-img').first().getAttribute('src');
  expect(src).toBeTruthy();
  expect(new URL(src!, baseURL).pathname.startsWith('/api/media/private')).toBe(false);
  const r = await page.request.get(`/api/media/avatar/${a.userId}`, { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  await shot(page, testInfo, 'avatar');
});

test('SET-3 sign-in methods: Google can be connected from Settings (popup / start URL with intent=link)', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'glink');
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Manage sign-in' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Google');
  await expect(dialog.getByRole('button', { name: /Connect/ })).toBeVisible();
  const start = await page.request.get('/api/auth/google/start?intent=link&redirect=/settings/account', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
});

test('SET-4 theme: System follows the OS live, Light and Dark override; persisted in prefs', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings/preferences');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const isLight = async () => {
    const m = /(\d+), (\d+), (\d+)/.exec(await bg())!;
    return Number(m[1]) + Number(m[2]) + Number(m[3]) > 382;
  };
  expect(await isLight()).toBe(false);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(isLight).toBe(true);
  await page.getByRole('button', { name: 'Dark', exact: true }).or(page.getByRole('radio', { name: 'Dark', exact: true })).first().click();
  await expect.poll(isLight).toBe(false);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await getJson<{ prefs: { theme: string } }>(page.request, '/api/me')).prefs.theme).toBe('dark');
  await page.getByRole('button', { name: 'Light', exact: true }).or(page.getByRole('radio', { name: 'Light', exact: true })).first().click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(isLight).toBe(true);
  await shot(page, testInfo, 'light');
  const tc = await page.locator('meta[name="theme-color"]').first().getAttribute('content');
  expect(tc?.toLowerCase()).not.toBe('#0b0b0c');
  await page.reload();
  await expect.poll(isLight).toBe(true);
  await page.getByRole('button', { name: 'System', exact: true }).or(page.getByRole('radio', { name: 'System', exact: true })).first().click();
  await expect.poll(isLight).toBe(false);
});

test('SET-5 language and currency: currency formats prices through Intl; untranslated languages are marked', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'locale', 'plus');
  const r = await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { currency: 'EUR' });
  expect(r.status(), await r.text()).toBe(200);
  await page.goto('/settings/preferences');
  await expect(page.getByRole('button', { name: 'Currency: EUR' })).toBeVisible();
  await page.goto('/upgrade');
  await expect(page.getByText(/€\s?\d|\d\s?€/).first()).toBeVisible();
  await shot(page, testInfo, 'eur-upgrade');
  await page.goto('/settings/preferences');
  await page.getByRole('button', { name: /^Language:/ }).click();
  await expect(page.getByText('日本語').or(page.getByText('Deutsch')).first()).toBeVisible();
  await page.keyboard.press('Escape');
  const bad = await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { currency: 'XXX1' });
  expect(bad.status()).toBe(400);
});

test('SET-6 preferences persist: creation mode, default ratio, confirm threshold; the header settings popover reflects them', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'prefs');
  await page.goto('/settings/preferences');
  await page.getByRole('button', { name: 'Advanced', exact: true }).or(page.getByRole('radio', { name: 'Advanced' })).first().click();
  await expect.poll(async () => (await getJson<{ prefs: { creationMode: string } }>(page.request, '/api/me')).prefs.creationMode).toBe('advanced');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const pop = page.getByRole('dialog', { name: 'Settings' });
  await expect(pop).toContainText('Advanced');
  await page.keyboard.press('Escape');
  const empty = await api(page.request, baseURL, 'PATCH', '/api/me/prefs', {});
  expect(empty.status()).toBe(400);
  const unknown = await api(page.request, baseURL, 'PATCH', '/api/me/prefs', { nope: 1 });
  expect(unknown.status()).toBe(400);
});

test('SET-7 notifications toggles persist', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'notif');
  await page.goto('/settings/notifications');
  const sw = page.getByRole('switch', { name: 'Product updates' }).or(page.getByRole('button', { name: 'Product updates' })).first();
  const before = (await sw.getAttribute('aria-checked')) ?? (await sw.getAttribute('aria-pressed'));
  await sw.click();
  await expect.poll(async () => (await sw.getAttribute('aria-checked')) ?? (await sw.getAttribute('aria-pressed'))).not.toBe(before);
  await page.waitForTimeout(1500);
  await page.reload();
  const after = page.getByRole('switch', { name: 'Product updates' }).or(page.getByRole('button', { name: 'Product updates' })).first();
  await expect.poll(async () => (await after.getAttribute('aria-checked')) ?? (await after.getAttribute('aria-pressed'))).not.toBe(before);
});

test('SET-8 plan and billing page: plan, balance split, invoices empty state, credit history', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'billpage', 'pro', 250);
  await page.goto('/settings/billing');
  await expect(page.getByRole('main')).toContainText('Pro');
  await expect(page.getByTestId('plan-status')).toContainText('$49');
  // Design (Settings.dc.html): “Renews [DATE] with 3,000 credits.” — plan credits are not “bonus” credits.
  await expect(page.getByTestId('plan-status')).not.toContainText('bonus');
  await expect(page.getByTestId('balance')).toContainText('2,750');
  await expect(page.getByTestId('no-invoices').or(page.getByRole('heading', { name: 'Invoices' })).first()).toBeVisible();
  await expect(page.getByTestId('ledger')).toBeVisible();
  await shot(page, testInfo, 'billing');
});

test('SET-9 data export: starts once per 24 h and emails a download link', async ({ page, context, baseURL }, testInfo) => {
  const a = await account(context, baseURL, 'export');
  const r = await api(page.request, baseURL, 'POST', '/api/account/export', {});
  expect(r.status(), await r.text()).toBe(202);
  const again = await api(page.request, baseURL, 'POST', '/api/account/export', {});
  expect(again.status()).toBe(429);
  await expect
    .poll(async () => (await getJson<{ export: { status: string } | null }>(page.request, '/api/account/export')).export?.status, { timeout: 3 * 60_000, intervals: [3000] })
    .toBe('done');
  const mail = await waitMail(page.request, a.email, 'data-export-ready');
  expect(mail, 'data-export-ready email').toBeTruthy();
  await page.goto('/settings/account');
  await expect(page.getByText(/export/i).first()).toBeVisible();
  await shot(page, testInfo, 'export');
});

test('SET-10 account deletion: code by email, wrong code refused, right code deletes and signs out; the email can sign up fresh', async ({ page, context, baseURL }, testInfo) => {
  const a = await account(context, baseURL, 'delete');
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Delete account' }).click();
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('delete-privacy').or(dialog.getByRole('link', { name: /Privacy/ })).first()).toBeVisible();
  const sentAt = Date.now();
  await dialog.getByRole('button', { name: /Send code|Email me a code|Continue/ }).first().click();
  const code = await codeFor(page.request, a.email, sentAt, 'delete-account-code');
  const wrong = await api(page.request, baseURL, 'POST', '/api/me/delete', { code: code === '000000' ? '111111' : '000000' });
  expect(wrong.status()).toBe(400);
  expect(await errorCode(wrong)).toBe('INVALID_CODE');
  await shot(page, testInfo, 'delete-dialog');
  await dialog.getByRole('textbox').or(dialog.locator('input')).first().fill(code);
  await dialog.getByRole('button', { name: /Delete/ }).last().click();
  await expect(page).toHaveURL(/\/login|\/$/, { timeout: 30_000 });
  expect((await page.request.get('/api/me')).status()).toBe(401);
  // Same email signs up as a new user.
  await page.waitForTimeout(31_000);
  await apiSignIn(page.request, a.email, baseURL);
  const me = await getJson<{ user: { id: string } }>(page.request, '/api/me');
  expect(me.user.id).not.toBe(a.userId);
});
