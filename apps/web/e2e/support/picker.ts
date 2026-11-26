import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The shared asset picker modal (features/picker). Mock builds: uploads go
 * through the transfer engine's dev mock once `/api/health` does not answer
 * (stubbed here for every page and the SharedWorker).
 */
export const PNG = { name: 'lead.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d4b0b4f20000000049454e44ae426082', 'hex') };

export async function devUploads(context: BrowserContext) {
  await context.route('**/api/health', (route) => route.fulfill({ status: 503, json: { ok: false } }));
}

/** The open picker; `name` is its title (the caller's label). */
export function picker(page: Page, name?: string | RegExp): Locator {
  const d = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator('[data-picker-scroll]') });
  return name ? d.filter({ has: page.getByRole('heading', { name, exact: typeof name === 'string' }) }) : d;
}

/** Uploads a file from the picker and waits until it is an asset, selected. Returns that option. */
export async function uploadFromPicker(dialog: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  await dialog.getByTestId('picker-upload-input').setInputFiles(file);
  const stem = file.name.replace(/\.[^.]+$/, '');
  const option = dialog.locator('[role="option"][data-asset^="ast_"]').filter({ hasText: stem }).first();
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  return option;
}

export async function use(dialog: Locator) {
  await dialog.getByRole('button', { name: /^(Use|Add)/ }).last().click();
  await expect(dialog).toHaveCount(0);
}
