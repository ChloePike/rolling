import { expect, test, type Page } from '@playwright/test';
import { asPlan } from '../support/session';
import { mockPublicLibrary, type PublicNode } from '../support/publicLibrary';
import { MODAL, setMode, setThreshold } from './support/toolSpec';

/** Interaction pass: every left-panel control, feed action and composer control in the four tools does something. */
const fast = (page: Page, extra: Record<string, unknown> = {}) =>
  page.addInitScript((e) => {
    const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
    w.__rollingMocks = { ...w.__rollingMocks, runTickMs: 60, delayMs: 50, ...e };
  }, extra);

const png = { name: 'lead.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') };
const composer = (page: Page) => page.getByTestId('tool-composer');
/** Public library items (GraphQL stub) behind the preset rows. */
const libraryItem = (category: string, title: string): PublicNode => ({ id: `pw_${category}_${title.replace(/\W/g, '')}`, category, sub: null, title, promptEn: title.toLowerCase(), tags: [], assetId: `ast_${category}`, license: 'CC0', source: 'https://posewear.pages.dev/' });
const library = (category: string | null): PublicNode[] =>
  ({ scene: [libraryItem('scene', 'Kitchen'), libraryItem('scene', 'Office')], pose: [libraryItem('pose', 'Walk and talk')], lighting: [libraryItem('lighting', 'Golden hour')] })[category ?? ''] ?? [];

test.describe('tools: generation flow', () => {
  test('under the confirm threshold Generate starts at once: progress → result in the feed → toast with View', async ({ page }) => {
    await setMode(page, 'simple');
    await fast(page, { runTickMs: 300 });
    await page.goto('/create/quick');
    await expect(page.locator('main article')).toHaveCount(4);
    await composer(page).getByRole('button', { name: 'Generate video', exact: true }).click();
    await expect(page.locator(MODAL)).toHaveCount(0);
    await expect(page.getByText(/Started\. \d+ credits on hold/)).toBeVisible();
    const card = page.locator('main article').first();
    await expect(card).toHaveAttribute('data-state', 'running');
    await expect(card.getByRole('progressbar')).toBeVisible();
    await expect.poll(async () => Number(await card.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(card).toHaveAttribute('data-state', 'done', { timeout: 8000 });
    await expect(page.locator('main article')).toHaveCount(5);
    await expect(page.getByText('Your video is ready.')).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    await expect(page.locator(MODAL)).toBeVisible();
  });

  test('at or above the threshold Generate opens RunConfirm; confirming starts the run, canceling it releases the hold', async ({ page }) => {
    await setMode(page, 'simple');
    await setThreshold(page, 0);
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks?: Record<string, unknown> }).__rollingMocks = { runTickMs: 5000 };
    });
    await page.goto('/create/quick');
    await composer(page).getByRole('button', { name: 'Generate video', exact: true }).click();
    const confirm = page.locator(MODAL);
    await confirm.getByRole('button', { name: /Generate video · \d+ credits/ }).click();
    await expect(confirm).toHaveCount(0);
    const card = page.locator('main article').first();
    await expect(card).toHaveAttribute('data-state', 'running');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/Canceled\. \d+ credits released\./)).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(4);
  });

  test('a failed run says it was refunded and Retry starts it again', async ({ page }) => {
    await setMode(page, 'simple');
    await fast(page, { runFails: true });
    await page.goto('/create/quick');
    await composer(page).getByRole('button', { name: 'Generate video', exact: true }).click();
    const card = page.locator('main article').first();
    await expect(card).toHaveAttribute('data-state', 'failed');
    await expect(card).toContainText(/Failed\. \d+ credits refunded/);
    await expect(page.getByText(/The run failed\. \d+ credits refunded\./)).toBeVisible();
    await card.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('main article').first()).toHaveAttribute('data-state', /running|failed/);
  });

  test('history actions: favorite toggles, reuse loads the prompt, download saves a file, regenerate starts a run, send to canvas navigates', async ({ page }) => {
    await setMode(page, 'simple');
    await fast(page);
    await page.goto('/create/quick');
    const done = page.locator('main article[data-state="done"]').first();
    const star = done.getByRole('button', { name: 'Favorites' });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Added to favorites.')).toBeVisible();
    await done.getByRole('button', { name: 'Reuse settings' }).click();
    await expect(composer(page).getByRole('textbox')).toHaveValue('Swap the lead, switch lines to English');
    const dl = page.waitForEvent('download');
    await done.getByRole('button', { name: 'Download' }).click();
    expect((await dl).suggestedFilename()).toBe('rolling-run_q2.txt');
    await done.getByRole('button', { name: 'Regenerate' }).click();
    await expect(page.locator('main article').first()).toContainText('Swap the lead, switch lines to English');
    await expect(page.locator('main article')).toHaveCount(5);
    await page.locator('main article[data-state="done"]').nth(1).getByRole('button', { name: 'Send to canvas' }).click();
    await page.getByRole('dialog', { name: 'Choose a canvas' }).getByRole('button', { name: /Ridgeline Sparkling/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_demo$/);
    await expect(page.locator('.react-flow__node.selected [data-node-kind="asset"]')).toHaveCount(1);
  });

  test('composer: + adds a reference from a real file, Refine rewrites the prompt with Undo', async ({ page }) => {
    await setMode(page, 'simple');
    await fast(page);
    await page.goto('/create/quick');
    const chooser = page.waitForEvent('filechooser');
    await composer(page).getByRole('button', { name: 'Add assets or skills' }).click();
    await (await chooser).setFiles(png);
    await expect(composer(page).locator('[data-ref="@lead"]')).toBeVisible();
    const box = composer(page).getByRole('textbox');
    await box.fill('Shot 2 warmer');
    await composer(page).getByRole('button', { name: 'Refine prompt' }).click();
    await expect(composer(page).getByRole('button', { name: 'Refine prompt' })).toHaveText('Refining…');
    await expect(box).toHaveValue(/^Shot 2 warmer\. Keep the subject/);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(box).toHaveValue('Shot 2 warmer');
  });

  test('filters: Running and Finished narrow the feed', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    await page.getByRole('tab', { name: 'Running' }).click();
    await expect(page.locator('main article')).toHaveCount(1);
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(page.locator('main article')).toHaveCount(4);
  });
});

test.describe('tools: left panels', () => {
  test('Quick Create: Upload/Replace open a real file chooser and set the slot; language select changes', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/quick');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload a photo for @Partner' }).click();
    await (await chooser).setFiles({ ...png, name: 'partner.png' });
    await expect(page.locator('[data-slot="Partner"]')).toContainText('partner.png');
    await expect(page.getByRole('button', { name: 'Replace the photo for @Partner' })).toBeVisible();
    const lang = page.getByRole('combobox', { name: /language/i });
    await lang.selectOption({ index: 1 });
    await expect(page.getByText(/Lines will be spoken in/)).toBeVisible();
    const sw = page.locator('[data-card="ambience"]').getByRole('switch');
    const before = await sw.getAttribute('aria-checked');
    await sw.click();
    await expect(sw).not.toHaveAttribute('aria-checked', before!);
    await page.locator('[data-card="template"]').getByRole('link').click();
    await expect(page).toHaveURL(/\/templates$/);
  });

  test('Remix: preset rows open the public library (keyboard too); character slots upload', async ({ page }) => {
    await mockPublicLibrary(page, library);
    await setMode(page, 'simple');
    await page.goto('/create/remix');
    const row = page.locator('[data-preset="scene"]');
    await row.click();
    const picker = page.getByRole('dialog', { name: 'Scenes' });
    await expect(picker.getByRole('tab')).toHaveText(['Scenes', 'Lighting', 'Props', 'Furniture']);
    await picker.getByRole('option', { name: /Kitchen/ }).click();
    await expect(row).toContainText('Kitchen');
    await page.locator('[data-preset="action"]').focus();
    await page.keyboard.press('Enter');
    const poses = page.getByRole('dialog', { name: 'Action' });
    await poses.getByRole('option', { name: /Walk and talk/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-preset="action"]')).toContainText('Walk and talk');
    await page.getByRole('radio', { name: '3 people' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-slot="2"]').click();
    await (await chooser).setFiles({ ...png, name: 'third.png' });
    await expect(page.locator('[data-slot="2"]')).toContainText('third.png');
  });

  test('Avatar: look rows pick, custom persona adds a chip, voice preview plays, draft rewrite and confirm', async ({ page }) => {
    await setMode(page, 'simple');
    await setThreshold(page, 0);
    await page.goto('/create/avatar');
    await mockPublicLibrary(page, library);
    await page.locator('[data-look="scene"]').click();
    await page.getByRole('dialog', { name: 'Scenes' }).getByRole('tab', { name: 'Lighting' }).click();
    await page.getByRole('dialog', { name: 'Scenes' }).getByRole('option', { name: /Golden hour/ }).click();
    await expect(page.locator('[data-look="scene"]')).toContainText('Golden hour');
    await page.getByRole('button', { name: 'Custom' }).click();
    await page.getByLabel('Custom persona').fill('Calm skincare expert');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Calm skincare expert' })).toHaveAttribute('aria-pressed', 'true');
    const play = page.getByRole('button', { name: /Preview Steady male/ });
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    const draft = page.locator('article[data-feed="draft_a1"]');
    await draft.getByRole('button', { name: 'Rewrite with another persona' }).click();
    await expect(page.getByText('Draft rewritten with another persona.')).toBeVisible();
    await draft.getByRole('button', { name: 'Confirm and generate' }).click();
    await expect(page.locator(MODAL)).toBeVisible();
  });

  test('Characters: reference buttons upload a file', async ({ page }) => {
    await setMode(page, 'simple');
    await page.goto('/create/character');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-ref-slot="face"]').click();
    await (await chooser).setFiles({ ...png, name: 'face.png' });
    await expect(page.locator('[data-ref-slot="face"]')).toContainText('face.png');
    await page.locator('main article[data-state="done"]').first().getByRole('button', { name: 'Save to characters' }).click();
    await page.getByRole('status').getByRole('button', { name: 'View' }).click();
    await expect(page).toHaveURL(/\/assets\?folder=characters$/);
  });

  test('non-members: draft revise and rewrite go to the join paywall (agent path, D-007)', async ({ page }) => {
    await asPlan(page, null);
    await setMode(page, 'simple');
    await page.goto('/create/avatar');
    await page.locator('article[data-feed="draft_a1"]').getByRole('button', { name: 'Revise' }).click();
    await expect(page.getByRole('dialog', { name: 'Pick a plan to generate' })).toBeVisible();
  });
});

test('Quick Create reads ?template and ?ratio from Templates', async ({ page }) => {
  await setMode(page, 'simple');
  await page.goto('/create/quick?template=tpl_03&ratio=1:1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quick Create · Unboxing close-ups');
  await expect(page.locator('[data-pill="ratio"]')).toHaveText('1:1');
  await expect(page.locator('[data-card="template"]')).toContainText('1:1 · 10s');
});

