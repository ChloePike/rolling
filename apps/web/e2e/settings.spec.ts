import { expect, test, type Page } from '@playwright/test';
import { animationTiming, diffScreen, expectBoxesClose, expectDiffUnder, measure, openApp, openDesign, settle } from './support/fidelity';

const SECTIONS = [
  { key: 'account', label: 'Account' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'billing', label: 'Plan and billing' },
  { key: 'team', label: 'Team' },
  { key: 'notifications', label: 'Notifications' },
] as const;

const PARTS = {
  nav: 'main nav',
  title: 'main h1',
  heading: 'main h2',
};

async function withMe(page: Page, me: Record<string, unknown>) {
  await page.addInitScript((m) => {
    (window as unknown as { __rollingMocks: unknown }).__rollingMocks = { me: m };
  }, me);
}

test.describe('settings (Settings.dc.html)', () => {
  test('/settings opens billing; nav moves between sections with aria-current', async ({ page }) => {
    await openApp(page, '/settings');
    await expect(page).toHaveURL(/\/settings\/billing$/);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Plan and billing');
    const nav = page.getByRole('navigation', { name: 'Settings' });
    for (const s of SECTIONS) {
      await nav.getByRole('link', { name: s.label }).click();
      await expect(page).toHaveURL(new RegExp(`/settings/${s.key}$`));
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(s.label);
      await expect(nav.getByRole('link', { name: s.label })).toHaveAttribute('aria-current', 'page');
    }
  });

  test('billing: D-006 plan price, credit split, top-up presets with bonus, custom amount validation, auto top-up', async ({ page }) => {
    await openApp(page, '/settings/billing');
    await expect(page.getByText('Pro, monthly')).toBeVisible();
    await expect(page.getByText('$49 a month. Renews Dec 1 with 2,500 bonus credits.')).toBeVisible();
    await expect(page.getByRole('main').getByText('2,480')).toBeVisible();
    // Pro adds 10% to every tier bonus: $25 → 2,500 + 4% + 10%.
    const p25 = page.getByRole('radio', { name: /2,850/ });
    await expect(p25).toHaveAttribute('aria-checked', 'true');
    await expect(p25).toContainText('$25 · +14%');
    await expect(page.getByText('2,500 + 350 bonus = 2,850 credits')).toBeVisible();
    await page.getByRole('radio', { name: /31,250/ }).click();
    await expect(page.getByRole('button', { name: 'Buy 31,250 credits for $250' })).toBeVisible();
    const custom = page.getByLabel('Other amount');
    await custom.fill('5');
    await expect(page.getByRole('alert')).toHaveText('The minimum top-up is $10.');
    await expect(page.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Top up', exact: true })).toBeDisabled();
    await custom.fill('20000');
    await expect(page.getByRole('alert')).toHaveText('The maximum top-up is $10,000.');
    await custom.fill('40');
    await expect(page.getByText('4,000 + 560 bonus = 4,560 credits')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy 4,560 credits for $40' })).toBeEnabled();
    await expect(page.getByText('When credits drop below 200, buy 1,100 for $10 with your saved card')).toBeVisible();
    const sw = page.getByRole('switch', { name: 'Auto top-up' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Top-up, 2,850 credits')).toBeVisible();
  });

  test('preferences: dropdowns, creation mode, and the mature-content switch (default off, paid plan only)', async ({ page }) => {
    await openApp(page, '/settings/preferences');
    await page.getByRole('button', { name: 'Default aspect ratio: 9:16' }).click();
    const list = page.getByRole('listbox', { name: 'Default aspect ratio' });
    await expect(list).toBeVisible();
    await list.getByRole('option', { name: '16:9' }).click();
    await expect(list).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Default aspect ratio: 16:9' })).toBeVisible();
    await page.getByRole('radio', { name: 'Advanced' }).click();
    await expect(page.getByRole('radio', { name: 'Advanced' })).toHaveAttribute('aria-checked', 'true');
    const mature = page.getByRole('switch', { name: 'Mature content' });
    await expect(mature).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Show 18+ models and results to you. Never shown on public pages')).toBeVisible();
    await mature.click();
    await expect(mature).toHaveAttribute('aria-checked', 'true');
  });

  test('preferences: creation mode is shared with the header settings popover (lib/prefs)', async ({ page }) => {
    await openApp(page, '/settings/preferences');
    await page.getByRole('radio', { name: 'Advanced' }).click();
    await page.getByTestId('app-header').getByRole('button', { name: 'Settings' }).click();
    const popover = page.getByRole('dialog', { name: 'Settings' });
    await expect(popover.getByRole('radio', { name: /Advanced/ })).toHaveAttribute('aria-checked', 'true');
    await popover.getByRole('radio', { name: /Simple/ }).click();
    await expect(page.getByRole('radio', { name: 'Simple', exact: true })).toHaveAttribute('aria-checked', 'true');
  });

  test('preferences: no mature-content switch without an active plan or when the workspace turned it off', async ({ page }) => {
    await withMe(page, { plan: null });
    await openApp(page, '/settings/preferences');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Preferences');
    await expect(page.getByRole('switch', { name: 'Mature content' })).toHaveCount(0);
  });

  test('preferences: hidden when the workspace disallows mature content', async ({ page }) => {
    await withMe(page, { workspace: { id: 'ws', name: 'Ridgeline brand team', matureAllowed: false } });
    await openApp(page, '/settings/preferences');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Preferences');
    await expect(page.getByRole('switch', { name: 'Mature content' })).toHaveCount(0);
  });

  test('team and notifications rows', async ({ page }) => {
    await openApp(page, '/settings/team');
    await expect(page.getByText('Ridgeline brand team shares one credit pool.')).toBeVisible();
    for (const t of ['No limit', '1,000 a month', '500 a month', 'View only']) await expect(page.getByText(t)).toBeVisible();
    await page.getByRole('button', { name: /Role for Sam Park/ }).click();
    await page.getByRole('option', { name: 'Viewer' }).click();
    await expect(page.getByText('View only')).toHaveCount(2);
    await openApp(page, '/settings/notifications');
    await expect(page.getByRole('switch', { name: 'Product updates' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Plan renewal' })).toHaveAttribute('aria-checked', 'true');
  });

  test('account: edits validate inline, save with a toast; taken handles refused; bio saves; photo uses a real file chooser', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { delayMs: 150 };
    });
    await openApp(page, '/settings/account');
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    const handle = page.getByLabel('Username');
    await handle.fill('@Bad Name');
    await expect(page.getByTestId('save-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Use 3–30 lowercase letters, numbers, dots or underscores.');
    await handle.fill('@taken');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('That username is taken. Try another.');
    await handle.fill('@alex.makes');
    await page.getByLabel('Bio').fill('Short ads for small brands.');
    await page.getByLabel('Name', { exact: true }).fill('Alex C.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Profile saved.')).toBeVisible();
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await expect(page.getByText('Alex C.', { exact: true })).toBeVisible();

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Change photo' }).click();
    await (await chooser).setFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await expect(page.getByText('Photo updated.')).toBeVisible();
    await expect(page.getByTestId('account-avatar')).toHaveAttribute('style', /background-image/);
  });

  test('account: changing the email asks for the code sent to the new address', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { delayMs: 50 };
    });
    await openApp(page, '/settings/account');
    await page.getByLabel('Email', { exact: true }).fill('alex@new.example');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Confirm your new email' });
    await expect(dlg).toContainText('alex@new.example');
    const confirm = dlg.getByRole('button', { name: 'Confirm email' });
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel('6-digit code').fill('000000');
    await confirm.click();
    await expect(dlg.getByRole('alert')).toHaveText('That code isn’t right. Check the email and try again.');
    await dlg.getByLabel('6-digit code').fill('123456');
    await confirm.click();
    await expect(page.getByText('Your email is now alex@new.example.')).toBeVisible();
    await expect(dlg).toHaveCount(0);
  });

  test('account: manage sign-in keeps one method; delete needs the emailed code and signs out', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { delayMs: 50 };
    });
    await openApp(page, '/settings/account');
    await page.getByRole('button', { name: 'Manage sign-in' }).click();
    const dlg = page.getByRole('dialog', { name: 'Sign-in methods' });
    await dlg.locator('[data-provider="apple"]').getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Apple connected.')).toBeVisible();
    await dlg.locator('[data-provider="google"]').getByRole('button', { name: 'Disconnect' }).click();
    await dlg.locator('[data-provider="apple"]').getByRole('button', { name: 'Disconnect' }).click();
    await expect(dlg.locator('[data-provider="email"]').getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    await expect(dlg.getByText('Keep at least one way to sign in.').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);

    await page.getByRole('button', { name: 'Delete account' }).click();
    const del = page.getByRole('dialog', { name: 'Delete your account?' });
    await del.getByRole('button', { name: 'Email me a code' }).click();
    await expect(del).toContainText('We sent a 6-digit code to');
    const confirm = del.getByRole('button', { name: 'Delete account' });
    await expect(confirm).toBeDisabled();
    await del.getByLabel('6-digit code').fill('000000');
    await confirm.click();
    await expect(del.getByRole('alert')).toHaveText('That code isn’t right. Check the email and try again.');
    await del.getByLabel('6-digit code').fill('424242');
    await confirm.click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('preferences persist through lib/prefs after reload: language, currency, theme, ratio, model, threshold, mature', async ({ page }) => {
    await openApp(page, '/settings/preferences');
    await page.getByRole('button', { name: /^Currency: / }).click();
    await page.getByRole('listbox', { name: 'Currency' }).getByRole('option', { name: /^EUR/ }).click();
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click();
    await page.getByRole('button', { name: /^Default video model: / }).click();
    await page.getByRole('listbox', { name: 'Default video model' }).getByRole('option', { name: 'MiniMax H3' }).click();
    await page.getByRole('button', { name: /^Confirm before running: / }).click();
    await page.getByRole('option', { name: 'Over 1,000 credits' }).click();
    await page.getByRole('button', { name: 'Default aspect ratio: 9:16' }).click();
    await page.getByRole('option', { name: '1:1' }).click();
    await page.getByRole('switch', { name: 'Mature content' }).click();
    await page.getByRole('button', { name: /^Language: / }).click();
    await page.getByRole('option', { name: 'Deutsch' }).click();
    await expect(page.getByText('Text stays in English for now; dates and numbers follow this language')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Currency: EUR' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Default video model: MiniMax H3' })).toBeVisible();
    // German number format after switching the language (text stays English).
    await expect(page.getByRole('button', { name: `Confirm before running: Over ${new Intl.NumberFormat('de').format(1000)} credits` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Default aspect ratio: 1:1' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Mature content' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Language: Deutsch' })).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rolling.prefs') ?? '{}'));
    expect(stored).toMatchObject({ currency: 'EUR', theme: 'light', defaultModel: 'minimax/minimax-h3', confirmThreshold: 1000, defaultAspectRatio: '1:1', matureContent: true });
  });

  test('billing: top-up purchase, cancel and resume, card update with decline, invoice download', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = { delayMs: 150 };
    });
    await openApp(page, '/settings/billing');
    await page.getByRole('button', { name: 'Buy 2,850 credits for $25' }).click();
    await expect(page.getByRole('button', { name: 'Buying…' })).toBeDisabled();
    await expect(page.getByText('2,850 credits added. They never expire.')).toBeVisible();
    await expect(page.getByTestId('balance')).toHaveText('5,330');
    await expect(page.locator('[data-invoice]').first()).toContainText('Top-up, 2,850 credits');

    await page.getByRole('button', { name: 'Cancel plan' }).click();
    const dlg = page.getByRole('dialog', { name: 'Cancel Pro?' });
    await dlg.getByRole('button', { name: 'Cancel plan' }).click();
    await expect(page.getByText('Plan canceled. It stays active until the end of this period.')).toBeVisible();
    await expect(page.getByTestId('plan-status')).toHaveText('Cancels on Dec 1. Your plan and credits stay until then.');
    await page.getByRole('button', { name: 'Resume plan' }).click();
    await expect(page.getByTestId('plan-status')).toContainText('Renews Dec 1');

    await page.getByRole('button', { name: 'Update', exact: true }).click();
    const card = page.getByRole('dialog', { name: 'Update payment method' });
    await card.getByLabel('Card number').fill('4000 0000 0000 0002');
    await card.getByLabel('Expires').fill('09/29');
    await card.getByRole('button', { name: 'Save card' }).click();
    await expect(card.getByRole('alert')).toHaveText('The card was declined. Try another card.');
    await card.getByLabel('Card number').fill('5555 5555 5555 4444');
    await card.getByRole('button', { name: 'Save card' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('card')).toHaveText('Mastercard ending 4444');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download invoice in_3' }).click();
    expect((await download).suggestedFilename()).toBe('rolling-invoice-in_3.txt');
    await expect(page.getByText('Invoice downloaded.')).toBeVisible();
  });

  test('team: invite dialog validates and adds an invited row; limit edit; remove with confirm', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks: Record<string, unknown> }).__rollingMocks = {
        delayMs: 50,
        me: { plan: { id: 'team', period: 'monthly', status: 'active', seats: 10 } },
      };
    });
    await openApp(page, '/settings/team');
    await expect(page.getByText('4 of 10 seats used')).toBeVisible();
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dlg = page.getByRole('dialog', { name: 'Invite a member' });
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Enter an email like name@example.com.');
    await dlg.getByLabel('Email').fill('kai@ridgeline.co');
    await dlg.getByLabel('Monthly credit limit').fill('750');
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('Invite sent to kai@ridgeline.co.')).toBeVisible();
    const kai = page.locator('[data-member]').filter({ hasText: 'kai@ridgeline.co' });
    await expect(kai).toContainText('Invited');
    await expect(kai).toContainText('750 a month');
    await expect(page.getByText('5 of 10 seats used')).toBeVisible();

    await page.getByRole('button', { name: 'Monthly credit limit for Jordan Lee' }).click();
    const lim = page.getByRole('dialog', { name: 'Credit limit for Jordan Lee' });
    await lim.getByLabel('Monthly credit limit').fill('2000');
    await lim.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-member="mem_jordan"]')).toContainText('2,000 a month');

    await expect(page.getByRole('button', { name: 'Remove Alex Chen' })).toBeDisabled();
    await page.getByRole('button', { name: 'Remove Sam Park' }).click();
    await page.getByRole('dialog', { name: 'Remove Sam Park?' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Sam Park was removed.')).toBeVisible();
    await expect(page.locator('[data-member="mem_sam"]')).toHaveCount(0);
  });

  test('notifications persist after reload; “Generation finished” is the header popover’s notify preference', async ({ page }) => {
    await openApp(page, '/settings/notifications');
    await page.getByRole('switch', { name: 'Product updates' }).click();
    await page.getByRole('switch', { name: 'Generation finished' }).click();
    await expect(page.getByText('Generation finished: off')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Product updates' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Generation finished' })).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rolling.prefs') ?? '{}').notifyWhenDone)).toBe(false);
  });

  test('box measurements within 2px of the design (billing)', async ({ page }) => {
    await openDesign(page, 'Settings.dc.html');
    const design = await measure(page, PARTS);
    await openApp(page, '/settings/billing');
    await settle(page);
    const app = await measure(page, PARTS);
    expectBoxesClose(app, design);
  });

  for (const s of SECTIONS) {
    test(`${s.key}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      // The design predates D-005; compare with the mature row hidden. It is captured separately below.
      if (s.key === 'preferences') await withMe(page, { workspace: { id: 'ws', name: 'Ridgeline brand team', matureAllowed: false } });
      const r = await diffScreen(page, info, {
        feature: 'account',
        name: `settings-${s.key}`,
        design: () => openDesign(page, 'Settings.dc.html', { initSection: s.label }),
        app: () => openApp(page, `/settings/${s.key}`),
      });
      // Billing and the confirm threshold carry D-006 prices and amounts instead of the drawn placeholders.
      expectDiffUnder(r, s.key === 'billing' ? 0.03 : 0.01);
    });
  }

  test('preferences with the mature-content row is saved for review', async ({ page }) => {
    await openApp(page, '/settings/preferences');
    await settle(page);
    await page.screenshot({ path: 'e2e/__screens__/account/settings-preferences-mature-app.png' });
  });

  test('motion: section switch enters in 200ms; dropdown pops; reduced motion is opacity only', async ({ page }) => {
    await openApp(page, '/settings/billing');
    await settle(page);
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Team' }).click();
    const t = await animationTiming(page, '[data-testid="settings-section"]');
    expect(t?.duration).toBe(200);
    expect(t?.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(t?.firstTransform).toBe('translateY(4px)');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/settings/billing');
    await settle(page);
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Team' }).click();
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="settings-section"]')!;
      return { dur: getComputedStyle(el).animationDuration, move: getComputedStyle(el).getPropertyValue('--m-move-sm').trim() };
    });
    expect(r.dur).toBe('0.001s');
    expect(r.move).toBe('0px');
  });
});
