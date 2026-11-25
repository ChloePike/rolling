import { expect, test, type Page } from '@playwright/test';
import { routeModels } from './support/models';
import { asPlan } from './support/session';

/**
 * D-012: the agent LLM pickers show "~N turns left" per model from the
 * monthly agent allowance (mock: plan allowance ÷ default turn estimate), and
 * a non-blocking notice once it is used up.
 */

const CHAT = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', default: true },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', default: false },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', default: false },
].map((m) => ({ ...m, kind: 'chat', tags: [], placement: 'featured', auto: false, mature: false, matureOnly: false, requiresIdentitySafety: false, operations: [], seconds: null, defaultSeconds: null, resolutions: [], defaultResolution: null, ratios: [], audio: false, lipSync: false, credits: [] }));

async function openHome(page: Page, mocks: Record<string, unknown> = {}) {
  await routeModels(page);
  await page.route('**/api/models?kind=chat', (r) => r.fulfill({ json: { models: CHAT } }));
  await page.addInitScript((m) => {
    const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
    w.__rollingMocks = { ...w.__rollingMocks, ...m };
  }, mocks);
  await page.goto('/');
  await page.locator('[data-testid="app-header"]').waitFor();
}

test('Home agent LLM picker shows turns left per metered model (Starter: $1.20 a month); DeepSeek is unmetered', async ({ page }) => {
  await asPlan(page, 'starter');
  await openHome(page);
  await page.getByRole('button', { name: /DeepSeek V4\.1 Flash/ }).first().click();
  const list = page.getByRole('dialog').filter({ hasText: 'Claude Opus 5.5' });
  // D-012 amendment: DeepSeek models do not draw on the allowance, so no turn count.
  await expect(list.getByRole('button', { name: /DeepSeek V4\.1 Flash/ })).not.toContainText('turns left');
  await expect(list.getByRole('button', { name: /Claude Opus 5\.5/ })).toContainText('~18 turns left');
  await expect(list.getByRole('button', { name: /GPT-6 Astra/ })).toContainText('~7 turns left');
  await expect(page.getByText(/Agent allowance for this month is used up/)).toHaveCount(0);
});

test('a used-up allowance shows a notice with the reset date and zero turns left', async ({ page }) => {
  await asPlan(page, 'starter');
  await openHome(page, { agentAllowance: { usedUsd: 1.2 } });
  await expect(page.getByRole('status').filter({ hasText: 'Agent allowance for this month is used up' })).toContainText(/resets [A-Z][a-z]{2} \d{1,2}/);
  await page.getByRole('button', { name: /DeepSeek V4\.1 Flash/ }).first().click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Claude Opus 5.5' }).getByRole('button', { name: /Claude Opus 5\.5/ })).toContainText('~0 turns left');
});
