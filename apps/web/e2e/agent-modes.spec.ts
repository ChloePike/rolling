import { expect, test, type Page } from '@playwright/test';
import { NODE } from '../src/features/canvas/mocks';
import { routeModels } from './support/models';

/**
 * D-021 agent modes on the mocks: the Read / Edit / Auto switch next to the agent
 * model picker (canvas panel and Home), one-line tooltips, per-project memory and
 * the Preferences default; Auto applies the change with an "Agent changed …"
 * summary and Undo, shows the spend against the budget, and leaves a run over the
 * budget for approval ("Run · N credits").
 */

async function openCanvas(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/p/prj_demo?mock=frozen');
  await page.getByTestId('canvas').waitFor();
  await page.getByTestId(`node-${NODE.shotB}`).waitFor();
}

const panel = (page: Page) => page.locator('aside[aria-label="Agent"]');
const nodePrompt = (page: Page, id: string) => page.evaluate((nodeId) => String(window.__canvasRoom!.state.nodes.find((n) => n.id === nodeId)!.params.prompt ?? ''), id);
const nodeCost = (page: Page, id: string) =>
  page.evaluate((nodeId) => {
    const el = document.querySelector(`[data-testid="node-${nodeId}"]`);
    const m = /([\d,]+)\s*credits?/i.exec(el?.textContent ?? '');
    return m ? Number(m[1]!.replace(/,/g, '')) : null;
  }, id);

async function ask(page: Page, text: string) {
  const box = page.getByLabel('Tell the agent');
  await box.fill(text);
  await box.press('Enter');
}

test.describe('canvas agent panel modes', () => {
  test('the switch sits in the panel head, explains each mode, and Read changes nothing', async ({ page }) => {
    await openCanvas(page);
    const sw = panel(page).getByRole('button', { name: 'Agent mode: Edit' });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('title', 'Proposes changes. You preview and apply them.');
    // In the panel head, at the right edge above the agent model pill.
    const llm = await panel(page).getByRole('button', { name: /^Agent model/ }).boundingBox();
    const box = await sw.boundingBox();
    expect(box!.y).toBeLessThan(llm!.y);
    await sw.click();
    for (const [name, hint] of [
      ['Read', 'Answers and explains. Changes nothing.'],
      ['Edit', 'Proposes changes. You preview and apply them.'],
      ['Auto', 'Applies changes and starts runs within the budget. You can undo each change.'],
    ] as const) {
      await expect(page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })).toHaveAttribute('title', hint);
    }
    await page.getByRole('menuitemradio', { name: /^Read/ }).click();
    await expect(panel(page).getByRole('button', { name: 'Agent mode: Read' })).toBeVisible();
    await expect(panel(page).getByTestId('agent-budget')).toHaveCount(0);
    const before = await nodePrompt(page, NODE.shotA);
    await ask(page, 'Make shot 1 warmer');
    await expect(panel(page)).toContainText('Read mode');
    await expect(page.getByTestId('graph-proposal')).toHaveCount(0);
    expect(await nodePrompt(page, NODE.shotA)).toBe(before);

    // Remembered for this project.
    await page.reload();
    await page.getByTestId('canvas').waitFor();
    await expect(panel(page).getByRole('button', { name: 'Agent mode: Read' })).toBeVisible();
  });

  test('Auto applies the change with a summary and Undo; a run over the budget waits for approval; within the budget it starts', async ({ page }) => {
    await openCanvas(page);
    await panel(page).getByRole('button', { name: 'Agent mode: Edit' }).click();
    await page.getByRole('menuitemradio', { name: /^Auto/ }).click();
    const budget = panel(page).getByTestId('agent-budget');
    await expect(budget).toHaveText('Budget 300');

    // A small budget: the change applies, the run waits.
    await budget.click();
    await page.getByRole('menuitemradio', { name: '100 credits', exact: true }).click();
    await expect(budget).toHaveText('Budget 100');
    const cost = await nodeCost(page, NODE.shotA);
    const before = await nodePrompt(page, NODE.shotA);
    await ask(page, 'Make shot 1 warmer and run it');
    const summary = panel(page).getByTestId('auto-summary').last();
    await expect(summary).toContainText('Agent changed 1 thing');
    await expect(summary.getByTestId('auto-change')).toContainText('Update Shot A: Hero shot');
    await expect(summary.getByTestId('auto-spend')).toHaveText('0 of 100 credits');
    expect(await nodePrompt(page, NODE.shotA)).toContain('warmer color temperature');
    // No Apply card in Auto: it is already on the canvas.
    await expect(page.getByTestId('graph-proposal')).toHaveCount(0);
    const waiting = summary.getByTestId('auto-run');
    await expect(waiting).toHaveAttribute('data-status', 'needs_approval');
    const approve = waiting.getByTestId('auto-run-approve');
    await expect(approve).toHaveText(cost ? `Run · ${cost.toLocaleString('en-US')} credits` : /^Run · [\d,]+ credits$/);
    await expect(approve).toHaveAttribute('title', 'Over this turn’s budget. It runs only when you approve it.');

    // Undo reverts the change.
    await summary.getByRole('button', { name: 'Undo: Update Shot A: Hero shot' }).click();
    await expect(summary.getByTestId('auto-change')).toHaveAttribute('data-status', 'undone');
    await expect.poll(() => nodePrompt(page, NODE.shotA)).toBe(before);

    // Approving the waiting run goes through the normal run flow: over the confirm threshold it asks first.
    await approve.click();
    await expect(waiting).toContainText('Sent to run');
    const confirm = page.getByRole('dialog', { name: 'Confirm' });
    await expect(confirm.getByRole('button', { name: /^Generate · [\d,]+ credits$/ })).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);

    // A larger budget: the run starts and the spend shows against it.
    await budget.click();
    await page.getByRole('menuitemradio', { name: '2,000 credits', exact: true }).click();
    await ask(page, 'Make shot 2 slower and run it');
    const second = panel(page).getByTestId('auto-summary').last();
    await expect(second.getByTestId('auto-run')).toHaveAttribute('data-status', 'started');
    await expect(second.getByTestId('auto-spend')).toHaveText(/^[\d,]+ of 2,000 credits$/);
    await expect(second.getByTestId('auto-spend')).not.toHaveText('0 of 2,000 credits');
  });
});

test.describe('Home agent modes and the Preferences default', () => {
  async function openHome(page: Page) {
    await routeModels(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
      w.__rollingMocks = { ...w.__rollingMocks, latencyMs: 60 };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.locator('[data-testid="app-header"]').waitFor();
  }

  test('the mode pill follows the model pill; Read gives no plan; Auto builds on a canvas without a click', async ({ page }) => {
    await openHome(page);
    const pill = page.getByRole('button', { name: 'Agent mode: Edit' });
    await expect(pill).toHaveAttribute('title', 'Proposes changes. You preview and apply them.');
    await pill.click();
    const list = page.getByRole('dialog', { name: 'Agent mode: Edit' });
    await expect(list.getByRole('button', { name: /^Auto/ })).toHaveAttribute('title', 'Applies changes and starts runs within the budget. You can undo each change.');
    await list.getByRole('button', { name: /^Read/ }).click();
    await page.locator('#brief').fill('Launch video for a desk lamp');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('home-agent-reply').last()).toContainText('Read mode');
    await expect(page.getByTestId('home-plan')).toHaveCount(0);

    await page.getByRole('button', { name: 'Agent mode: Read' }).click();
    await page.getByRole('dialog', { name: 'Agent mode: Read' }).getByRole('button', { name: /^Auto/ }).click();
    await expect(page.getByRole('button', { name: 'Run budget per turn' })).toHaveText(/Budget 300/);
    await page.locator('#brief').fill('Launch video for a desk lamp');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/\/p\/[^/?]+/, { timeout: 15_000 });
  });

  test('Preferences sets the default mode for Home and the Auto budget', async ({ page }) => {
    await routeModels(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/settings/preferences');
    await page.getByRole('button', { name: 'Agent mode: Edit' }).click();
    await page.getByRole('listbox', { name: 'Agent mode' }).getByRole('option', { name: 'Auto' }).click();
    await page.getByRole('button', { name: /^Auto run budget:/ }).click();
    await page.getByRole('listbox', { name: 'Auto run budget' }).getByRole('option', { name: '500 credits' }).click();
    await expect(page.getByRole('button', { name: 'Auto run budget: 500 credits' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Agent mode: Auto' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run budget per turn' })).toHaveText(/Budget 500/);
  });
});
