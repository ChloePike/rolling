import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support/fidelity';
import { mockPublicLibrary } from './support/publicLibrary';

/**
 * "A canvas" always means a real project (features/canvas/target): the
 * sidebar Canvas item (last opened → most recent → a new blank canvas),
 * send-to-canvas from Assets, Activity and the public library through
 * "Choose a canvas" (the item lands as a selected asset node in view), and the
 * not-found canvas page's actions. Mock seams: `__rollingMocks.projects`,
 * `missingProjects`, `foreignProjects`.
 */

const LAST = 'rolling.canvas.last.usr_alex.ws_personal';
const CREATED = 'rolling.mock.projects';
const HOUR = 3_600_000;

async function seams(page: Page, mocks: Record<string, unknown>, storage: Record<string, string> = {}) {
  await page.addInitScript(
    ([m, s]) => {
      const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
      w.__rollingMocks = { ...w.__rollingMocks, ...(m as Record<string, unknown>) };
      // Seed once per test (init scripts run on every navigation).
      if (!sessionStorage.getItem('seeded')) {
        for (const [k, v] of Object.entries(s as Record<string, string>)) localStorage.setItem(k, v);
        sessionStorage.setItem('seeded', '1');
      }
    },
    [mocks, storage] as const,
  );
}

const navCanvas = (page: Page) => page.getByTestId('main-nav').getByRole('link', { name: 'Canvas' });

/** The inserted node: on the canvas, selected and inside the viewport. */
async function expectInserted(page: Page, title: string) {
  const node = page.locator('.react-flow__node', { has: page.locator('[data-node-kind="asset"]', { hasText: title }) });
  await expect(node).toHaveCount(1, { timeout: 10_000 });
  await expect(node).toHaveClass(/selected/);
  await expect(page.getByText(/Asset added to the canvas/)).toBeVisible();
  await expect
    .poll(async () => {
      const b = await node.boundingBox();
      const v = page.viewportSize()!;
      return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= v.width && b.y + b.height <= v.height;
    })
    .toBe(true);
}

test.describe('sidebar Canvas item', () => {
  test('opens the last canvas the user opened in this workspace', async ({ page }) => {
    const now = Date.now();
    await seams(page, { projects: [{ id: 'prj_recent', title: 'Recent', updatedAt: now - HOUR }, { id: 'prj_last', title: 'Last', updatedAt: now - 5 * HOUR }] }, { [LAST]: 'prj_last' });
    await openApp(page, '/');
    await navCanvas(page).click();
    await expect(page).toHaveURL(/\/p\/prj_last$/);
    await expect(page.getByTestId('canvas')).toBeVisible();
    // Opening another canvas makes it the last one.
    await page.goto('/p/prj_recent');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LAST)).toBe('prj_recent');
    await page.goto('/activity');
    await navCanvas(page).click();
    await expect(page).toHaveURL(/\/p\/prj_recent$/);
  });

  test('without a last canvas (or a stale one) opens the most recently updated project', async ({ page }) => {
    const now = Date.now();
    await seams(
      page,
      { projects: [{ id: 'prj_older', title: 'Older', updatedAt: now - 5 * HOUR }, { id: 'prj_newest', title: 'Newest', updatedAt: now - HOUR }], missingProjects: ['prj_stale'] },
      { [LAST]: 'prj_stale' },
    );
    await openApp(page, '/');
    await navCanvas(page).click();
    await expect(page).toHaveURL(/\/p\/prj_newest$/);
    await expect(page.getByTestId('canvas-error')).toHaveCount(0);
    // The stale id was forgotten, then the opened canvas remembered.
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LAST)).toBe('prj_newest');
  });

  test('with no projects creates one blank canvas and opens it, even on a double click', async ({ page }) => {
    await seams(page, { projects: [] });
    await openApp(page, '/');
    await navCanvas(page).dblclick();
    await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
    await expect(page.getByTestId('canvas')).toBeVisible();
    const created = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as Array<{ id: string; title: string }>, CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('Untitled project');
    expect(page.url()).toContain(created[0]!.id);
    // Next time it is the last canvas: no second project.
    await page.goto('/');
    await navCanvas(page).click();
    await expect(page).toHaveURL(new RegExp(`/p/${created[0]!.id}$`));
    expect(await page.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '[]') as unknown[]).length, CREATED)).toBe(1);
  });

  test('two tabs with no projects still make only one', async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    for (const p of [a, b]) await seams(p, { projects: [] });
    await Promise.all([openApp(a, '/'), openApp(b, '/')]);
    await Promise.all([navCanvas(a).click(), navCanvas(b).click()]);
    await expect(a).toHaveURL(/\/p\/prj_/);
    await expect(b).toHaveURL(/\/p\/prj_/);
    expect(new URL(a.url()).pathname).toBe(new URL(b.url()).pathname);
    expect(await a.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '[]') as unknown[]).length, CREATED)).toBe(1);
  });
});

test.describe('send to canvas', () => {
  test('Assets → Add to canvas → choose a canvas: the asset lands selected and in view', async ({ page }) => {
    await openApp(page, '/assets');
    await page.locator('[data-asset]', { hasText: 'Pack front.png' }).click();
    await page.getByRole('complementary', { name: 'Asset details' }).getByRole('button', { name: 'Add to canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a canvas' });
    await expect(dialog).toContainText('Pack front.png is added to the canvas you pick.');
    await expect(dialog.getByRole('button', { name: /Ridgeline Sparkling · 15s ad/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/prj_demo$/);
    await expectInserted(page, 'Pack front.png');
    // The token is used once: a reload adds nothing more.
    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByText(/Asset added to the canvas/)).toHaveCount(0);
  });

  test('Activity → View → Send to canvas → New canvas', async ({ page }) => {
    await openApp(page, '/activity');
    await page.getByRole('button', { name: 'View Talking head · Desk organizer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send to canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a canvas' });
    await dialog.getByTestId('choose-canvas-new').click();
    await expect(page).toHaveURL(/\/p\/prj_(?!demo)[a-z0-9]+$/);
    await expectInserted(page, 'Talking head · Desk organizer');
    expect(await page.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '[]') as unknown[]).length, CREATED)).toBe(1);
  });

  test('public library → Add to canvas → choose a canvas', async ({ page }) => {
    await mockPublicLibrary(page, (category) =>
      category === 'pose' || category === null
        ? [{ id: 'pw_pose_1', category: 'pose', sub: 'sitting', title: 'Side sit, chin on hand', promptEn: 'Sitting', tags: [], assetId: 'ast_pw_pose_1', license: 'FIRST_PARTY', source: 'https://posewear.pages.dev/#pose/1' }]
        : [],
    );
    await openApp(page, '/assets/public');
    await page.getByRole('complementary', { name: 'Asset details' }).getByRole('button', { name: 'Add to canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a canvas' });
    await dialog.getByRole('button', { name: /Ridgeline Sparkling · 15s ad/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_demo$/);
    await expectInserted(page, 'Side sit, chin on hand');
  });

  test('Cancel and Escape close the picker without leaving', async ({ page }) => {
    await openApp(page, '/assets');
    await page.getByRole('complementary', { name: 'Asset details' }).getByRole('button', { name: 'Add to canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a canvas' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('complementary', { name: 'Asset details' }).getByRole('button', { name: 'Add to canvas' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/assets$/);
  });
});

test.describe('canvas not found', () => {
  test('keeps the copy, forgets the stale last canvas, and offers your canvases and a new one', async ({ page }) => {
    await seams(page, {}, { [LAST]: 'prj_missing_1' });
    await openApp(page, '/p/prj_missing_1');
    const error = page.getByTestId('canvas-error');
    await expect(error).toHaveAttribute('data-reason', 'NOT_FOUND');
    await expect(error.getByRole('heading')).toHaveText('This canvas doesn’t exist');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LAST)).toBeNull();
    await expect(page.getByTestId('canvas-error-workspace')).toHaveCount(0);
    await error.getByRole('link', { name: 'Go to your canvases' }).click();
    await expect(page).toHaveURL(/\/#projects$/);
    await page.goto('/p/prj_missing_2');
    await page.getByTestId('canvas-error').getByRole('button', { name: 'New canvas' }).click();
    await expect(page).toHaveURL(/\/p\/prj_(?!missing)[a-z0-9]+$/);
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('a project in another workspace offers to switch there', async ({ page }) => {
    await seams(page, { foreignProjects: { prj_team1: 'ws_ridgeline' } });
    await openApp(page, '/p/prj_team1');
    const offer = page.getByTestId('canvas-error-workspace');
    await expect(offer).toContainText('This canvas is in Ridgeline brand team.');
    await offer.getByRole('button', { name: 'Switch to Ridgeline brand team' }).click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('canvas-error')).toHaveCount(0);
  });
});
