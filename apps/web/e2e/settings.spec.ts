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
    await expect(page.getByText('$49 a month. Renews [DATE] with 2,500 bonus credits.')).toBeVisible();
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
