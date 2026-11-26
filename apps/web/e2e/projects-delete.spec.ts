import { expect, test } from '@playwright/test';
import { routeModels } from './support/models';

/**
 * CANVAS-10 on the mocks: delete (and rename) a project from its Home card “…” menu and from the canvas
 * project menu, with a confirm dialog (the API has no restore). After deleting the open canvas, the app goes
 * Home and forgets the last-canvas id.
 */

test.beforeEach(async ({ page }) => {
  await routeModels(page);
});

test('Home card menu: Rename and Delete (confirm); the card leaves the list and stays gone after reload', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-project="prj_02"]');
  await expect(card).toBeVisible();
  const more = card.getByRole('button', { name: 'Project actions: Desk organizer pitch' });
  // Hidden until hover or focus, so the card reads as in the design.
  await expect(more).toHaveCSS('opacity', '0');
  await card.hover();
  await expect(more).toHaveCSS('opacity', '1');
  await more.click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename project' });
  await rename.getByLabel('Project name').fill('Desk organizer, v2');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(rename).toHaveCount(0);
  await expect(card).toContainText('Desk organizer, v2');

  await card.hover();
  await card.getByRole('button', { name: /^Project actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Desk organizer, v2”?' });
  await expect(confirm).toContainText('This can’t be undone.');
  // Cancel keeps it.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByRole('button', { name: /^Project actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByText('Deleted “Desk organizer, v2”.')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-project="prj_01"]')).toBeVisible();
  await expect(page.locator('[data-project="prj_02"]')).toHaveCount(0);
});

test('canvas project menu: Delete confirms, goes Home and forgets the last canvas', async ({ page }) => {
  await page.goto('/');
  // A canvas created here, opened once (so it is the remembered last canvas).
  await page.getByRole('link', { name: 'New project' }).click();
  await expect(page).toHaveURL(/\/p\/prj_/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect.poll(() => page.evaluate((pid) => Object.entries(localStorage).some(([k, v]) => k.startsWith('rolling.canvas.last.') && v === pid), id)).toBe(true);
  await page.getByRole('button', { name: /^Project:/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: /^Delete “/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete project' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate((pid) => Object.entries(localStorage).some(([k, v]) => k.startsWith('rolling.canvas.last.') && v === pid), id)).toBe(false);
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId('canvas-error')).toBeVisible();
});
