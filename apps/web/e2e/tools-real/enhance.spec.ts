import { expect, test, type Page } from '@playwright/test';
import { CATALOG, stubApi } from './support';

/**
 * D-020 "Enhance prompt" on the tool pages (real mode, API stubbed): the card
 * shows only for models that take the gateway's prompt expansion, starts from
 * Preferences, says "Not available yet" while the gateway refuses it, and the
 * run's spec carries the choice.
 */
const composer = (page: Page) => page.getByTestId('tool-composer');
const card = (page: Page) => page.locator('main aside [data-card="enhance"]');
const modelGroup = (page: Page) => page.locator('main aside [data-group="model"]');

// Reel Two takes it, Quiet One is refused by the gateway here, Text Only does not take it.
const STATES: Record<string, string> = { 'acme/reel-2': 'available', 'acme/quiet-1': 'unavailable' };
const ENHANCE_CATALOG = CATALOG.map((m) => {
  const id = String((m as Record<string, unknown>).id);
  return STATES[id] ? { ...m, promptExpand: STATES[id] } : m;
});

async function lastSpec(calls: Awaited<ReturnType<typeof stubApi>>, page: Page, prompt: string): Promise<Record<string, unknown>> {
  await composer(page).getByRole('textbox').fill(prompt);
  await expect.poll(() => calls.quotes.filter((q) => q.promptSpec.prompt === prompt).length).toBeGreaterThan(0);
  return calls.quotes.filter((q) => q.promptSpec.prompt === prompt).at(-1)!.promptSpec;
}

test('Quick Create: on by default for a model that takes it; turning it off is sent with the run', async ({ page, context }) => {
  const calls = await stubApi(page, context, { creationMode: 'advanced', catalog: ENHANCE_CATALOG });
  await page.goto('/create/quick');
  await modelGroup(page).getByRole('button', { name: 'Reel Two' }).click();
  await expect(card(page)).toContainText('Enhance prompt');
  await expect(card(page)).toContainText('Rewrites short prompts with more detail before rendering');
  const toggle = card(page).getByRole('switch', { name: 'Enhance prompt' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await lastSpec(calls, page, 'a red bicycle')).toMatchObject({ promptExpand: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await lastSpec(calls, page, 'a blue bicycle')).toMatchObject({ promptExpand: false });
});

test('Quick Create: the default follows Preferences; unavailable says so and sends nothing; models without it hide the card', async ({ page, context }) => {
  const calls = await stubApi(page, context, { creationMode: 'advanced', catalog: ENHANCE_CATALOG, prefs: { enhancePrompt: false } });
  await page.goto('/create/quick');
  await modelGroup(page).getByRole('button', { name: 'Reel Two' }).click();
  await expect(card(page).getByRole('switch', { name: 'Enhance prompt' })).toHaveAttribute('aria-checked', 'false');
  expect(await lastSpec(calls, page, 'a green bicycle')).toMatchObject({ promptExpand: false });

  await modelGroup(page).getByRole('button', { name: 'Quiet One' }).click();
  await expect(card(page)).toContainText('Not available yet');
  await expect(card(page).getByRole('switch', { name: 'Enhance prompt' })).toBeDisabled();
  expect(await lastSpec(calls, page, 'a grey bicycle')).not.toHaveProperty('promptExpand');

  await page.goto('/create/quick');
  await modelGroup(page).getByRole('button', { name: 'Text Only' }).click();
  await expect(card(page)).toHaveCount(0);
});
