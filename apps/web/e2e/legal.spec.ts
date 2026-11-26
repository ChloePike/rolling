import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support/fidelity';
import { asPlan } from './support/session';

const DOCS = [
  { path: '/terms', title: 'Terms of service', nav: 'Terms' },
  { path: '/privacy', title: 'Privacy policy', nav: 'Privacy' },
  { path: '/acceptable-use', title: 'Acceptable use policy', nav: 'Acceptable use' },
  { path: '/subprocessors', title: 'Subprocessors', nav: 'Subprocessors' },
] as const;

/** Signed out: every API call answers 401 (no session), as the real Worker does for a visitor without a cookie. */
async function signedOut(page: Page) {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }) }),
  );
}

test.describe('legal pages', () => {
  for (const d of DOCS) {
    test(`${d.path} renders the document with a table of contents`, async ({ page }) => {
      await openApp(page, d.path);
      await expect(page).toHaveURL(new RegExp(`${d.path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(d.title);
      await expect(page.getByRole('note')).toContainText('Draft for legal review — not yet in effect.');
      await expect(page).toHaveTitle(`${d.title} · Rolling`);
      const nav = page.getByRole('navigation', { name: 'Legal' });
      await expect(nav.getByRole('link', { name: d.nav })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('app-header')).toHaveCount(0);
    });
  }

  test('table of contents jumps to a section; documents link to each other', async ({ page }) => {
    await openApp(page, '/privacy');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await toc.getByRole('link', { name: 'Your rights' }).click();
    await expect(page).toHaveURL(/\/privacy#your-rights$/);
    await expect(page.locator('#your-rights')).toBeInViewport();
    await expect(page.locator('[data-placeholder]').first()).toBeVisible();
    await page.locator('article').getByRole('link', { name: 'Subprocessors' }).first().click();
    await expect(page).toHaveURL(/\/subprocessors$/);
    await expect(page.getByRole('table').first()).toBeVisible();
    await page.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Terms' }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });

  test('old /legal/<doc> paths redirect to the canonical path', async ({ page }) => {
    await openApp(page, '/legal/privacy');
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
    await openApp(page, '/legal/acceptable-use');
    await expect(page).toHaveURL(/\/acceptable-use$/);
  });

  test('signed out: /terms and /privacy load directly and stay put', async ({ page }) => {
    await signedOut(page);
    for (const d of DOCS.slice(0, 2)) {
      await openApp(page, d.path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(d.title);
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(new RegExp(`${d.path}$`));
    }
  });

  test('links from log in, sign up and the plans page', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, '/signup');
    await page.getByRole('link', { name: 'Privacy Policy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await openApp(page, '/upgrade');
    const foot = page.getByTestId('legal-links');
    await expect(foot.getByRole('link')).toHaveText(['Terms', 'Privacy Policy', 'Acceptable use']);
    await foot.getByRole('link', { name: 'Acceptable use' }).click();
    await expect(page).toHaveURL(/\/acceptable-use$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Acceptable use policy');
  });

  test('Help dialog and the delete-account dialog link the legal pages', async ({ page }) => {
    await openApp(page, '/');
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Help and feedback' }).click();
    const help = page.getByRole('dialog', { name: 'Help and feedback' });
    await help.getByRole('link', { name: 'Subprocessors' }).click();
    await expect(page).toHaveURL(/\/subprocessors$/);
    await expect(help).toHaveCount(0);

    await openApp(page, '/settings/account');
    await page.getByRole('button', { name: 'Delete account' }).click();
    const del = page.getByRole('dialog', { name: 'Delete your account?' });
    await del.getByRole('link', { name: 'Privacy Policy' }).click();
    await expect(page).toHaveURL(/\/privacy#when-you-delete-your-account$/);
    await expect(page.locator('#when-you-delete-your-account')).toBeInViewport();
  });
});
