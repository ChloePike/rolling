import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support/fidelity';

/**
 * Admin console and the public trust pages (D-025 .. D-029) on the mocks. The
 * server enforces staff and permissions (apps/api/test/admin.test.ts); here we
 * check the pages, their states and the role gating in the UI.
 */
async function asStaff(page: Page, admin: { staff?: boolean; role?: 'admin' | 'reviewer' }, extra: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([a, e]) => {
      const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
      w.__rollingMocks = { ...w.__rollingMocks, admin: a, ...e };
    },
    [admin, extra] as const,
  );
}

test.describe('admin console', () => {
  test('non-staff see not found', async ({ page }) => {
    await asStaff(page, { staff: false });
    await openApp(page, '/admin');
    await expect(page.getByTestId('admin-not-found')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);
  });

  test('overview: totals, daily charts, success rate per model, margin and latency per colo', async ({ page }) => {
    await asStaff(page, { role: 'admin' });
    await openApp(page, '/admin');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    const totals = page.getByTestId('admin-totals');
    for (const label of ['Sign-ups', 'Plan starts', 'Credits revenue', 'Gateway cost', 'Margin']) await expect(totals.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Generations started per day' })).toBeVisible();
    const models = page.getByTestId('admin-models');
    await expect(models.getByRole('row', { name: /seedance-2\.5/ })).toContainText('96.3%');
    await expect(page.getByTestId('admin-latency').getByRole('row', { name: /NRT/ })).toContainText('190 ms');
    await page.getByLabel('Range').selectOption('7');
    await expect(page.getByRole('img', { name: 'Sign-ups per day' }).locator('div')).toHaveCount(7);
  });

  test('accounts: search, workspace detail, credit adjustment with a reason, refund a run', async ({ page }) => {
    await asStaff(page, { role: 'admin' });
    await openApp(page, '/admin/accounts');
    await page.getByLabel('Search', { exact: true }).fill('north');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('link', { name: 'North Studio' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('North Studio');
    await expect(page.getByTestId('balance-purchased')).toHaveText('680');
    const form = page.getByTestId('adjust-form');
    await form.getByLabel('Amount').fill('250');
    await expect(form.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
    await form.getByLabel('Reason').fill('Goodwill for a slow week');
    await form.getByRole('button', { name: 'Apply adjustment' }).click();
    await expect(page.getByTestId('balance-purchased')).toHaveText('930');
    page.once('dialog', (d) => void d.accept('Broken output'));
    await page.getByTestId('admin-runs').getByRole('button', { name: 'Refund' }).click();
    await expect(page.getByTestId('admin-runs').getByRole('row', { name: /Ridgeline/ })).toContainText('347');
    await expect(page.getByTestId('admin-ledger')).toBeVisible();
  });

  test('reviewers get no money, plans or child-safety cases', async ({ page }) => {
    await asStaff(page, { role: 'reviewer' });
    await openApp(page, '/admin/workspaces/ws_p_alex');
    await expect(page.getByTestId('admin-balance')).toBeVisible();
    await expect(page.getByTestId('adjust-form')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Comp plan' })).toHaveCount(0);
    await expect(page.getByTestId('suspend-form')).toBeVisible();
    await openApp(page, '/admin/queue');
    await expect(page.getByTestId('admin-queue').locator('[data-case="child_safety"]')).toHaveCount(0);
    await expect(page.getByTestId('admin-queue').locator('[data-case="report"]')).toHaveCount(1);
  });

  test('queue: urgent child-safety case first; manifest and packet only; reviewer actions on a report', async ({ page }) => {
    await asStaff(page, { role: 'admin' });
    await openApp(page, '/admin/queue');
    const rows = page.getByTestId('admin-queue').locator('tbody tr');
    await expect(rows.first()).toHaveAttribute('data-case', 'child_safety');
    await expect(rows.first()).toContainText('Urgent');
    await rows.first().getByRole('link').click();
    await expect(page.getByRole('note')).toContainText('Submit the report to the NCMEC CyberTipline by hand');
    await expect(page.getByTestId('evidence-manifest').locator('tr')).toHaveCount(2);
    await expect(page.getByTestId('ncmec-packet')).toContainText('apparent_child_pornography');
    await expect(page.locator('img, video')).toHaveCount(0);
    await openApp(page, '/admin/cases/case_rep1');
    const form = page.getByTestId('case-action-form');
    await form.getByLabel('Action').selectOption('warn');
    await form.getByLabel('Reason').fill('Real person, intimate scene');
    await form.getByRole('button', { name: 'Warn the user' }).click();
    await expect(page.getByTestId('case-status')).toHaveText('Actioned');
  });

  test('operations: publish and clear the incident banner; audit log lists actions', async ({ page }) => {
    await asStaff(page, { role: 'admin' });
    await openApp(page, '/admin/ops');
    await expect(page.getByTestId('ops-components').locator('tr')).toHaveCount(4);
    const form = page.getByTestId('incident-form');
    await form.getByLabel('Message').fill('Video renders are slower than usual.');
    await form.getByRole('button', { name: 'Publish banner' }).click();
    await expect(form.getByRole('status')).toHaveText('Done.');
    await openApp(page, '/admin/audit');
    await expect(page.getByTestId('audit-log')).toContainText('credits.grant');
    await expect(page.getByTestId('audit-log')).toContainText('Goodwill for a slow week');
  });
});

test.describe('trust pages', () => {
  test('status page and the app banner when degraded', async ({ page }) => {
    await asStaff(page, {}, { status: { overall: 'degraded', incident: { message: 'Video renders are slower than usual.', level: 'degraded', updatedAt: Date.UTC(2026, 10, 27) } } });
    await openApp(page, '/status');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Status');
    await expect(page.getByTestId('status-overall')).toHaveText('Some systems are slower or partly unavailable.');
    await expect(page.locator('[data-component]')).toHaveCount(4);
    await openApp(page, '/');
    await expect(page.getByTestId('status-banner')).toContainText('Video renders are slower than usual.');
    await expect(page.getByTestId('status-banner').getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/status');
  });

  test('no banner when everything works', async ({ page }) => {
    await openApp(page, '/');
    await expect(page.getByTestId('status-banner')).toHaveCount(0);
  });

  test('suspended: the banner explains and links to the appeal form', async ({ page }) => {
    await asStaff(page, {}, { trust: { suspension: { id: 'sus_1', scope: 'user', since: 1, message: 'Generation and the agent are paused on this account. You can still browse and download your work. You can appeal this decision.' } } });
    await openApp(page, '/');
    const banner = page.getByTestId('suspension-banner');
    await expect(banner).toContainText('You can still browse');
    await banner.getByRole('link', { name: 'Appeal' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appeal a decision');
    await page.getByLabel('Your appeal').fill('The prompt was about a statue.');
    await page.getByRole('button', { name: 'Send appeal' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appeal sent');
  });

  test('report from a share page lands with its target', async ({ page }) => {
    await openApp(page, '/share/shr_01RIDGE');
    await page.getByRole('link', { name: 'Report' }).click();
    await expect(page.getByTestId('report-target')).toHaveText('Shared project shr_01RIDGE');
    await page.getByLabel('What’s wrong').selectOption('child_safety');
    await expect(page.getByRole('note')).toContainText('report.cybertip.org');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Report sent');
  });

  test('DMCA notice requires the statements', async ({ page }) => {
    await openApp(page, '/dmca');
    await page.getByLabel('Your full name', { exact: true }).fill('Rights Holder');
    await page.getByLabel('Email').fill('rights@example.com');
    await page.getByLabel('Phone').fill('+1 555 0100');
    await page.getByLabel('Postal address').fill('1 Main St');
    await page.getByLabel('The copyrighted work').fill('My photo series');
    await page.getByLabel('Links to the material on Rolling (one per line)').fill('https://rolling.actor/share/shr_1');
    await page.getByLabel('Signature (type your full name)').fill('Rights Holder');
    await page.getByRole('button', { name: 'Send notice' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Copyright takedown notice');
    await page.getByText('I have a good-faith belief').click();
    await page.getByText('under penalty of perjury, I am the owner').click();
    await page.getByRole('button', { name: 'Send notice' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notice received');
  });
});
