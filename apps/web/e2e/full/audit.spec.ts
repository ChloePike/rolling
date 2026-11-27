import { expect, test } from '@playwright/test';
import { account, env, getJson, openCanvas, SAMPLE_OPS, seedProject, shot, watchErrors } from './support';

/**
 * Matrix: UX-1 … UX-8. The UX interaction audit fixes (docs/ux-audit.md, 36 items) on staging. Items covered
 * elsewhere: #1 and #14 (HOME-3), #3 and #4 (AGENT-7), #9 and #31 (UPG-4), #17 and #36 (HOME-2), #26 (PROMPT-2),
 * #28 (HOME-1), #35 is visual only. Nothing here spends credits.
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

test('UX-1 canvas (#7, #8, #33): an empty canvas offers Add a node and Start from a template; Run all has no “~0” chip; no Director in the tool rail', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'uxcanvas', 'plus');
  const errs = watchErrors(page);
  const p = await seedProject(page.request, baseURL, 'Empty', []);
  await openCanvas(page, p.id);
  const empty = page.getByTestId('canvas-empty');
  await expect(empty).toContainText('Empty canvas');
  await expect(page.getByRole('textbox', { name: 'Tell the agent' })).toHaveAttribute('placeholder', /^Describe the video\./);
  await expect(page.getByText('~0', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button', { name: /Director/ })).toHaveCount(0);
  await shot(page, testInfo, 'empty-canvas');
  await empty.getByRole('button', { name: 'Add a node' }).click();
  await expect(page.getByPlaceholder(/Search, or type a request/)).toBeVisible();
  await page.keyboard.press('Escape');
  await empty.getByRole('button', { name: 'Start from a template' }).click();
  await expect(page.getByRole('button', { name: 'Workflows and templates', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // A canvas with nodes: no empty card; nodes that never ran say Generate in the Run all dialog (#6).
  const q = await seedProject(page.request, baseURL, 'Run all', SAMPLE_OPS);
  await openCanvas(page, q.id);
  await expect(page.getByTestId('canvas-empty')).toHaveCount(0);
  await page.getByRole('button', { name: /^Run all/ }).first().click();
  const dlg = page.getByRole('dialog').filter({ hasText: /credits/ }).first();
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  // Wait for the server quote (the dialog shows zeros until it lands, see the report).
  await expect(dlg.getByText('Generate', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(dlg).not.toContainText('Regenerate');
  await expect(dlg).not.toContainText(/Script ·\s*$/m);
  await shot(page, testInfo, 'run-all');
  await page.keyboard.press('Escape');
  errs.assertClean();
});

test('UX-2 empty states with a next step (#19, #20, #21, #24): Templates “Clear search and filters”, Assets Upload, Activity “Start creating”, unknown profile “Go to Home”', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'uxempty');
  await page.goto('/templates');
  const search = page.getByPlaceholder(/Search templates/);
  await expect(search).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^0 roles?$/)).toHaveCount(0);
  await search.fill('zzzzqqq');
  await expect(page.getByText(/^0 templates/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('[data-template]').first()).toBeVisible();

  await page.goto('/assets');
  await expect(page.getByRole('main').getByRole('button', { name: /^Upload/ }).first()).toBeVisible({ timeout: 20_000 });

  await page.goto('/activity');
  const start = page.getByRole('main').getByRole('link', { name: 'Start creating' }).or(page.getByRole('main').getByRole('button', { name: 'Start creating' }));
  await expect(start.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/down 0%|about 0 min/)).toHaveCount(0);

  await page.goto(`/u/nobody${Date.now().toString(36)}`);
  await page.getByRole('link', { name: 'Go to Home' }).or(page.getByRole('button', { name: 'Go to Home' })).first().click();
  await expect(page).toHaveURL(/\/$/);
});

test('UX-3 short windows (#12, #13): at 1280×720 the header is one row and the tool composer is on screen', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'uxsmall', 'plus');
  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/create/quick');
    const header = page.getByTestId('app-header');
    await expect(header).toBeVisible({ timeout: 20_000 });
    expect((await header.boundingBox())!.height, `header height at ${width}`).toBeLessThanOrEqual(76);
    const box = (await page.getByTestId('tool-composer').boundingBox())!;
    expect(box.y + box.height, `composer bottom at ${width}×${height}`).toBeLessThanOrEqual(height);
  }
});

test('UX-4 settings copy (#22, #30): Team says what a personal workspace is; Billing’s other amount reads “Any amount” until typed', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'uxsettings', 'plus');
  await page.goto('/settings/team');
  await expect(page.getByText('Your personal workspace. On the Team plan, members share one credit pool.')).toBeVisible({ timeout: 20_000 });
  await page.goto('/settings/billing');
  const other = page.getByPlaceholder('Any amount');
  await expect(other).toBeVisible({ timeout: 20_000 });
  await expect(other).toHaveValue('');
});

test('UX-5 editor (#32) and dialogs (#2): Escape closes the editor; renaming the project keeps focus in the field while typing', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'uxeditor', 'plus');
  const p = await seedProject(page.request, baseURL, 'Escape', SAMPLE_OPS);
  await page.goto(`/p/${p.id}?overlay=edit`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 });
  await page.locator('body').click({ position: { x: 5, y: 450 } }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('editor')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('canvas')).toBeVisible();
  // Rename the project in place: every keystroke stays in the field.
  await page.getByRole('button', { name: /^Project:/ }).click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const field = page.getByRole('textbox', { name: 'Project name' });
  await expect(field).toBeFocused();
  await field.fill('');
  await field.pressSequentially('Renamed in place', { delay: 20 });
  await expect(field).toHaveValue('Renamed in place');
  await expect(field).toBeFocused();
  await field.press('Enter');
  await expect.poll(async () => (await getJson<{ project: { title: string } }>(page.request, `/api/projects/${p.id}`)).project.title, { timeout: 15_000 }).toBe('Renamed in place');
  await page.keyboard.press('Escape');
});
