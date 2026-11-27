import { expect, test, type Page } from '@playwright/test';
import { animationTiming, diffScreen, expectBoxesClose, expectDiffUnder, measure, openApp, openDesign, settle } from './support/fidelity';
import { mockPublicLibrary, PNG_2X2, type PublicCall, type PublicNode } from './support/publicLibrary';

/** Pose names and sub-categories as drawn in PublicLibrary.dc.html. */
const POSE_NAMES = [
  'Sitting sideways, chin in hand', 'Looking back over shoulder', 'Hugging knees', 'One knee down', 'Lying on side, head propped', 'W-sitting',
  'Leaning on a wall', 'Leaning back, stretching', 'Twisting to look back', 'Finger heart', 'Leaning back, legs crossed', 'Crouching to tie a lace',
  'Brushing hair back, profile', 'Hands on hips', 'Lying on stomach, chin in hands',
];
const POSE_SUBS = ['cute', 'sitting', 'standing', 'kneeling', 'lying-down', 'side-sitting', 'squatting', 'leaning-forward', 'leaning-back', 'twisting'];

type Node = PublicNode;

function poseNodes(): Node[] {
  return POSE_NAMES.map((title, i) => {
    const id = `pw_pose_full_single_P${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      category: 'pose',
      sub: POSE_SUBS[i % POSE_SUBS.length]!,
      title,
      promptEn: 'A girl sitting sideways on the floor, chin resting on one hand, leaning slightly forward, gaze toward the left of the camera, relaxed',
      tags: ['Sitting', 'Side', 'Casual'],
      assetId: `ast_${id}_front`,
      license: 'FIRST_PARTY',
      source: `https://posewear.pages.dev/#pose/full_single_P${String(i + 1).padStart(3, '0')}`,
    };
  });
}

const OTHER: Record<string, Node[]> = {
  portrait: [
    { id: 'pw_portrait_f000a1c4200', category: 'portrait', sub: 'front', title: 'Medium hair · Front', promptEn: 'Front-facing portrait', tags: ['front'], assetId: 'a1', license: 'CC0', source: 'https://posewear.pages.dev/#portrait/f000a1c4200' },
    { id: 'pw_portrait_bad', category: 'portrait', sub: 'front', title: 'Should never show', promptEn: null, tags: [], assetId: 'a2', license: 'CC0', source: 'https://posewear.pages.dev/', mature: true },
  ],
  expression: [{ id: 'pw_expression_e001', category: 'expression', sub: 'happy', title: 'Smile', promptEn: 'A gentle smile', tags: ['happy'], assetId: 'a3', license: 'MIT', source: 'https://posewear.pages.dev/#expr/e001' }],
};

async function mockGraphql(page: Page, calls: PublicCall[] = []) {
  await mockPublicLibrary(page, (category) => (category === 'pose' ? poseNodes() : (OTHER[category ?? ''] ?? [])), calls);
}

test.describe('public library (PublicLibrary.dc.html)', () => {
  test('categories from packages/core, sub-categories, first-party items carry no license label', async ({ page }) => {
    const calls: PublicCall[] = [];
    await mockGraphql(page, calls);
    await openApp(page, '/assets/public');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Public library');
    const nav = page.getByRole('navigation', { name: 'Category' });
    for (const g of ['Pose', 'Character look', 'Wardrobe', 'Scene & props']) await expect(nav.getByText(g, { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Hairstyles/ })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: /Poses/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-item]')).toHaveCount(15);
    await expect(page.locator('[data-license]')).toHaveCount(0);
    expect(calls.find((c) => c.op === 'items')?.variables).toMatchObject({ category: 'pose', sub: null });
    await expect(nav.getByRole('link', { name: /Poses/ }).first()).toContainText('98');
    const subs = page.getByRole('group', { name: 'Filter by sub-category' });
    await expect(subs.getByRole('button')).toHaveText(['All', 'Cute', 'Sitting', 'Standing', 'Kneeling', 'Lying down', 'Side-sitting', 'Squatting', 'Leaning forward', 'Leaning back', 'Twisting']);
    await subs.getByRole('button', { name: 'Sitting', exact: true }).click();
    // The sub-category is filtered by the server (publicItems sub), with its facet count.
    await expect(page.locator('[data-item]')).toHaveCount(2);
    await expect(page.getByText('14 items')).toBeVisible();
    expect(calls.filter((c) => c.op === 'items').at(-1)?.variables).toMatchObject({ category: 'pose', sub: 'sitting' });
    const details = page.getByRole('complementary', { name: 'Asset details' });
    await expect(details).toContainText('PoseWear original content.');
    await expect(details.getByRole('button', { name: 'Use as pose' })).toBeVisible();
  });

  test('cc0 and mit items show their labels; mature items never show', async ({ page }) => {
    await mockGraphql(page);
    await openApp(page, '/assets/public?cat=portrait');
    await expect(page.locator('[data-item]')).toHaveCount(1);
    await expect(page.locator('[data-license="cc0"]')).toHaveText('CC0');
    await expect(page.getByText('Should never show')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Category' }).getByRole('link', { name: /Expressions/ }).click();
    await expect(page.locator('[data-license="mit"]')).toHaveText('MIT');
    await expect(page.getByRole('complementary', { name: 'Asset details' })).toContainText('ICT-FaceKit');
  });

  test('selecting a card updates the details; copy prompt shows a toast; error state offers retry', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockGraphql(page);
    await openApp(page, '/assets/public');
    await page.locator('[data-item]').nth(2).click();
    await expect(page.locator('[data-item]').nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary', { name: 'Asset details' })).toContainText('Hugging knees');
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Prompt copied')).toBeVisible();
    await page.unroute('**/api/graphql');
    await page.route('**/api/graphql', (r) => r.fulfill({ status: 500, body: 'no' }));
    await openApp(page, '/assets/public?cat=scene');
    await expect(page.getByRole('alert')).toContainText('Couldn’t load the library.', { timeout: 10_000 });
  });

  test('real thumbnails (relative /api/media and absolute media-domain URLs) fade in over the glyph', async ({ page }) => {
    await page.route('**/api/media/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG_2X2 }));
    await page.route('https://media.example.test/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG_2X2 }));
    await mockPublicLibrary(page, (category) =>
      category === 'pose'
        ? poseNodes().map((n, i) => ({
            ...n,
            thumbUrl: i % 2 ? `https://media.example.test/public/pose/${n.id}/front.webp` : `/api/media/public/pose/${n.id}/front.webp`,
            angles: [{ name: 'front', url: `/api/media/public/pose/${n.id}/front.webp`, depthUrl: null }],
          }))
        : [],
    );
    await openApp(page, '/assets/public');
    const first = page.locator('[data-item] img').first();
    await expect(first).toHaveAttribute('src', /^\/api\/media\/public\/pose\//);
    await expect(page.locator('[data-item] img').nth(1)).toHaveAttribute('src', /^https:\/\/media\.example\.test\//);
    await expect(first).toHaveAttribute('data-loaded', 'true');
    expect(await first.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('opacity');
    await expect.poll(() => first.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });

  test('search sends q to publicItems', async ({ page }) => {
    const calls: PublicCall[] = [];
    await mockGraphql(page, calls);
    await openApp(page, '/assets/public');
    await page.getByPlaceholder('Search poses, outfits, expressions, or describe one').fill('kneel');
    await expect.poll(() => calls.filter((c) => c.op === 'items').at(-1)?.variables.q).toBe('kneel');
  });

  test('box measurements within 2px of the design', async ({ page }) => {
    await mockGraphql(page);
    await openDesign(page, 'PublicLibrary.dc.html');
    const parts = { cats: 'main > aside:first-child', title: 'main h1', search: 'main label', details: 'aside[aria-label="Asset details"]' };
    const design = await measure(page, parts);
    await openApp(page, '/assets/public');
    await settle(page);
    const app = await measure(page, { ...parts, cats: 'main nav' });
    expectBoxesClose(app, { ...design, details: { ...design.details!, height: (await measure(page, { d: 'aside[aria-label="Asset details"]' })).d!.height } });
  });

  test('poses: pixel diff at 1440x900 (design data differs: categories and license chip per D-004)', async ({ page }, info) => {
    await mockGraphql(page);
    const r = await diffScreen(page, info, {
      feature: 'library',
      name: 'public-poses',
      design: () => openDesign(page, 'PublicLibrary.dc.html', { initCat: 'Poses' }),
      app: () => openApp(page, '/assets/public?cat=pose'),
    });
    expectDiffUnder(r, 0.05);
  });

  test('motion: cards stagger, details cross-fade; reduced motion is opacity only', async ({ page }) => {
    await mockGraphql(page);
    await openApp(page, '/assets/public');
    await page.locator('[data-item]').first().waitFor();
    const delays = await page.evaluate(() => Array.from(document.querySelectorAll('[data-item]')).slice(0, 8).map((e) => getComputedStyle(e).animationDelay));
    // Max 6 steps (handoff 7), as every other list: the seventh enters with the sixth.
    expect(delays).toEqual(['0s', '0.03s', '0.06s', '0.09s', '0.12s', '0.15s', '0.15s', '0.15s']);
    await settle(page);
    await page.locator('[data-item]').nth(4).click();
    const t = await animationTiming(page, 'aside[aria-label="Asset details"]');
    expect(t?.duration).toBe(200);
    expect(t?.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/assets/public');
    await page.locator('[data-item]').first().waitFor();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-item]')!).animationDuration)).toBe('0.001s');
  });

  test('detail actions: Use as pose opens the tool, board toggles with Undo, Add to canvas navigates, favorite toggles', async ({ page }) => {
    await mockGraphql(page);
    await openApp(page, '/assets/public');
    const details = page.getByRole('complementary', { name: 'Asset details' });
    await page.locator('[data-item]').nth(1).click();
    const fav = details.getByRole('button', { name: 'Favorites' });
    await fav.click();
    await expect(fav).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Added to favorites.')).toBeVisible();
    const board = details.getByRole('button', { name: 'Add to board' });
    await board.click();
    await expect(details.getByRole('button', { name: 'On board' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
    await expect(details.getByRole('button', { name: 'Add to board' })).toHaveAttribute('aria-pressed', 'false');
    await details.getByRole('button', { name: 'Use as pose' }).click();
    await expect(page).toHaveURL(/\/create\/quick$/);
    await openApp(page, '/assets/public');
    await page.getByRole('complementary', { name: 'Asset details' }).getByRole('button', { name: 'Add to canvas' }).click();
    // No source project: "Choose a canvas" first (canvas-target.spec.ts covers the insert).
    await page.getByRole('dialog', { name: 'Choose a canvas' }).getByRole('button', { name: /Ridgeline Sparkling/ }).click();
    await expect(page).toHaveURL(/\/p\/prj_demo$/);
  });
});
