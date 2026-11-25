import { expect, test } from '@playwright/test';
import {
  animationTiming,
  diffScreen,
  expectBoxesClose,
  expectDiffUnder,
  measure,
  openApp,
  openDesign,
  settle,
} from './support/fidelity';

const DESIGN_PARTS = {
  title: 'main h1',
  search: 'main label[for="kq"]',
  stats: 'main > div:nth-child(2)',
  filters: 'main > div:nth-child(3)',
  table: 'main > div:nth-child(4)',
};
const APP_PARTS = {
  title: 'main h1',
  search: 'main label',
  stats: 'main > div > div:nth-child(2)',
  filters: 'main > div > div:nth-child(3)',
  table: 'main > div > div:nth-child(4)',
};

async function pickFilter(page: import('@playwright/test').Page, name: string, design = false) {
  if (design) await page.getByRole('button', { name, exact: true }).first().click();
  else await page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name, exact: true }).click();
}

test.describe('activity (Tasks.dc.html)', () => {
  test('rows show every state: running with progress, queued, done, partial, failed with refund, to review, canceled', async ({ page }) => {
    await openApp(page, '/activity');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity');
    const table = page.getByRole('table', { name: 'Activity' });
    for (const label of ['Generating', 'Queued', 'Done', 'Partial', 'Failed', 'To review', 'Canceled']) {
      await expect(table.getByText(label, { exact: true }).first()).toBeVisible();
    }
    const bar = page.getByRole('progressbar', { name: 'Shot B · Cap pop progress' });
    await expect(bar).toHaveAttribute('aria-valuenow', '58');
    await expect(page.getByRole('note')).toContainText('Refunded 20 credits');
    await expect(table.getByText('Charged 6, refunded 2')).toBeVisible();
    await expect(table.getByText('~8').first()).toBeVisible();
  });

  test('filters narrow the rows and search matches names, ids and models', async ({ page }) => {
    await openApp(page, '/activity');
    const rows = page.locator('[data-run-status]');
    await expect(rows).toHaveCount(9);
    await pickFilter(page, 'Running');
    await expect(rows).toHaveCount(2);
    await pickFilter(page, 'Done');
    await expect(rows).toHaveCount(4);
    await pickFilter(page, 'Failed');
    await expect(rows).toHaveCount(2);
    await pickFilter(page, 'Canceled');
    await expect(rows).toHaveCount(1);
    await pickFilter(page, 'All');
    await page.getByPlaceholder('Search runs, projects or models').fill('wan 2.2');
    await expect(rows).toHaveCount(1);
    await page.getByPlaceholder('Search runs, projects or models').fill('zzz');
    await expect(page.getByText('No runs match these filters.')).toBeVisible();
  });

  test('cancel and retry update the row and show a toast', async ({ page }) => {
    await openApp(page, '/activity');
    await page.getByRole('button', { name: 'Cancel Shot C · Logo' }).click();
    await expect(page.getByText('Canceled “Shot C · Logo”. The held credits were released.')).toBeVisible();
    await page.getByRole('button', { name: 'Retry Two-person original · Table demo' }).click();
    await expect(page.locator('[data-run-status="failed"]')).toHaveCount(0);
  });

  test('box measurements within 2px of the design', async ({ page }) => {
    await openDesign(page, 'Tasks.dc.html');
    const design = await measure(page, DESIGN_PARTS);
    await openApp(page, '/activity');
    await settle(page);
    const app = await measure(page, APP_PARTS);
    expectBoxesClose(app, design);
  });

  for (const f of ['All', 'Running', 'Failed']) {
    test(`filter ${f}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      const r = await diffScreen(page, info, {
        feature: 'activity',
        name: `filter-${f.toLowerCase()}`,
        design: async () => {
          await openDesign(page, 'Tasks.dc.html');
          if (f !== 'All') await pickFilter(page, f, true);
        },
        app: async () => {
          await openApp(page, '/activity');
          if (f !== 'All') await pickFilter(page, f);
        },
      });
      expectDiffUnder(r);
    });
  }

  test('motion: rows stagger 30ms apart (max 6) with 200ms standard enter; reduced motion is opacity only', async ({ page }) => {
    await openApp(page, '/activity');
    await pickFilter(page, 'Done');
    const delays = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-run-status]')).map((el) => getComputedStyle(el).animationDelay),
    );
    expect(delays).toEqual(['0s', '0.03s', '0.06s', '0.09s']);
    const t = await animationTiming(page, '[data-run-status]');
    expect(t?.duration).toBe(200);
    expect(t?.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/activity');
    await page.locator('[data-run-status]').first().waitFor();
    const reduced = await page.evaluate(() => {
      const el = document.querySelector('[data-run-status]')!;
      return { dur: getComputedStyle(el).animationDuration, move: getComputedStyle(el).getPropertyValue('--m-move-sm').trim() };
    });
    expect(reduced.dur).toBe('0.001s');
    expect(reduced.move).toBe('0px');
  });

  test('range menu filters by time, Export downloads a CSV, View opens the result, Locate goes to the source', async ({ page }) => {
    await openApp(page, '/activity');
    const rows = page.locator('[data-run-status]');
    await expect(rows).toHaveCount(9);
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    const menu = page.getByRole('listbox', { name: 'Time range' });
    await menu.getByRole('option', { name: 'Last 24 hours' }).click();
    await expect(menu).toHaveCount(0);
    await expect(rows).toHaveCount(7);
    await page.getByRole('button', { name: 'Last 24 hours' }).click();
    await page.keyboard.press('Escape');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    expect((await dl).suggestedFilename()).toBe('rolling-activity-last24.csv');
    await expect(page.getByText('Exported 7 runs as CSV.')).toBeVisible();
    await page.getByRole('button', { name: 'View Talking head · Desk organizer' }).click();
    await expect(page.getByRole('dialog')).toContainText('Talking head · Desk organizer');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Locate Shot B · Cap pop/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_demo$/);
  });

  test('Retry runs the job to Done and offers View', async ({ page }) => {
    await openApp(page, '/activity');
    await page.getByRole('button', { name: 'Retry Two-person original · Table demo' }).click();
    const row = page.locator('[data-run-status]').filter({ hasText: 'Two-person original · Table demo' });
    await expect(row).toHaveAttribute('data-run-status', 'running');
    await expect(row).toHaveAttribute('data-run-status', 'done', { timeout: 5000 });
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('dialog')).toContainText('Two-person original · Table demo');
  });
});
