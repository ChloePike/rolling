import { expect, test, type Page } from '@playwright/test';
import { DEMO_LITERALS, stubApi } from './support';

/**
 * Tool pages on the production client (real mode) with the API stubbed:
 * pills mirror the settings popover and the selected model's catalog
 * capabilities, one pill shows as open, presets come from the public library,
 * the run request carries the real settings and the picked references, the
 * quote is the server's, and no design/demo literal renders.
 */
const composer = (page: Page) => page.getByTestId('tool-composer');
const pill = (page: Page, id: string) => page.locator(`[data-pill="${id}"]`);
const params = (page: Page) => page.locator('[data-overlay="params"] [role="dialog"]');

async function expectNoDemo(page: Page) {
  const text = await page.locator('main').innerText();
  for (const lit of DEMO_LITERALS) expect(text, `demo literal "${lit}"`).not.toContain(lit);
}

test('Remix: pills come from the default model and follow every change in the settings popover; one pill is open', async ({ page, context }) => {
  await stubApi(page, context);
  await page.goto('/create/remix');
  // Auto starts from the catalog default ("Reel Two"): first ratio, default length and resolution, audio on.
  await expect(pill(page, 'model')).toHaveText('Auto model');
  await expect(pill(page, 'ratio')).toHaveText('21:9');
  await expect(pill(page, 'duration')).toHaveText('8s');
  await expect(pill(page, 'res')).toHaveText('720p');
  await expect(pill(page, 'audio')).toHaveText('Audio');
  await expect(pill(page, 'count')).toHaveCount(0);

  await pill(page, 'duration').click();
  const pop = params(page);
  await expect(pop).toBeVisible();
  // Only the pill that opened the popover is open.
  await expect(pill(page, 'duration')).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['ratio', 'res', 'audio']) await expect(pill(page, id)).toHaveAttribute('aria-expanded', 'false');
  // Options are the model's: its ratios and allowed lengths only, no count.
  await expect(pop.getByRole('radiogroup', { name: 'Aspect ratio' }).getByRole('radio')).toHaveText(['21:9', '1:1', '9:16']);
  await expect(pop.getByRole('radiogroup', { name: 'Duration' }).getByRole('radio')).toHaveText(['4s', '8s', '12s']);
  await expect(pop.getByRole('radiogroup', { name: 'Count' })).toHaveCount(0);
  await expect(pop).toContainText('Max 12s on this model');

  await pop.getByRole('radio', { name: '9:16' }).click();
  await expect(pill(page, 'ratio')).toHaveText('9:16');
  await pop.getByRole('radiogroup', { name: 'Duration' }).getByRole('radio', { name: '12s' }).click();
  await expect(pill(page, 'duration')).toHaveText('12s');
  await pop.getByRole('switch', { name: 'Generate audio' }).click();
  await expect(pill(page, 'audio')).toHaveText('No audio');
  await expect(pop.getByRole('radio', { name: '9:16' })).toHaveAttribute('aria-checked', 'true');
  await expectNoDemo(page);
});

test('Remix: resolution is capped by the plan (Starter 720p); a locked option opens the upgrade', async ({ page, context }) => {
  await stubApi(page, context);
  await page.goto('/create/remix');
  await pill(page, 'res').click();
  const res = params(page).getByRole('radiogroup', { name: 'Resolution' });
  await expect(res.getByRole('radio')).toHaveCount(3);
  await res.getByRole('radio', { name: /1080p/ }).click();
  await expect(page).toHaveURL(/\/upgrade$/);
});

test('Remix Advanced: model chips are catalog names fit for the tool; settings without a run parameter are gone', async ({ page, context }) => {
  await stubApi(page, context, { creationMode: 'advanced' });
  await page.goto('/create/remix');
  const model = page.locator('main aside [data-group="model"]');
  await expect(model.getByRole('button')).toHaveText(['Auto', 'Reel Two', 'Quiet One']);
  for (const gone of ['motion', 'refw', 'fps', 'count', 'outfit']) await expect(page.locator(`main aside [data-group="${gone}"]`)).toHaveCount(0);
  await expect(page.locator('main aside [data-group="seed"]')).toBeVisible();
  // Picking a model without audio and other ratios refits the settings and drops the audio pill.
  await model.getByRole('button', { name: 'Quiet One' }).click();
  await expect(pill(page, 'model')).toHaveText('Quiet One');
  await expect(pill(page, 'ratio')).toHaveText('4:3');
  // 8s isn't offered: the closest length the model takes.
  await expect(pill(page, 'duration')).toHaveText('10s');
  await expect(pill(page, 'audio')).toHaveCount(0);
  await expect(page.locator('main aside [data-group="res"]').getByRole('button')).toHaveText(['480p', '720p']);
  await expectNoDemo(page);
});

test('Remix: presets load the public library, a picked pose shows in its row, and the run carries it with the real settings', async ({ page, context }) => {
  const calls = await stubApi(page, context);
  await page.goto('/create/remix');
  const action = page.locator('[data-preset="action"]');
  await expect(action).toContainText('Not set');
  await expect(page.locator('[data-preset="outfit"]')).toContainText('Not set');
  await action.click();
  const picker = page.getByRole('dialog', { name: 'Action' });
  await expect(picker.getByRole('tab')).toHaveText(['Poses', 'Depth poses']);
  await expect(picker.getByRole('option')).toHaveCount(24);
  // Infinite scroll: the next page loads at the end of the grid.
  await picker.getByRole('option').last().scrollIntoViewIfNeeded();
  await expect(picker.getByRole('option')).toHaveCount(30);
  await picker.getByRole('searchbox').fill('number 7');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await picker.getByRole('option', { name: /Pose number 7/ }).click();
  await expect(action).toContainText('Pose number 7');
  expect(calls.library.every((v) => v.category === 'pose' || v.category === 'pose_depth')).toBe(true);

  await page.locator('[data-preset="outfit"]').click();
  const outfits = page.getByRole('dialog', { name: 'Full outfit' });
  await expect(outfits.getByRole('tab')).toHaveText(['Outfits', 'Anime outfits', 'Historical']);
  await outfits.getByRole('option', { name: /Linen suit/ }).click();
  await expect(page.locator('[data-preset="outfit"]')).toContainText('Linen suit');

  // The reference video goes through the shared upload queue.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-remix-video]').click();
  await (await chooser).setFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) });
  await expect(page.locator('[data-remix-video]')).toContainText('clip.mp4');

  // Settings change, then the live quote and Generate.
  await pill(page, 'ratio').click();
  await params(page).getByRole('radio', { name: '1:1' }).click();
  await page.keyboard.press('Escape');
  await composer(page).getByRole('textbox').fill('Two people walk in');
  await expect(composer(page)).toContainText('137 credits');
  const before = calls.quotes.length;
  await composer(page).getByRole('button', { name: 'Generate video', exact: true }).click();
  await expect.poll(() => calls.runs.length).toBe(1);
  const spec = calls.quotes.slice(before).at(-1)!.promptSpec as Record<string, any>;
  expect(spec).toMatchObject({ kind: 'remix', model: 'auto', ratio: '1:1', seconds: 8, resolution: '720p', audio: true });
  expect(spec.inputs.referenceAssetIds).toEqual(expect.arrayContaining(['ast_pose_6', 'ast_outfit_1']));
  expect(typeof spec.inputs.videoAssetId).toBe('string');
  expect(spec.prompt).toContain('a beige linen suit');
  // The run card's tags use the same settings.
  await expect(page.locator('main article').first()).toContainText('1:1');
  await expect(page.locator('main article').first()).toContainText('8s');
  await expectNoDemo(page);
});

test('Quick Create, Avatar and Characters: empty prompts, catalog pills, no demo content; Avatar shows voices as not available yet', async ({ page, context }) => {
  await stubApi(page, context);
  await page.goto('/create/quick');
  await expect(composer(page).getByRole('textbox')).toHaveValue('');
  await expect(composer(page).getByRole('textbox')).toHaveAttribute('placeholder', /Say what to change/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quick Create');
  await expect(pill(page, 'ratio')).toHaveText('21:9');
  await expect(pill(page, 'duration')).toHaveText('8s');
  await expect(page.locator('[data-card="lines"]')).toHaveCount(0);
  await expectNoDemo(page);

  await page.goto('/create/avatar');
  await expect(composer(page).getByRole('textbox')).toHaveValue('');
  await expect(page.locator('[data-voice-unavailable]')).toContainText('aren’t available yet');
  await expect(page.locator('[data-look="character"]')).toContainText('Upload a photo');
  await expect(page.locator('[data-look="scene"]')).toContainText('The photo’s background');
  await expect(pill(page, 'ratio')).toHaveText('9:16');
  await expect(pill(page, 'res')).toHaveText('720p');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expectNoDemo(page);

  await page.goto('/create/character');
  await expect(composer(page).getByRole('textbox')).toHaveValue('');
  await expect(page.getByLabel('Age')).toHaveValue('');
  await expect(pill(page, 'views')).toHaveText('2 views');
  await expect(pill(page, 'res')).toHaveText('2K');
  await pill(page, 'res').click();
  // Image runs: sizes from the model (4K locked on Starter), no ratio or count the tool doesn't send.
  await expect(params(page).getByRole('radiogroup', { name: 'Aspect ratio' })).toHaveCount(0);
  await expect(params(page).getByRole('radiogroup', { name: 'Images' })).toHaveCount(0);
  await expect(params(page).getByRole('radiogroup', { name: 'Resolution' }).getByRole('radio')).toHaveCount(3);
  await expectNoDemo(page);
});

test('Remix Advanced: "Apply outfit to" lists only the characters added to this remix', async ({ page, context }) => {
  await stubApi(page, context, { creationMode: 'advanced' });
  await page.goto('/create/remix');
  const outfit = page.locator('main aside [data-group="outfit"]');
  await expect(outfit).toHaveCount(0);
  await page.locator('[data-preset="outfit"]').click();
  await page.getByRole('dialog', { name: 'Full outfit' }).getByRole('option', { name: /Linen suit/ }).click();
  // An outfit but nobody to wear it yet: still hidden.
  await expect(outfit).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-slot="1"]').click();
  await (await chooser).setFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await expect(outfit.getByRole('button')).toHaveText(['All characters', 'Character 2']);
});
