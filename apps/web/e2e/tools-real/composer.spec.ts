import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './support';

/**
 * Tool composer (real mode, API stubbed): Enter sends and Shift+Enter adds a
 * line, as in the Home prompt box (IME-safe: `isSendKey`); the ratio pill's
 * icon follows the ratio; Quick Create without a template has the generic hint.
 */
const composer = (page: Page) => page.getByTestId('tool-composer');
const pill = (page: Page, id: string) => page.locator(`[data-pill="${id}"]`);
const WIDE = 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z';
const PORTRAIT = 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z';
const SQUARE = 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';

test('Enter sends the run; Shift+Enter adds a new line and sends nothing', async ({ page, context }) => {
  const calls = await stubApi(page, context);
  await page.goto('/create/quick');
  const box = composer(page).getByRole('textbox');
  await box.fill('a red bicycle');
  await box.press('Shift+Enter');
  await expect(box).toHaveValue('a red bicycle\n');
  expect(calls.runs).toHaveLength(0);
  await box.press('Enter');
  await expect.poll(() => calls.runs.length).toBe(1);
  expect(calls.runs[0]).toMatchObject({ quoteId: 'qt_e2e' });
});

test('Enter on an empty composer sends nothing', async ({ page, context }) => {
  const calls = await stubApi(page, context);
  await page.goto('/create/quick');
  await composer(page).getByRole('textbox').press('Enter');
  await page.waitForTimeout(300);
  expect(calls.runs).toHaveLength(0);
});

test('the ratio pill icon follows the ratio (landscape, portrait, square)', async ({ page, context }) => {
  await stubApi(page, context);
  await page.goto('/create/quick');
  const path = pill(page, 'ratio').locator('svg path');
  // Reel Two starts at 21:9.
  await expect(pill(page, 'ratio')).toHaveText('21:9');
  await expect(path).toHaveAttribute('d', WIDE);
  await pill(page, 'ratio').click();
  const pop = page.locator('[data-overlay="params"] [role="dialog"]');
  await pop.getByRole('radio', { name: '9:16' }).click();
  await expect(path).toHaveAttribute('d', PORTRAIT);
  await pop.getByRole('radio', { name: '1:1' }).click();
  await expect(path).toHaveAttribute('d', SQUARE);
});

test('Quick Create without a template uses the generic placeholder', async ({ page, context }) => {
  await stubApi(page, context);
  await page.goto('/create/quick');
  const box = composer(page).getByRole('textbox');
  await expect(box).toHaveAttribute('placeholder', /^Describe the video/);
  await expect(box).not.toHaveAttribute('placeholder', /Say what to change/);
});
