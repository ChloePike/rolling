import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApp, settle } from './support/fidelity';

/**
 * Public routes (mock API): the invite landing `/invite/$token` and the
 * read-only share viewer `/share/$id`. The real-API versions of these flows
 * are in e2e/real (local Worker).
 */
const SCREENS = fileURLToPath(new URL('./__screens__/account/', import.meta.url));

test.describe('invite landing /invite/$token', () => {
  test('pending invite for the signed-in email: Join switches workspace and goes Home', async ({ page }) => {
    await openApp(page, '/invite/tok_pending');
    const card = page.getByTestId('invite');
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card.getByRole('heading', { level: 1 })).toHaveText('Join Ridgeline brand team');
    await expect(card).toContainText('Jordan Lee invited you as an editor.');
    await expect(page.getByTestId('invite-meta')).toContainText('Invite for alex@ridgeline.co');
    await expect(page.getByTestId('app-header')).toHaveCount(0);
    mkdirSync(SCREENS, { recursive: true });
    await settle(page);
    await page.screenshot({ path: `${SCREENS}invite-pending.png` });
    await card.getByRole('button', { name: 'Join Ridgeline brand team' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('You joined Ridgeline brand team.')).toBeVisible();
  });

  test('another email: says so and offers to log in with another email', async ({ page }) => {
    await openApp(page, '/invite/other');
    await expect(page.getByTestId('invite-mismatch')).toHaveText('This invite is for sam@ridgeline.co. You’re logged in as alex@ridgeline.co.');
    await page.getByRole('button', { name: 'Log in with another email' }).click();
    await expect(page).toHaveURL(/\/login\?redirect=%2Finvite%2Fother$/);
  });

  test('no free seat on accept shows the reason inline', async ({ page }) => {
    await openApp(page, '/invite/full');
    await page.getByRole('button', { name: 'Join Ridgeline brand team' }).click();
    await expect(page.getByRole('alert')).toHaveText('The workspace has no free seat right now. Ask Jordan Lee to add one.');
  });

  for (const [token, title] of [
    ['expired', 'This invite has expired'],
    ['revoked', 'This invite was withdrawn'],
    ['accepted', 'This invite was already used'],
    ['missing', 'Invite not found'],
  ] as const) {
    test(`${token} link: ${title}; Go to Home works`, async ({ page }) => {
      await openApp(page, `/invite/${token}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await page.getByRole('link', { name: 'Go to Home' }).click();
      await expect(page).toHaveURL(/\/$/);
    });
  }
});

test.describe('share viewer /share/$id', () => {
  test('renders the snapshot read-only with wires and downloads; mature nodes never show', async ({ page }) => {
    await openApp(page, '/share/shr_demo');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ridgeline Sparkling, 15s');
    const board = page.getByTestId('share-board');
    await expect(board.locator('[data-node]')).toHaveCount(5);
    await expect(board.locator('[data-node="node_6"]')).toHaveCount(0);
    await expect(board.locator('path')).toHaveCount(4);
    await expect(page.getByText('5 items · Shared')).toBeVisible();
    await expect(page.getByTestId('app-header')).toHaveCount(0);
    await page.getByRole('link', { name: 'Open Rolling' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a revoked or unknown link says so', async ({ page }) => {
    await openApp(page, '/share/shr_missing');
    await expect(page.getByTestId('share-missing')).toContainText('This link isn’t available');
  });
});
