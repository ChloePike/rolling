import { expect, test } from '@playwright/test';
import { codeFor, freshEmail, me, seedPlan, signIn } from './support';

/**
 * Account side against the real local Worker (playwright.account-real.config.ts):
 * Better Auth email codes from the test inbox, `GET /api/me` driving the
 * session and header, `PATCH /api/me/prefs` persistence and live
 * `prefs.changed` across tabs over the shared user socket, workspace members,
 * the route guard, logout, invite and share 404s, and checkout errors.
 */

test('signed-out visitors are sent to /login and come back after the email code', async ({ page }) => {
  await page.goto('/settings/billing');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Fbilling$/);
  const email = freshEmail('guard');
  await page.getByLabel('Email').fill(email);
  const t0 = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue with email' }).click();
  // The server's 30 s resend cooldown drives the timer.
  await expect(page.getByRole('button', { name: /Resend in 0:(30|29|28)/ })).toBeDisabled();
  const code = await codeFor(page.request, email, t0);
  await page.getByLabel('Verification code').locator('input').fill(code);
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByText('Your account is ready.').or(page.getByText('You’re logged in.'))).toBeVisible();
  // A new account has no plan: billing says so, header credits read 0.
  await expect(page.getByTestId('plan-status')).toHaveText('Pick a plan to start generating.');
  await expect(page.getByRole('button', { name: /Credit balance: 0 credits/ })).toBeVisible();
});

test('a wrong code is refused inline (INVALID_CODE) and the cells clear', async ({ page }) => {
  const email = freshEmail('wrong');
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  const t0 = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue with email' }).click();
  const code = await codeFor(page.request, email, t0);
  const wrong = code === '000000' ? '111111' : '000000';
  await page.getByLabel('Verification code').locator('input').fill(wrong);
  await expect(page.getByRole('alert')).toHaveText('That code isn’t right. Check the email or resend a new code.');
  await expect(page.getByLabel('Verification code').locator('input')).toHaveValue('');
  await page.getByLabel('Verification code').locator('input').fill(code);
  await expect(page).toHaveURL(/\/$/);
});

test('/upgrade is public: signed out it shows Log in, and choosing a plan goes to sign-up', async ({ page }) => {
  await page.goto('/upgrade');
  await expect(page.getByTestId('header-login')).toBeVisible();
  await page.locator('section[data-plan="plus"]').getByRole('button').first().click();
  await expect(page).toHaveURL(/\/signup\?redirect=%2Fupgrade$/);
});

test('/terms and /privacy load directly while signed out and stay put (registered with Google OAuth)', async ({ page }) => {
  for (const [path, title] of [['/terms', 'Terms of service'], ['/privacy', 'Privacy policy']] as const) {
    const meChecked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me');
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    // The session check (`GET /api/me` → signed out) must not send the visitor to /login.
    await meChecked;
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  await page.goto('/legal/privacy');
  await expect(page).toHaveURL(/\/privacy$/);
});

test('preferences save to the server, survive a new session, and apply live in another tab', async ({ page, context }) => {
  const email = freshEmail('prefs');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/$/);

  // Header settings popover → Theme → Light: PATCH /api/me/prefs.
  const patched = page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: /^Theme:/ }).click();
  await settings.getByRole('menuitemradio', { name: 'Light' }).click();
  expect((await patched).ok()).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect((await me(page)).prefs.theme).toBe('light');

  // Second tab: same browser, same user socket (SharedWorker). A change there arrives here as prefs.changed.
  const other = await context.newPage();
  await other.goto('/settings/preferences');
  await expect(other.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  await other.evaluate(async () => {
    await fetch('/api/me/prefs', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'dark', currency: 'EUR' }) });
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 10_000 });

  // A fresh session (cleared local cache) reads the server copy.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // No currency row: prices are USD only (D-019); the server still stores the field.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /^Currency/ })).toHaveCount(0);
});

test('mature content without a plan is refused by the server and rolled back', async ({ page }) => {
  await signIn(page, freshEmail('mature'));
  await expect(page).toHaveURL(/\/$/);
  const status = await page.evaluate(async () => (await fetch('/api/me/prefs', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{"matureContent":true}' })).status);
  expect(status).toBe(402);
  expect((await me(page)).prefs.matureContent).toBe(false);
});

test('a member sees the plan in the header and billing; team members list; invites need Team (TEAM_REQUIRED → Start Team)', async ({ page }) => {
  await signIn(page, freshEmail('member'));
  await expect(page).toHaveURL(/\/$/);
  const ws = (await me(page)).workspace.id;
  seedPlan(ws, 'pro');
  await page.goto('/settings/billing');
  await expect(page.getByText('Pro, monthly')).toBeVisible();
  await expect(page.locator('[data-badge="pro"]')).toBeVisible();
  await expect(page.getByTestId('ledger')).toContainText('Credit history');

  await page.goto('/settings/team');
  await expect(page.locator('[data-member]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByRole('dialog', { name: 'Start Team to invite people' })).toBeVisible();
  // Stripe is not configured locally: starting Team reports the failure in the dialog.
  await page.getByRole('dialog', { name: 'Start Team to invite people' }).getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog', { name: 'Start Team to invite people' }).getByRole('alert')).toBeVisible();
});

test('top-up checkout errors surface as a toast (no Stripe locally)', async ({ page }) => {
  await signIn(page, freshEmail('topup'));
  await expect(page).toHaveURL(/\/$/);
  seedPlan((await me(page)).workspace.id, 'plus');
  await page.reload();
  await page.getByRole('button', { name: /Credit balance/ }).click();
  await page.getByRole('dialog', { name: 'Credits' }).getByRole('button', { name: /^Top up \$25/ }).click();
  await expect(page.getByRole('status')).toContainText('Payment didn’t go through');
});

test('workspace members and the agent allowance come from the API', async ({ page }) => {
  await signIn(page, freshEmail('allow'));
  await expect(page).toHaveURL(/\/$/);
  seedPlan((await me(page)).workspace.id, 'starter');
  const r = await page.request.get('/api/agent/allowance');
  expect(r.ok()).toBe(true);
  const body = (await r.json()) as { allowanceUsd: number };
  expect(body.allowanceUsd).toBeCloseTo(1.2);
});

test('logout ends the session and app routes go back to /login', async ({ page }) => {
  await signIn(page, freshEmail('logout'));
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Logged out')).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login\?redirect=%2Factivity$/);
});

test('public invite and share links: unknown tokens say so without signing in', async ({ page }) => {
  await page.goto('/invite/not-a-real-token');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Invite not found');
  await page.goto('/share/shr_doesnotexist');
  await expect(page.getByTestId('share-missing')).toBeVisible();
});
