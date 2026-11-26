import { expect, test, type Locator, type Page } from '@playwright/test';
import { account, env, getJson, shot, watchErrors } from './support';

/** Matrix: PROMPT-1 … PROMPT-7. Non-member accounts: “send” opens the join paywall, so nothing can spend. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

interface CatalogModel {
  id: string;
  kind: string;
  name: string;
  placement: 'featured' | 'more' | 'tool';
  resolutions?: string[];
  seconds?: { min: number; max: number } | null;
}

async function openPicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Model:|Auto model/ }).first().click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await expect(picker).toBeVisible();
  const more = picker.getByRole('button', { name: /^More models/ });
  if (await more.isVisible().catch(() => false)) await more.click();
  return picker;
}

test('PROMPT-1 model picker (video and image): curated list, Auto first, Berry shown as Wan, no face/head swap or tool models', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'picker');
  const { models } = await getJson<{ models: CatalogModel[] }>(page.request, '/api/models');
  // Catalog contract (D-009): Berry ids carry Wan names; alibaba/wan3.0 ids are hidden; swaps are tool-only.
  expect(models.find((m) => m.id === 'lumina/berry-1.0')?.name).toBe('Wan 3.0');
  expect(models.some((m) => m.id.startsWith('alibaba/wan3.0'))).toBe(false);
  for (const m of models.filter((x) => /swap|lora|animate|face-detect/i.test(x.id))) expect(m.placement, m.id).toBe('tool');

  await page.goto('/');
  for (const mode of ['Video', 'Image'] as const) {
    await page.getByRole('tab', { name: mode, exact: true }).click();
    const picker = await openPicker(page);
    await shot(page, testInfo, `picker-${mode}`);
    const text = (await picker.innerText()).replace(/\s+/g, ' ');
    expect(text).toContain('Auto model');
    expect(text).not.toMatch(/Berry/i);
    expect(text).not.toMatch(/Face Swap|Head Swap|Wan Animate|LoRA|Face detect/i);
    const kind = mode.toLowerCase();
    for (const m of models.filter((x) => x.kind === kind && x.placement !== 'tool')) expect(text, `${m.name} listed`).toContain(m.name);
    for (const m of models.filter((x) => x.kind !== kind && x.kind !== 'chat' && x.placement !== 'tool')) {
      if (!models.some((y) => y.kind === kind && y.name.includes(m.name))) expect(text, `${m.name} (other kind) not listed`).not.toContain(m.name);
    }
    // Panel caps its height to the viewport and scrolls inside.
    const box = (await picker.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(900 + 1);
    await page.keyboard.press('Escape');
  }
});

test('PROMPT-2 params follow the chosen model’s capabilities (resolutions, duration range)', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'params', 'pro');
  const { models } = await getJson<{ models: CatalogModel[] }>(page.request, '/api/models');
  await page.goto('/');
  await page.getByRole('tab', { name: 'Video', exact: true }).click();
  for (const id of ['bytedance/seedance-2.0-mini', 'minimax/minimax-h3']) {
    const m = models.find((x) => x.id === id)!;
    const picker = await openPicker(page);
    await picker.getByText(m.name, { exact: true }).first().click();
    await expect(page.getByRole('button', { name: new RegExp(`^Model: ${m.name}|${m.name}`) }).first()).toBeVisible();
    // The settings pill shows a resolution the model supports.
    const pill = page.getByRole('button', { name: new RegExp(`(${m.resolutions!.join('|')})`) }).first();
    await pill.click();
    const pop = page.getByRole('dialog', { name: /Video settings/ });
    await expect(pop).toBeVisible();
    for (const r of m.resolutions!) await expect(pop.getByRole('radio', { name: new RegExp(`^${r}`) }).or(pop.getByRole('button', { name: new RegExp(`^${r}`) })).first()).toBeVisible();
    for (const r of ['480p', '720p', '1080p', '4K', '768p', '2K'].filter((x) => !m.resolutions!.includes(x))) {
      await expect(pop.getByRole('radio', { name: new RegExp(`^${r}\\b`) })).toHaveCount(0);
    }
    await expect(pop).toContainText(`Max ${m.seconds!.max}s`);
    await shot(page, testInfo, `params-${id.replace('/', '_')}`);
    await page.keyboard.press('Escape');
  }
});

test('PROMPT-3 @ opens the reference picker with every source; a public item becomes a chip', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'atref');
  await page.goto('/');
  const brief = page.locator('#brief');
  await brief.fill('A bottle with ');
  await brief.press('End');
  await brief.type('@');
  const picker = page.getByTestId('reference-picker');
  await expect(picker).toBeVisible();
  for (const tab of ['All', 'My assets', 'Characters', 'Voices', 'Public library']) await expect(picker.getByRole('tab', { name: tab })).toBeVisible();
  await picker.getByRole('tab', { name: 'Public library' }).click();
  await expect(picker.getByText('Public library · from PoseWear')).toBeVisible({ timeout: 20_000 });
  const first = picker.getByRole('option').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(first).toContainText('Public');
  await first.click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ref-chips')).toBeVisible();
  await expect(page.getByTestId('ref-chips').getByRole('button', { name: 'Remove reference' }).first()).toBeVisible();
  await shot(page, testInfo, 'at-chip');
  await page.keyboard.press('Escape');
});

test('PROMPT-4 Enter sends, Shift+Enter adds a line, Enter during IME composition does not send', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'enter');
  await page.goto('/');
  const brief = page.locator('#brief');
  const paywall = page.getByRole('dialog').filter({ hasText: 'Pick a plan to generate' });
  await brief.fill('first line');
  await brief.press('Shift+Enter');
  await brief.type('second line');
  await expect(brief).toHaveValue('first line\nsecond line');
  await expect(paywall).toHaveCount(0);
  // IME: keydown Enter with isComposing (keyCode 229) must not send.
  await brief.focus();
  await page.evaluate(() => {
    const el = document.querySelector('#brief')!;
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'に' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  await expect(paywall).toHaveCount(0);
  await page.evaluate(() => document.querySelector('#brief')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' })));
  // A plain Enter sends (non-member → the join paywall proves the send happened).
  await brief.press('Enter');
  await expect(paywall).toBeVisible({ timeout: 20_000 });
});

test('PROMPT-5 “/” palette: grouped commands, filter, Esc clears', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'palette');
  await page.goto('/');
  const brief = page.locator('#brief');
  await brief.fill('/');
  const palette = page.getByRole('listbox', { name: 'Commands' }).or(page.getByRole('dialog', { name: 'Commands' })).first();
  await expect(palette).toBeVisible();
  for (const g of ['Skills', 'Create', 'Settings']) await expect(palette).toContainText(g);
  await brief.fill('/stor');
  await expect(palette.getByRole('option', { name: /Storyboard/ })).toBeVisible();
  await brief.fill('/zzzz');
  await expect(palette).toContainText('No matching commands');
  await brief.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('PROMPT-6 no demo literals: a fresh account sees no mock projects, names or numbers on Home and the tools', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'nodemo');
  const errs = watchErrors(page);
  const DEMO = /Ridgeline|Desk organizer pitch|Lead · Mia|alex@ridgeline|Sparkling · 15s ad|2,480 credits|Alex Chen/;
  for (const path of ['/', '/create/quick', '/create/remix', '/create/avatar', '/create/character', '/activity', '/assets', '/settings/billing', '/settings/team']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    const text = await page.locator('body').innerText();
    expect(text, `${path} has no demo literals`).not.toMatch(DEMO);
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
  // A fresh account owns no projects: only the “New project” tile.
  await expect(page.locator('a[href^="/p/prj_"]')).toHaveCount(0);
  await shot(page, testInfo, 'fresh-home');
  errs.assertClean();
});

test('PROMPT-7 the cost line shows a live quote for Image mode and “Planning uses no credits” for Agent', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'costline', 'plus');
  await page.goto('/');
  await expect(page.getByTestId('prompt-cost')).toContainText('Planning uses no credits');
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await page.locator('#brief').fill('A glass bottle on a rock at dawn');
  await expect(page.getByTestId('prompt-cost')).toContainText(/\d+\s+credits?/, { timeout: 20_000 });
});
