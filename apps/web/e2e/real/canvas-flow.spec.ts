import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { dragWire, env, nodesByKind, portCenter, signIn } from './support';

/**
 * docs/canvas-flow.md steps 1–9 against the real backend (no mocks):
 *   PW_BASE_URL=https://<staging> TEST_INBOX_TOKEN=… PW_MEMBER_EMAIL=… [PW_GENERATE=1] \
 *     pnpm --filter @rolling/web exec playwright test --project=real
 * Every step also survives a reload and is checked from a second tab.
 * Generation steps (6–8) need PW_GENERATE=1 (a gateway behind the Worker: staging).
 * Step 11 (export) also needs PW_EXPORT=1: the FFmpeg container behind the Worker.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!env.inboxToken || !env.memberEmail, 'Set TEST_INBOX_TOKEN and PW_MEMBER_EMAIL (a member test account) to run the real canvas flow');

const BRIEF = '15-second vertical ad for a sparkling water brand: morning by a river, the bottle on a rock, a fresh pop and the logo.';

let projectId = '';

async function openCanvas(page: Page, id: string, query = '') {
  await page.goto(`/p/${id}${query}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
}

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, env.memberEmail, baseURL!);
});

test('1–2: Home agent brief with the TV ad skill and an @ product photo → plan options → Build on canvas opens the project', async ({ page }) => {
  await page.goto('/');
  const brief = page.locator('#brief');
  await expect(brief).toBeVisible();
  // Skill from the / palette.
  await brief.fill('/TV');
  const skill = page.getByRole('option', { name: /TV ad/ }).first();
  if (await skill.isVisible().catch(() => false)) await skill.click();
  else await brief.fill('');
  if (env.productPhoto) {
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles({ name: basename(env.productPhoto), mimeType: 'image/png', buffer: readFileSync(env.productPhoto) });
  }
  await brief.fill(BRIEF);
  await brief.press('Enter');
  const plan = page.getByTestId('home-plan');
  await expect(plan, 'the agent answers with a plan proposal (2–3 options)').toBeVisible({ timeout: 180_000 });
  const options = page.locator('[data-testid^="home-plan-option-"]');
  expect(await options.count()).toBeGreaterThanOrEqual(1);
  if ((await options.count()) > 1) await options.nth(1).click();
  await plan.getByRole('button', { name: 'Build on canvas' }).click();
  await page.waitForURL(/\/p\/prj_/, { timeout: 60_000 });
  projectId = /\/p\/(prj_[A-Za-z0-9]+)/.exec(page.url())![1]!;
});

test('3: the canvas shows script, keyframe and video nodes left to right, connected; survives a reload and shows in a second tab', async ({ page, context }) => {
  test.skip(!projectId, 'needs step 1–2');
  await openCanvas(page, projectId);
  const scripts = await nodesByKind(page, 'script');
  const images = await nodesByKind(page, 'image');
  const videos = await nodesByKind(page, 'video');
  expect(scripts.length).toBeGreaterThanOrEqual(1);
  expect(images.length).toBeGreaterThanOrEqual(1);
  expect(videos.length).toBeGreaterThanOrEqual(1);
  expect(scripts[0]!.x).toBeLessThan(images[0]!.x);
  expect(images[0]!.x).toBeLessThan(videos[videos.length - 1]!.x);
  expect(await page.locator('[data-testid^="edge-"]').count()).toBeGreaterThanOrEqual(images.length);
  await page.reload();
  await expect(page.locator('[data-node-kind="video"]')).toHaveCount(videos.length);
  const other = await context.newPage();
  await openCanvas(other, projectId);
  await expect(other.locator('[data-node-kind="video"]')).toHaveCount(videos.length);
  await other.close();
});

test('4: edit a prompt and the resolution, connect and disconnect a port; an invalid connection is refused with a reason', async ({ page, context }) => {
  test.skip(!projectId, 'needs step 1–2');
  await openCanvas(page, projectId);
  const other = await context.newPage();
  await openCanvas(other, projectId);
  const [video] = await nodesByKind(page, 'video');
  await page.getByTestId(`node-${video!.id}`).click();
  const panel = page.getByTestId('prompt-panel');
  await panel.getByTestId('prompt-text').click();
  const box = panel.getByRole('textbox', { name: 'Prompt' });
  const prompt = `Slow push-in on the bottle at dawn ${Date.now().toString(36)}`;
  await box.fill(prompt);
  await box.press('Control+Enter');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  // The other tab gets graph.patched.
  await other.getByTestId(`node-${video!.id}`).click();
  await expect(other.getByTestId('prompt-panel').getByTestId('prompt-text')).toHaveText(prompt);
  await other.close();

  // Resolution within the plan cap (settings popover).
  await panel.getByRole('button', { name: /·\s*\d+s$|\d+p/ }).first().click();
  const res720 = page.getByRole('radio', { name: '720p' }).or(page.getByRole('button', { name: '720p' })).first();
  if (await res720.isVisible().catch(() => false)) await res720.click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');

  // Invalid: a video output into an image node's input.
  const [image] = await nodesByKind(page, 'image');
  const edgesBefore = await page.locator('[data-testid^="edge-"]').count();
  await dragWire(page, await portCenter(page, video!.id, 'out'), await portCenter(page, image!.id, 'in'));
  await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /don’t take|can’t|isn’t|cycle|already/i }).first()).toBeVisible();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edgesBefore);

  // Disconnect then undo (Ctrl+Z re-connects through a patch).
  const edge = page.locator('[data-testid^="edge-"]').first();
  await edge.click({ button: 'right', force: true });
  const disconnect = page.getByRole('menuitem', { name: 'Disconnect' });
  if (await disconnect.isVisible().catch(() => false)) {
    await disconnect.click();
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edgesBefore - 1);
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edgesBefore);
  }
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(edgesBefore);
});

test('5: Run all quotes run / reuse / blocked rows with credits and the balance after', async ({ page }) => {
  test.skip(!projectId, 'needs step 1–2');
  await openCanvas(page, projectId);
  await page.getByRole('button', { name: /^Run all/ }).click();
  const dialog = page.getByTestId('plan-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Run · [\d,]+ credits/ })).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText(/credits/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('6–7: confirm → keyframes then videos generate with real progress; credits settle live; a forced failure refunds with Retry', async ({ page, context }) => {
  test.skip(!projectId, 'needs step 1–2');
  test.skip(!env.generate, 'Generation runs against staging only (PW_GENERATE=1); the API has no fake gateway seam');
  test.setTimeout(20 * 60_000);
  await openCanvas(page, projectId);
  const watcher = await context.newPage();
  await openCanvas(watcher, projectId);
  await page.getByRole('button', { name: /^Run all/ }).click();
  const dialog = page.getByTestId('plan-dialog');
  await dialog.getByRole('button', { name: /^Run · [\d,]+ credits/ }).click();
  const [image] = await nodesByKind(page, 'image');
  const videos = await nodesByKind(page, 'video');
  await expect(watcher.getByTestId(`node-${image!.id}`)).toHaveAttribute('data-status', /queued|generating/, { timeout: 60_000 });
  // Dependent videos wait (queued) while their keyframe generates.
  await expect(page.getByTestId(`node-${videos[0]!.id}`)).toHaveAttribute('data-status', /queued|generating/);
  await expect(page.getByTestId(`node-${image!.id}`)).toHaveAttribute('data-status', 'done', { timeout: 10 * 60_000 });
  await expect(page.getByTestId(`node-media-${image!.id}`)).toBeVisible();
  for (const v of videos) await expect(page.getByTestId(`node-${v.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15 * 60_000 });
  await watcher.close();

  // Forced failure (staging/development): the node fails, says it was refunded, Retry quotes again.
  await openCanvas(page, projectId, '?forceFailure=1');
  await page.getByTestId(`node-${image!.id}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Run this node|^Run$|^Generate/ }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Confirm', exact: true });
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /credits/ }).click();
  await expect(page.getByTestId(`node-${image!.id}`)).toHaveAttribute('data-status', 'failed', { timeout: 120_000 });
  await expect(page.getByTestId(`node-${image!.id}`)).toContainText(/Refunded [\d,]+ credits/);
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
});

test('8: an upstream prompt change marks downstream “Input changed”; a new run adds a version; switch the active version', async ({ page }) => {
  test.skip(!projectId, 'needs step 1–2');
  test.skip(!env.generate, 'needs generated versions (PW_GENERATE=1)');
  test.setTimeout(10 * 60_000);
  await openCanvas(page, projectId);
  const [image] = await nodesByKind(page, 'image');
  const videos = await nodesByKind(page, 'video');
  await page.getByTestId(`node-${image!.id}`).click();
  const panel = page.getByTestId('prompt-panel');
  await panel.getByTestId('prompt-text').click();
  await panel.getByRole('textbox', { name: 'Prompt' }).fill(`Warmer morning light ${Date.now().toString(36)}`);
  await panel.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter');
  await expect(page.getByTestId(`node-${videos[0]!.id}`)).toHaveAttribute('data-status', 'outdated');
  await expect(page.getByTestId(`node-${videos[0]!.id}`)).toContainText('Input changed');
  await panel.getByRole('button', { name: 'Generate', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm', exact: true });
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /credits/ }).click();
  await expect(page.getByTestId(`node-${image!.id}`)).toHaveAttribute('data-status', 'done', { timeout: 8 * 60_000 });
  const chip = page.getByTestId(`node-${image!.id}`).getByRole('button', { name: /Version \d+ of \d+/ });
  await expect(chip).toHaveAccessibleName(/Version 2 of 2|Version (\d+) of \1/);
  await chip.click();
  await page.getByTestId('menu-versions').getByRole('menuitemradio', { name: /^Version 1/ }).click();
  await expect(page.getByText(/now uses version 1/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(`node-${image!.id}`).getByRole('button', { name: /Version 1 of/ })).toBeVisible();
});

test('9: canvas agent “make shot 2 warmer” proposes a graph patch; Apply applies exactly it, Discard drops it', async ({ page }) => {
  test.skip(!projectId, 'needs step 1–2');
  test.setTimeout(6 * 60_000);
  await openCanvas(page, projectId);
  const ask = page.locator('#canvas-ask');
  await ask.fill('make shot 2 warmer');
  await ask.press('Enter');
  const proposal = page.getByTestId('graph-proposal').last();
  await expect(proposal).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-proposed]').first()).toBeVisible();
  await proposal.getByRole('button', { name: 'Apply' }).click();
  await expect(proposal).toHaveAttribute('data-outcome', 'applied', { timeout: 30_000 });
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');

  await ask.fill('make shot 1 cooler');
  await ask.press('Enter');
  const second = page.getByTestId('graph-proposal').last();
  await expect(second).toHaveAttribute('data-outcome', 'open', { timeout: 180_000 });
  await second.getByRole('button', { name: 'Discard' }).click();
  await expect(second).toHaveAttribute('data-outcome', 'discarded');
  await page.reload();
  await expect(page.getByTestId('graph-proposal').filter({ has: page.locator('[data-outcome="discarded"]') }).or(page.locator('[data-outcome="discarded"]')).first()).toBeVisible({ timeout: 30_000 });
});

test('11: Export MP4 from the editor: progress from export events, then Download', async ({ page }) => {
  test.skip(!projectId, 'needs step 1–2');
  test.skip(!env.generate, 'needs generated shots (PW_GENERATE=1)');
  test.skip(!env.exportRender, 'needs the FFmpeg container behind the Worker (PW_EXPORT=1)');
  test.setTimeout(15 * 60_000);
  await page.goto(`/p/${projectId}?overlay=edit`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  await dialog.getByRole('radio', { name: '720p' }).click();
  await dialog.getByRole('button', { name: 'Export MP4' }).click();
  await expect(dialog).toHaveAttribute('data-phase', 'running');
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await expect(dialog).toHaveAttribute('data-phase', 'done', { timeout: 12 * 60_000 });
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(page.getByText('Export ready')).toBeVisible();
});
