import { expect, test } from '@playwright/test';
import { api, apiSignIn, codeFor, env, errorCode, freshEmail, getJson, originOf, shot, watchErrors } from './support';

/** Matrix: AUTH-1 … AUTH-8 (docs/test-matrix.md). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

async function uiEmailStep(page: import('@playwright/test').Page, email: string) {
  await page.getByLabel('Email').fill(email);
  const sentAt = Date.now();
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  return sentAt;
}

test('AUTH-1 email-code sign-up through the UI creates the account, a personal workspace and lands Home', async ({ page }, testInfo) => {
  const errs = watchErrors(page);
  const email = freshEmail('signup');
  await page.goto('/signup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your account');
  const sentAt = await uiEmailStep(page, email);
  await expect(page.getByText(`We sent a 6-digit code to ${email}`)).toBeVisible();
  const code = await codeFor(page.request, email, sentAt);
  await page.getByLabel('Verification code').locator('input').fill(code);
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByTestId('app-header')).toBeVisible();
  await expect(page.getByText(/Your account is ready|You’re logged in/)).toBeVisible();
  const me = await getJson<{ user: { email: string }; workspace: { kind: string }; role: string }>(page.request, '/api/me');
  expect(me.user.email).toBe(email);
  expect(me.workspace.kind).toBe('personal');
  expect(me.role).toBe('owner');
  await shot(page, testInfo, 'signed-up-home');
  errs.assertClean();
});

test('AUTH-2 sign-in with a wrong code shows the inline error; the right code signs in', async ({ page, baseURL }) => {
  const email = freshEmail('signin');
  // Create the account first (API), then sign out by dropping cookies.
  await apiSignIn(page.request, email, baseURL);
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  // Resend cooldown (AUTH-3) means the API sign-in above blocks a new code for 30 s.
  await page.waitForTimeout(31_000);
  const sentAt = await uiEmailStep(page, email);
  const code = await codeFor(page.request, email, sentAt);
  const wrong = code === '000000' ? '111111' : '000000';
  await page.getByLabel('Verification code').locator('input').fill(wrong);
  await expect(page.getByRole('alert')).toContainText('That code isn’t right');
  await page.getByLabel('Verification code').locator('input').fill(code);
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByTestId('app-header')).toBeVisible();
});

test('AUTH-3 resend cooldown: the UI counts down from 0:30 and the API answers 429 with retryAfter', async ({ page, baseURL }) => {
  const email = freshEmail('cooldown');
  await page.goto('/login');
  await uiEmailStep(page, email);
  await expect(page.getByRole('button', { name: /Resend in 0:(30|29|28)/ })).toBeDisabled();
  const again = await api(page.request, baseURL, 'POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  expect(again.status()).toBe(429);
  const body = (await again.json()) as { error: { code: string; data?: { retryAfter?: number } } };
  expect(body.error.code).toBe('RATE_LIMITED');
  expect(body.error.data?.retryAfter).toBeGreaterThan(0);
  expect(body.error.data?.retryAfter).toBeLessThanOrEqual(30);
});

test('AUTH-4 sign-out from the account menu ends the session', async ({ page, baseURL }) => {
  await apiSignIn(page.request, freshEmail('signout'), baseURL);
  await page.goto('/');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).or(page.getByRole('button', { name: 'Log out' })).first().click();
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  expect((await page.request.get('/api/me')).status()).toBe(401);
  // App routes now bounce to /login.
  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login\?redirect=/);
});

test('AUTH-5 Google (API level, stubbed tokens): providers, nonce, start redirect, bad tokens refused cleanly', async ({ request, baseURL }) => {
  const origin = originOf(baseURL);
  const providers = await getJson<{ emailCode: boolean; google: false | { clientId: string; loginUri: string } }>(request, '/api/auth/providers');
  expect(providers.emailCode).toBe(true);
  expect(providers.google, 'GOOGLE_CLIENT_ID configured').toBeTruthy();
  if (providers.google) {
    expect(providers.google.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(providers.google.loginUri).toBe(`${origin}/api/auth/google/credential`);
  }
  const nonce = await request.get('/api/auth/nonce');
  expect(nonce.status()).toBe(200);
  expect(nonce.headers()['cache-control']).toContain('no-store');
  expect(((await nonce.json()) as { nonce: string }).nonce.length).toBeGreaterThan(16);

  const start = await request.get('/api/auth/google/start?redirect=/activity', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const loc = new URL(start.headers()['location']!);
  expect(loc.host).toBe('accounts.google.com');
  expect(loc.searchParams.get('response_type')).toBe('id_token');
  expect(loc.searchParams.get('response_mode')).toBe('form_post');
  expect(loc.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/google/credential`);
  expect(start.headers()['set-cookie'] ?? '').toContain('rolling.g_state');

  // A stubbed access token: Google's tokeninfo rejects it → 4xx, never 5xx, no session.
  const access = await request.post('/api/auth/google/access-token', { data: { accessToken: 'ya29.stub-not-a-real-token' }, headers: { origin } });
  expect(access.status(), await access.text()).toBeGreaterThanOrEqual(400);
  expect(access.status()).toBeLessThan(500);
  // A stubbed ID token (One Tap): bad signature / nonce → 4xx.
  const fakeJwt = ['eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'x', sub: '1', email: 'a@b.c', exp: 9999999999 })).toString('base64url'), 'sig'].join('.');
  const social = await request.post('/api/auth/sign-in/social', { data: { provider: 'google', idToken: { token: fakeJwt, nonce: 'n' } }, headers: { origin } });
  expect(social.status(), await social.text()).toBeGreaterThanOrEqual(400);
  expect(social.status()).toBeLessThan(500);
  // The form-post endpoint without the double-submit token is refused (no 5xx).
  const cred = await request.post('/api/auth/google/credential', { form: { credential: fakeJwt, g_csrf_token: 'x' }, maxRedirects: 0 });
  expect(cred.status()).toBeLessThan(500);
  expect((await request.get('/api/me')).status()).toBe(401);
});

test('AUTH-6 the login page shows the designed Google button (our own, not Google’s iframe)', async ({ page }) => {
  await page.goto('/login');
  const g = page.getByTestId('google-button');
  await expect(g).toBeVisible();
  await expect(g).toHaveText(/Continue with Google/);
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toHaveCount(0);
  await expect(page.locator('iframe[src*="accounts.google.com/gsi/button"]')).toHaveCount(0);
});

test('AUTH-7 session expiry: a dead session cookie on an app route goes to /login?redirect= and returns after sign-in', async ({ page, baseURL }) => {
  const email = freshEmail('expiry');
  await apiSignIn(page.request, email, baseURL);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes('session_token'));
  expect(session, 'session cookie set').toBeTruthy();
  // Server-side expiry: the token no longer matches a session row.
  await page.context().clearCookies();
  await page.context().addCookies([{ ...session!, value: 'expired.invalid-token-value' }]);
  await page.goto('/settings/notifications');
  await expect(page).toHaveURL(/\/login\?redirect=/, { timeout: 20_000 });
  expect(decodeURIComponent(page.url())).toContain('/settings/notifications');
  await page.waitForTimeout(31_000); // resend cooldown after the API sign-in above
  const sentAt = await uiEmailStep(page, email);
  await page.getByLabel('Verification code').locator('input').fill(await codeFor(page.request, email, sentAt));
  await expect(page).toHaveURL(/\/settings\/notifications$/, { timeout: 30_000 });
});

test('AUTH-8 redirect param: same-site paths are honoured, off-site ones are ignored', async ({ page, baseURL }) => {
  await apiSignIn(page.request, freshEmail('redirect'), baseURL);
  await page.goto('/login?redirect=%2Factivity');
  await expect(page).toHaveURL(/\/activity$/);
  await page.goto('/login?redirect=https%3A%2F%2Fevil.example.com%2F');
  await expect(page).toHaveURL(new RegExp(`^${originOf(baseURL)}/$`));
  await page.goto('/login?redirect=%2F%2Fevil.example.com');
  await expect(page).toHaveURL(new RegExp(`^${originOf(baseURL)}/$`));
});

test('AUTH-9 the API refuses unauthenticated calls with 401 UNAUTHENTICATED', async ({ request }) => {
  for (const path of ['/api/me', '/api/billing', '/api/projects', '/api/runs']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(401);
    expect(await errorCode(r)).toBe('UNAUTHENTICATED');
  }
});
