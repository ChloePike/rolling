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
    // The list loads after the panel opens (it says “No models match” meanwhile); models with placement `more`
    // sit behind “More models (N)”.
    await expect(picker.getByRole('button', { name: /\d+ \/ (\d+s|image)/ }).first()).toBeVisible({ timeout: 20_000 });
    const more = picker.getByRole('button', { name: /^More models/ });
    if (await more.isVisible().catch(() => false)) await more.click();
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
    // Resolutions the model lacks are absent, or shown disabled with a reason — never selectable.
    for (const r of ['480p', '720p', '1080p', '4K', '768p', '2K'].filter((x) => !m.resolutions!.includes(x))) {
      const opt = pop.getByRole('radio', { name: new RegExp(`^${r}\\b`) });
      if ((await opt.count()) === 0) continue;
      const disabled = (await opt.first().isDisabled()) || (await opt.first().getAttribute('aria-disabled')) === 'true';
      expect(disabled, `${m.name}: ${r} is not selectable`).toBe(true);
    }
    await expect(pop).toContainText(`Max ${m.seconds!.max}s`);
    // Seedance 2.0 Mini has no 1080p at all: not offered (not even locked).
    if (id === 'bytedance/seedance-2.0-mini') await expect(pop.getByRole('radio', { name: /^1080p/ })).toHaveCount(0);
    await shot(page, testInfo, `params-${id.replace('/', '_')}`);
    await page.keyboard.press('Escape');
  }
});

test('PROMPT-2 image count follows the model (Seedream 5.0 Flash = 1); plan locks still apply and a blocked quote shows its reason, not a number', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'paramslock', 'starter');
  const { models } = await getJson<{ models: Array<CatalogModel & { limits?: { imagesPerRequest?: number } }> }>(page.request, '/api/models');
  await page.goto('/');
  // Image: Seedream 5.0 Flash makes one image per run, so the count group is gone and the pill says 1.
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  const flash = models.find((x) => x.id === 'bytedance/seedream-5.0-flash')!;
  let picker = await openPicker(page);
  await picker.getByText(flash.name, { exact: true }).first().click();
  // Nothing to choose (one size, one image): the pills are read-only text, never an empty popover (UX audit #26).
  const sizePill = page.locator('[data-pill-static]').filter({ hasText: /1 image/ }).first();
  await expect(sizePill).toBeVisible();
  await expect(page.getByRole('button', { name: /1 image/ })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /Image settings/ })).toHaveCount(0);

  // Video on Starter (720p cap, D-006): a model with 1080p shows it locked; picking it opens the upgrade instead,
  // and the cost line never shows a number for a blocked quote.
  await page.getByRole('tab', { name: 'Video', exact: true }).click();
  const hd = models.find((x) => x.kind === 'video' && x.placement !== 'tool' && x.resolutions?.includes('1080p'));
  test.skip(!hd, 'no 1080p video model in the catalog');
  picker = await openPicker(page);
  await picker.getByText(hd!.name, { exact: true }).first().click();
  const pill = page.getByRole('button', { name: new RegExp(`(${hd!.resolutions!.join('|')})`) }).first();
  await pill.click();
  const pop = page.getByRole('dialog', { name: /Video settings/ });
  await expect(pop.getByRole('radio', { name: /^1080p.*Available on/ })).toBeVisible();
  const cost = page.getByTestId('prompt-cost');
  if (/1080p/.test(await pill.innerText())) {
    // The model's default is above the plan: the quote is blocked, so the line names the reason.
    await expect(cost).toContainText('isn’t on your plan');
    await expect(cost).not.toContainText(/\d+ credits/);
  } else {
    await expect(cost).toContainText(/\d/);
  }
  await page.keyboard.press('Escape');
  await shot(page, testInfo, 'params-locked');
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
  await picker.getByRole('button', { name: /^Add( \d+)?$/ }).click();
  await expect(page.getByTestId('ref-chips')).toBeVisible();
  await expect(page.getByTestId('ref-chips').getByRole('button', { name: 'Remove reference' }).first()).toBeVisible();
  await shot(page, testInfo, 'at-chip');
  await page.keyboard.press('Escape');
});

test('PROMPT-4 Enter sends, Shift+Enter adds a line, Enter during IME composition does not send', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'enter');
  await page.goto('/');
  const brief = page.locator('#brief');
  // A send by a non-member opens the upgrade modal (agent mode: “The agent needs a plan”, or “Payments aren’t available yet”).
  const paywall = page.getByRole('dialog').filter({ has: page.getByTestId('upgrade-modal') });
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
  await expect(page.locator('a[href^="/p/prj_"]:not([href="/p/prj_new"])')).toHaveCount(0);
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
