import { expect, test } from '@playwright/test';
import { codeFor, freshEmail, signIn } from './support';

/**
 * Profile, email change, feedback and account deletion against the real local
 * Worker (playwright.account-real.config.ts): `PATCH /api/me/profile`,
 * `GET /api/profiles/:handle`, Better Auth email-change codes and the
 * delete-account code from the test inbox, `POST /api/feedback`.
 */

const uniqueHandle = (tag: string) => `${tag}_${Date.now().toString(36)}`.slice(0, 30);

test('username and bio save; reserved handles are refused; the public profile shows them with empty states', async ({ page, browser }) => {
  await signIn(page, freshEmail('handle'));
  await expect(page).toHaveURL(/\/$/);

  // Without a handle the own profile asks to pick one.
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page.getByTestId('profile-empty')).toContainText('Pick a username to get a public profile.');

  await page.goto('/settings/account');
  const handleField = page.getByLabel('Username');
  await handleField.fill('@admin');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('That username is taken. Try another.');
  const handle = uniqueHandle('maker');
  await handleField.fill(`@${handle}`);
  await page.getByLabel('Bio').fill('Short ads for small brands.');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/me/profile') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('Profile saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(new RegExp(`/u/${handle}$`));
  await expect(page.getByText(`@${handle}`)).toBeVisible();
  await expect(page.getByText('Short ads for small brands.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit profile' })).toBeVisible();
  await expect(page.getByTestId('profile-empty')).toContainText('In a project, open Share and turn on Publish to profile.');

  // Someone else (signed out) sees the public page without the owner's controls.
  const other = await browser.newPage();
  await other.goto(`/u/${handle.toUpperCase()}`);
  await expect(other.getByText(`@${handle}`)).toBeVisible();
  await expect(other.getByRole('link', { name: 'Edit profile' })).toHaveCount(0);
  await expect(other.getByTestId('profile-empty')).toHaveText('Nothing published yet.');
  await other.goto('/u/nobody_here_at_all');
  await expect(other.getByTestId('profile-unavailable')).toBeVisible();
  await other.close();
});

test('changing the email sends a code to the new address and switches the account', async ({ page }) => {
  await signIn(page, freshEmail('chg'));
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/settings/account');
  const next = freshEmail('chg-new');
  const t0 = Date.now() - 1000;
  await page.getByLabel('Email', { exact: true }).fill(next);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Confirm your new email' });
  await expect(dlg).toContainText(next);
  const code = await codeFor(page.request, next, t0);
  await dlg.getByLabel('6-digit code').fill(code);
  await dlg.getByRole('button', { name: 'Confirm email' }).click();
  await expect(page.getByText(`Your email is now ${next}.`)).toBeVisible();
  const me = (await (await page.request.get('/api/me')).json()) as { user: { email: string } };
  expect(me.user.email).toBe(next);
});

test('Help → feedback posts to the API with the page and kind', async ({ page }) => {
  await signIn(page, freshEmail('fb'));
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Help and feedback' }).click();
  const help = page.getByRole('dialog', { name: 'Help and feedback' });
  await help.getByRole('radio', { name: 'Idea' }).click();
  await help.getByRole('textbox', { name: 'Feedback' }).fill('A snapping grid on the timeline would help.');
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/feedback') && r.method() === 'POST');
  await help.getByRole('button', { name: 'Send feedback' }).click();
  const req = await sent;
  expect(req.postDataJSON()).toMatchObject({ kind: 'idea', message: 'A snapping grid on the timeline would help.', page: '/', includeDiagnostics: true });
  expect((await req.response())?.status()).toBe(201);
  await expect(page.getByRole('status')).toContainText('Feedback sent. Thank you.');
});

test('delete account: emailed code, wrong code refused, then the account is gone', async ({ page }) => {
  const email = freshEmail('del');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Delete account' }).click();
  const del = page.getByRole('dialog', { name: 'Delete your account?' });
  const t0 = Date.now() - 1000;
  await del.getByRole('button', { name: 'Email me a code' }).click();
  await expect(del).toContainText(`We sent a 6-digit code to ${email}`);
  const code = await codeFor(page.request, email, t0);
  await del.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await del.getByRole('button', { name: 'Delete account' }).click();
  await expect(del.getByRole('alert')).toHaveText('That code isn’t right. Check the email and try again.');
  await del.getByLabel('6-digit code').fill(code);
  await del.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
