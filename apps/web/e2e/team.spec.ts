import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { animationTiming, openApp, settle } from './support/fidelity';
import { asPlan } from './support/session';

/** D-013 Team: the /upgrade calculator and the Settings → Team dialogs (mock flows). */
const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
const SCREENS = fileURLToPath(new URL('./__screens__/account/', import.meta.url));

async function fast(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
    w.__rollingMocks = { ...w.__rollingMocks, delayMs: 50, latencyMs: 250 };
  });
}

test.describe('Team plan (D-013)', () => {
  test('upgrade: Team calculator — seat stepper, live monthly and yearly totals, what seats add', async ({ page }) => {
    await fast(page);
    await openApp(page, '/upgrade');
    const team = page.locator('section[data-plan="team"]');
    await expect(team.getByRole('heading', { name: 'Team' })).toBeVisible();
    const seats = team.getByRole('spinbutton', { name: 'Seats' });
    await expect(seats).toHaveValue('3');
    await expect(team.getByTestId('team-total')).toHaveText('$129 a month');
    await expect(team.getByTestId('team-breakdown')).toContainText('2 extra seats × $25');
    await expect(team.getByTestId('team-gets')).toContainText('3,500 shared credits a month');
    await expect(team.getByTestId('team-gets')).toContainText('14 jobs at a time');
    await expect(team.getByTestId('team-gets')).toContainText('$18.50 of agent use a month');

    await team.getByRole('button', { name: 'More seats' }).click();
    await expect(seats).toHaveValue('4');
    await expect(team.getByTestId('team-total')).toHaveText('$154 a month');
    const t = await animationTiming(page, '[data-testid="team-total"] [data-swap] > :not([aria-hidden])');
    expect(t).toMatchObject({ duration: 200, easing: STANDARD });

    await page.getByRole('tab', { name: /Yearly/ }).click();
    await expect(team.getByTestId('team-total')).toContainText('$1,478 a year');
    await expect(team.getByTestId('team-total')).toContainText('$123.17 a month, billed yearly');
    await expect(team.getByTestId('team-breakdown')).toContainText('3 extra seats × $240');

    // Keyboard and typing: arrows step, the field clamps; jobs cap at 30.
    await seats.focus();
    await page.keyboard.press('ArrowDown');
    await expect(seats).toHaveValue('3');
    await seats.fill('20');
    await expect(team.getByTestId('team-gets')).toContainText('30 jobs at a time');
    await seats.fill('1');
    await expect(team.getByRole('button', { name: 'Fewer seats' })).toBeDisabled();
    await expect(team.getByTestId('team-breakdown')).toContainText('0 extra seats');
  });

  test('upgrade: a non-member starts Team; the card turns into the current plan and links to seats', async ({ page }) => {
    await fast(page);
    await asPlan(page, null);
    await openApp(page, '/upgrade');
    const team = page.locator('section[data-plan="team"]');
    await team.getByRole('button', { name: 'More seats' }).click();
    await team.getByRole('button', { name: 'Start Team' }).click();
    await expect(team.getByRole('button', { name: 'Opening checkout…' })).toBeDisabled();
    await expect(page.getByText('You’re on Team with 4 seats.')).toBeVisible();
    await expect(team.getByText('Current plan')).toBeVisible();
    await team.getByRole('button', { name: 'Manage seats' }).click();
    await expect(page).toHaveURL(/\/settings\/team$/);
    await expect(page.getByTestId('team-seats')).toHaveText('4 of 4 seats used');
  });

  test('upgrade: a Pro member sees Switch to Team; personal cards no longer offer seats', async ({ page }) => {
    await openApp(page, '/upgrade');
    await expect(page.locator('section[data-plan="team"]').getByRole('button', { name: 'Switch to Team' })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="plan-pro"]')).not.toContainText('seats');
    await page.getByRole('button', { name: 'How do Team seats work?' }).click();
    await expect(page.getByRole('region', { name: 'How do Team seats work?' })).toContainText('Each extra seat is $25 a month');
  });

  test('settings: inviting on a personal plan opens “Start Team to invite people”, then the invite resumes', async ({ page }) => {
    await fast(page);
    await openApp(page, '/settings/team');
    await expect(page.getByTestId('team-seats')).toHaveText('4 people. Inviting needs Team.');
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dlg = page.getByRole('dialog', { name: 'Start Team to invite people' });
    await expect(dlg).toBeVisible();
    const seats = dlg.getByRole('spinbutton', { name: 'Seats' });
    // Everyone already here plus the person being invited.
    await expect(seats).toHaveValue('5');
    await expect(dlg.getByTestId('team-total')).toHaveText('$179 a month');
    await dlg.getByRole('button', { name: 'Fewer seats' }).click();
    await expect(seats).toHaveValue('4');
    await expect(dlg.getByRole('button', { name: 'Fewer seats' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'More seats' }).click();
    await dlg.getByRole('radio', { name: 'Yearly' }).click();
    await expect(dlg.getByTestId('team-total')).toContainText('$1,718 a year');
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await expect(dlg.getByRole('button', { name: 'Opening checkout…' })).toBeDisabled();
    await expect(page.getByText('You’re on Team with 5 seats.')).toBeVisible();
    const invite = page.getByRole('dialog', { name: 'Invite a member' });
    await expect(invite).toBeVisible();
    await invite.getByLabel('Email').fill('kai@ridgeline.co');
    await invite.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('Invite sent to kai@ridgeline.co.')).toBeVisible();
    await expect(page.getByTestId('team-seats')).toHaveText('5 of 5 seats used');
  });

  test('settings: a failed Team payment keeps the dialog open with the reason', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { delayMs: 50, latencyMs: 50, checkout: 'fail' };
    });
    await openApp(page, '/settings/team');
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dlg = page.getByRole('dialog', { name: 'Start Team to invite people' });
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Payment didn’t go through. Nothing was charged.');
    await expect(page.getByTestId('team-seats')).toHaveText('4 people. Inviting needs Team.');
  });

  test('settings on Team: invite beyond seats opens “Add seats” with the prorated amount; lower seats', async ({ page }) => {
    await fast(page);
    await asPlan(page, 'team', 4);
    await openApp(page, '/settings/team');
    await expect(page.getByTestId('team-seats')).toHaveText('4 of 4 seats used');
    await page.getByRole('button', { name: 'Invite member' }).click();
    const add = page.getByRole('dialog', { name: 'Add seats' });
    await expect(add).toBeVisible();
    await expect(add.getByRole('spinbutton', { name: 'Seats' })).toHaveValue('5');
    await expect(add.getByTestId('seats-due')).toHaveText(/^\$\d+(\.\d\d)?$/);
    await expect(add.getByTestId('seats-due')).not.toHaveText('$0');
    await expect(add.getByTestId('seats-next')).toHaveText('$179 a month');
    await expect(add.getByTestId('team-gets')).toContainText('4,500 shared credits a month');
    await add.getByRole('button', { name: 'Add 1 seat' }).click();
    await expect(page.getByText(/^5 seats now\. [\d,]+ credits added\.$/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Invite a member' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Invite a member' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('team-seats')).toHaveText('4 of 5 seats used');

    // Lowering: not below the people in the workspace; no refund note.
    await page.getByRole('button', { name: 'Change seats' }).click();
    const change = page.getByRole('dialog', { name: 'Change seats' });
    const seats = change.getByRole('spinbutton', { name: 'Seats' });
    await change.getByRole('button', { name: 'Fewer seats' }).click();
    await change.getByRole('button', { name: 'Fewer seats' }).click();
    await expect(seats).toHaveValue('4');
    await expect(change.getByRole('button', { name: 'Fewer seats' })).toBeDisabled();
    await expect(change).toContainText('There’s no refund for this period');
    await expect(change.getByTestId('seats-due')).toHaveText('$0');
    await change.getByRole('button', { name: 'Lower to 4 seats' }).click();
    await expect(page.getByText('Lowered to 4 seats.')).toBeVisible();
    await expect(page.getByTestId('team-seats')).toHaveText('4 of 4 seats used');
  });

  test('reduced motion: Team values and dialogs fade only', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/upgrade');
    await settle(page);
    const team = page.locator('section[data-plan="team"]');
    await team.getByRole('button', { name: 'More seats' }).click();
    const t = await animationTiming(page, '[data-testid="team-total"] [data-swap] > :not([aria-hidden])');
    if (t) expect(t.firstTransform).toMatch(/^(none|translateY\(0px\))$/);
    await expect(team.getByTestId('team-total')).toHaveText('$154 a month');
  });

  test('screenshots: Team card and both dialogs', async ({ page }) => {
    mkdirSync(SCREENS, { recursive: true });
    await fast(page);
    await openApp(page, '/upgrade');
    await settle(page);
    await page.locator('section[data-plan="team"]').screenshot({ path: `${SCREENS}team-card.png` });
    await openApp(page, '/settings/team');
    await page.getByRole('button', { name: 'Invite member' }).click();
    await settle(page);
    await page.screenshot({ path: `${SCREENS}team-start-dialog.png` });
  });
});
