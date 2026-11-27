import { expect, test, type Locator, type Page } from '@playwright/test';
import { account, env, getJson, openCanvas, seedProject, shot, watchErrors } from './support';

/**
 * Matrix: PICK-1 … PICK-3. The AssetPicker modal (one modal for every media pick); every upload goes into
 * Assets first (straight to R2 through the transfer queue, D-011). Nothing here spends credits.
 */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const PNG = { mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d4b0b4f20000000049454e44ae426082', 'hex') };

function picker(page: Page, title?: string | RegExp): Locator {
  const d = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator('[data-picker-scroll]') });
  return title ? d.filter({ has: page.getByRole('heading', { name: title, exact: typeof title === 'string' }) }) : d;
}

async function expectPicker(page: Page, title: string | RegExp) {
  const d = picker(page, title);
  await expect(d).toBeVisible({ timeout: 20_000 });
  await expect(d.getByRole('button', { name: 'Upload' })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeVisible();
  return d;
}

test('PICK-1 every media entry point opens the same AssetPicker modal (Home prompt box, Quick Create composer and slot, Remix, Avatar, Character, canvas rail and prompt); Esc closes it', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(4 * 60_000);
  await account(context, baseURL, 'pickentry', 'plus');
  const errs = watchErrors(page);
  const p = await seedProject(page.request, baseURL, 'Picker', []);
  const cases: Array<{ path: string; open: (p: Page) => Promise<void>; title: string | RegExp }> = [
    {
      path: '/',
      open: async (pg) => {
        await pg.getByRole('button', { name: 'Add assets or skills' }).first().click();
        await pg.getByRole('menuitem', { name: 'Choose from Assets' }).click();
      },
      title: 'Choose from Assets',
    },
    { path: '/create/quick', open: (pg) => pg.getByTestId('tool-composer').getByRole('button', { name: 'Add assets or skills' }).click(), title: 'Add assets or skills' },
    { path: '/create/remix', open: (pg) => pg.locator('[data-preset]').first().click(), title: /.+/ },
    { path: '/create/avatar', open: (pg) => pg.locator('[data-look="character"]').click(), title: 'Character' },
    { path: '/create/character', open: (pg) => pg.locator('[data-ref-slot="face"]').click(), title: 'Face reference' },
    { path: `/p/${p.id}`, open: (pg) => pg.getByRole('button', { name: 'Assets', exact: true }).click(), title: 'Add assets to the canvas' },
  ];
  for (const c of cases) {
    if (c.path.startsWith('/p/')) await openCanvas(page, p.id);
    else await page.goto(c.path);
    await c.open(page);
    const d = await expectPicker(page, c.title);
    await expect(d).toHaveAttribute('aria-modal', 'true');
    await expect(d.getByRole('tab', { name: 'My assets' })).toBeVisible();
    await expect(d.getByRole('tab', { name: 'Public library' })).toBeVisible();
    if (c.path === '/create/avatar') await shot(page, testInfo, 'picker-avatar');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
  }
  errs.assertClean();
});

test('PICK-2 upload from the picker: the file goes straight to R2, becomes an asset, is selected and used, and is listed in Assets', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(3 * 60_000);
  await account(context, baseURL, 'pickupload', 'plus');
  // No upload bytes go through /api (D-011; the transfer SharedWorker PUTs to R2, UP-2 checks the hosts).
  const viaApi: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/')) viaApi.push(r.url());
  });
  await page.goto('/create/quick');
  await page.getByTestId('tool-composer').getByRole('button', { name: 'Add assets or skills' }).click();
  const d = await expectPicker(page, 'Add assets or skills');
  const name = `picker-${Date.now().toString(36)}.png`;
  await d.getByTestId('picker-upload-input').setInputFiles({ name, ...PNG });
  const stem = name.replace(/\.png$/, '');
  const option = d.locator('[role="option"][data-asset^="ast_"]').filter({ hasText: stem }).first();
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 90_000 });
  await shot(page, testInfo, 'picker-uploaded');
  await d.getByRole('button', { name: /^(Use|Add)/ }).last().click();
  await expect(d).toHaveCount(0);
  await expect(page.getByTestId('tool-composer').locator('[data-ref^="@picker"]')).toBeVisible();
  expect(viaApi).toEqual([]);
  await expect.poll(async () => (await getJson<{ items: Array<{ id: string; name: string }> }>(page.request, '/api/assets?first=20')).items.some((a) => a.name === name), { timeout: 60_000 }).toBe(true);
  await page.goto('/assets');
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
});

test('PICK-3 canvas rail Assets: picking one of my assets adds an asset node with its name', async ({ page, context, baseURL }) => {
  test.setTimeout(3 * 60_000);
  await account(context, baseURL, 'pickcanvas', 'plus');
  await page.goto('/assets');
  const name = `rail-${Date.now().toString(36)}.png`;
  await page.getByTestId('assets-file').setInputFiles({ name, ...PNG });
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 90_000 });
  // The Assets page shows the upload from the transfer queue at once; the server lists it a few seconds later.
  await expect.poll(async () => (await getJson<{ items: Array<{ name: string }> }>(page.request, '/api/assets?first=20')).items.some((a) => a.name === name), { timeout: 60_000 }).toBe(true);
  const p = await seedProject(page.request, baseURL, 'Rail', []);
  await openCanvas(page, p.id);
  const before = await page.locator('.react-flow__node').count();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  const d = await expectPicker(page, 'Add assets to the canvas');
  const option = d.locator('[role="option"][data-asset^="ast_"]').filter({ hasText: name.replace(/\.png$/, '') }).first();
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(d.getByText('1 selected')).toBeVisible();
  await d.getByRole('button', { name: 'Add to canvas' }).click();
  await expect(d).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(page.locator('[data-node-kind="asset"]').first()).toBeVisible();
});
