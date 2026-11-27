import { expect, test, type Page } from '@playwright/test';
import { mockPublicLibrary, PNG_2X2, type PublicCall, type PublicNode } from './support/publicLibrary';
import { picker, use } from './support/picker';

/**
 * D-005 mature public-library items, stubbed for both audiences (mock build).
 * The server decides who gets them (mature-allowed callers: plan, workspace
 * flag, preference on); the stub answers like it would for each audience. The
 * client still drops mature items for everyone else, marks them with the
 * "Mature" chip, and loads them only from signed private URLs.
 */
const SIGNED = (id: string) => `/media/public/pose/${id}/front.png?exp=4102444800&ws=_&sig=stubbed`;

const pose = (id: string, title: string, mature = false): PublicNode => ({
  id,
  category: 'pose',
  sub: 'standing',
  title,
  promptEn: `${title} prompt`,
  tags: [],
  assetId: `ast_${id}_front`,
  license: 'FIRST_PARTY',
  source: 'https://posewear.pages.dev/',
  mature,
  thumbUrl: mature ? SIGNED(id) : `/api/media/public/pose/${id}/front.webp`,
  angles: [{ name: 'front', url: mature ? SIGNED(id) : `/api/media/public/pose/${id}/front.webp`, depthUrl: null }],
});

const GENERAL = [pose('pw_pose_s1', 'Standing tall'), pose('pw_pose_s2', 'Arms crossed')];
const MATURE = [pose('pw_pose_m1', 'Close embrace', true), pose('pw_pose_m2', 'Leaning together', true)];

/** Routes GraphQL like the server does for one audience; counts follow the items. */
async function stub(page: Page, audience: 'general' | 'mature', calls: PublicCall[] = []) {
  const items = audience === 'mature' ? [...GENERAL, ...MATURE] : GENERAL;
  await mockPublicLibrary(page, (c) => (c === null || c === 'pose' ? items : []), calls);
  // Counts per audience (the shared stub has fixed counts).
  await page.route('**/api/graphql', async (route) => {
    const body = route.request().postDataJSON() as { query: string };
    if (body.query.includes('publicCategories')) return route.fulfill({ json: { data: { publicCategories: [{ key: 'pose', count: items.length }] } } });
    if (body.query.includes('publicSubCategories')) return route.fulfill({ json: { data: { publicSubCategories: [{ key: 'standing', count: items.length }] } } });
    return route.fallback();
  });
  await page.route('**/media/public/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG_2X2 }));
  await page.route('**/api/media/public/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG_2X2 }));
}

async function maturePref(page: Page, on: boolean) {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('rolling.prefs', JSON.stringify({ matureContent: value }));
      localStorage.setItem('rolling.creationMode', 'simple');
    } catch {
      /* ignore */
    }
  }, on);
}

test.describe('mature public-library items (D-005)', () => {
  test('mature-allowed viewers: mature items with the Mature chip, signed private image URLs, server counts', async ({ page }) => {
    await maturePref(page, true);
    const calls: PublicCall[] = [];
    await stub(page, 'mature', calls);
    await page.goto('/assets/public?cat=pose');
    await expect(page.locator('[data-item]')).toHaveCount(4);
    await expect(page.getByText('4 items')).toBeVisible();
    const card = page.locator('[data-item="pw_pose_m1"]');
    await expect(card.locator('[data-mature]')).toHaveText('Mature');
    await expect(page.locator('[data-item="pw_pose_s1"] [data-mature]')).toHaveCount(0);
    // Mature images only ever come from signed private URLs, never the public media route.
    const src = await card.locator('img').getAttribute('src');
    expect(src).toContain('sig=');
    expect(src).not.toContain('/api/media/');
    await card.click();
    await expect(page.getByRole('complementary', { name: 'Asset details' }).locator('[data-mature]')).toHaveText('Mature');
    // Members with mature content on may send it to a canvas (no refusal toast).
    await page.getByRole('button', { name: 'Add to canvas' }).click();
    await expect(page.getByText('Mature items can’t be added from the public library.')).toHaveCount(0);
  });

  test('everyone else: exactly the non-mature set and counts; a mature item that slips through is dropped', async ({ page }) => {
    await maturePref(page, false);
    // A misbehaving response with mature items: the client still drops them.
    await stub(page, 'mature');
    await page.route('**/api/graphql', async (route) => {
      const body = route.request().postDataJSON() as { query: string };
      if (body.query.includes('publicCategories')) return route.fulfill({ json: { data: { publicCategories: [{ key: 'pose', count: 2 }] } } });
      if (body.query.includes('publicSubCategories')) return route.fulfill({ json: { data: { publicSubCategories: [{ key: 'standing', count: 2 }] } } });
      return route.fallback();
    });
    await page.goto('/assets/public?cat=pose');
    await expect(page.locator('[data-item]')).toHaveCount(2);
    await expect(page.getByText('2 items')).toBeVisible();
    await expect(page.locator('[data-mature]')).toHaveCount(0);
    await expect(page.getByText('Close embrace')).toHaveCount(0);
  });

  test('signed-out visitors and members with the preference off see the general set', async ({ page }) => {
    await maturePref(page, false);
    await stub(page, 'general');
    await page.goto('/assets/public?cat=pose');
    await expect(page.locator('[data-item]')).toHaveCount(2);
    await expect(page.getByText('2 items')).toBeVisible();
    await expect(page.locator('[data-mature]')).toHaveCount(0);
  });

  test('AssetPicker Public library tab and tool presets: mature tiles carry the Mature badge for allowed viewers only', async ({ page }) => {
    await maturePref(page, true);
    await stub(page, 'mature');
    await page.goto('/create/remix');
    await page.locator('[data-preset="action"]').click();
    const d = picker(page, 'Action');
    await expect(d.locator('[role="option"][title="Close embrace"]')).toContainText('Mature');
    await expect(d.locator('[role="option"][title="Standing tall"]')).not.toContainText('Mature');
    await d.locator('[role="option"][title="Close embrace"]').click();
    await use(d);
    await expect(page.locator('[data-preset="action"]')).toContainText('Close embrace');
  });

  test('AssetPicker for viewers without mature access: no mature tiles, even if the response had some', async ({ page }) => {
    await maturePref(page, false);
    await stub(page, 'mature');
    await page.goto('/create/remix');
    await page.locator('[data-preset="action"]').click();
    const d = picker(page, 'Action');
    await expect(d.locator('[role="option"][title="Standing tall"]')).toBeVisible();
    await expect(d.locator('[role="option"][title="Close embrace"]')).toHaveCount(0);
    await expect(d.getByText('Mature', { exact: true })).toHaveCount(0);
  });
});
