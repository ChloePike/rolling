import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { mockPublicLibrary, type PublicNode } from './support/publicLibrary';
import { devUploads, picker, PNG, uploadFromPicker, use } from './support/picker';

/**
 * The shared asset picker modal (features/picker): every media entry point
 * opens it, uploads from it land in the user's Assets and are selected, drops
 * on the canvas become assets, it fits small viewports, and no popover
 * pickers remain. Mock build (`VITE_API_MODE=mock`); uploads use the transfer
 * engine's dev mock (D-011).
 */
const node = (category: string, title: string, i = 0): PublicNode => ({ id: `pw_${category}_${i}_${title.replace(/\W/g, '')}`, category, sub: null, title, promptEn: title.toLowerCase(), tags: [], assetId: `ast_pub_${category}_${i}`, license: 'CC0', source: 'https://posewear.pages.dev/' });
const portraits = Array.from({ length: 200 }, (_, i) => node('portrait', `Portrait ${i + 1}`, i));
const library = (c: string | null) => (c === 'portrait' ? portraits : c === 'scene' ? [node('scene', 'Kitchen')] : c === 'pose' ? [node('pose', 'Walk and talk')] : []);

async function setSimple(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rolling.creationMode', 'simple');
    } catch {
      /* ignore */
    }
  });
}

test.beforeEach(async ({ page, context }) => {
  await devUploads(context);
  await setSimple(page);
  await mockPublicLibrary(page, library);
});

test.describe('asset picker: every entry point opens the modal', () => {
  const cases: Array<{ name: string; path: string; open: (page: Page) => Promise<void>; title: string | RegExp }> = [
    { name: 'Quick Create slot', path: '/create/quick', open: (p) => p.getByRole('button', { name: 'Upload a photo for @Partner' }).click(), title: '@Partner' },
    { name: 'tool composer +', path: '/create/quick', open: (p) => p.getByTestId('tool-composer').getByRole('button', { name: 'Add assets or skills' }).click(), title: 'Add assets or skills' },
    { name: 'Remix preset', path: '/create/remix', open: (p) => p.locator('[data-preset="action"]').click(), title: 'Action' },
    { name: 'Remix character slot', path: '/create/remix', open: (p) => p.locator('[data-slot="0"]').click(), title: 'Character 1' },
    { name: 'Avatar character', path: '/create/avatar', open: (p) => p.locator('[data-look="character"]').click(), title: 'Character' },
    { name: 'Avatar scene', path: '/create/avatar', open: (p) => p.locator('[data-look="scene"]').click(), title: 'Scenes' },
    { name: 'Character photo', path: '/create/character', open: (p) => p.locator('[data-ref-slot="face"]').click(), title: 'Face reference' },
    { name: 'Character hair', path: '/create/character', open: (p) => p.locator('[data-look-library="hair"]').click(), title: 'Hair' },
    { name: 'Character outfit', path: '/create/character', open: (p) => p.locator('[data-look-library="wear"]').click(), title: 'Outfits' },
    { name: 'canvas tool rail Assets', path: '/p/prj_demo?mock=frozen', open: (p) => p.getByRole('button', { name: 'Assets', exact: true }).click(), title: 'Add assets to the canvas' },
    { name: 'canvas prompt Add reference', path: '/p/prj_demo?mock=frozen', open: (p) => p.getByTestId('prompt-panel').getByRole('button', { name: 'Add reference' }).click(), title: 'Add references' },
    { name: 'canvas asset node Replace', path: '/p/prj_demo?mock=frozen', open: async (p) => {
      await p.locator('[data-node-kind="asset"]').first().hover();
      await p.getByRole('button', { name: /^Replace the asset in/ }).first().click();
    }, title: /^Replace / },
    { name: 'canvas agent reference', path: '/p/prj_demo?mock=frozen', open: async (p) => {
      await p.getByRole('complementary', { name: 'Agent' }).getByRole('button', { name: /Add/ }).first().click();
      await p.getByRole('menuitem', { name: /Add a reference/ }).click();
    }, title: 'Add a reference' },
    { name: 'editor bin Import', path: '/dev/editor', open: (p) => p.getByRole('button', { name: 'Import' }).click(), title: 'Import to the timeline' },
    { name: 'prompt box + Choose from Assets', path: '/', open: async (p) => {
      await p.getByRole('button', { name: 'Add assets or skills' }).first().click();
      await p.getByRole('menuitem', { name: 'Choose from Assets' }).click();
    }, title: 'Choose from Assets' },
  ];
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      await page.goto(c.path);
      await c.open(page);
      const d = picker(page, c.title);
      await expect(d).toBeVisible();
      await expect(d).toHaveAttribute('aria-modal', 'true');
      await expect(d.getByRole('button', { name: 'Upload' })).toBeVisible();
      await expect(d.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(d).toHaveCount(0);
    });
  }
});

test('My assets: pick an asset on the canvas tool rail; it becomes an asset node with that name', async ({ page }) => {
  await page.goto('/p/prj_demo?mock=frozen');
  await expect(page.locator('[data-node-kind="asset"]').first()).toBeVisible();
  const before = await page.locator('.react-flow__node').count();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  const d = picker(page, 'Add assets to the canvas');
  const first = d.getByRole('option').first();
  const name = (await first.getAttribute('title'))!;
  const already = await page.locator('.react-flow__node').filter({ hasText: name }).count();
  expect(await first.getAttribute('data-asset')).toMatch(/^ast_/);
  await first.click();
  await expect(d.getByText('1 selected')).toBeVisible();
  await d.getByRole('button', { name: 'Add to canvas' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  await expect(page.locator('.react-flow__node').filter({ hasText: name })).toHaveCount(already + 1);
});

test('Public library: the caller context preselects the category; the pick sets the row; Recent remembers it', async ({ page }) => {
  await page.goto('/create/avatar');
  await page.locator('[data-look="character"]').click();
  const d = picker(page, 'Character');
  await expect(d.getByRole('group', { name: 'Public library categories' }).getByRole('button', { pressed: true })).toHaveText('Portraits');
  await d.locator('[role="option"][title="Portrait 3"]').click();
  await use(d);
  await expect(page.locator('[data-look="character"]')).toContainText('Portrait 3');
  await page.locator('[data-look="character"]').click();
  await d.getByRole('tab', { name: 'Recent' }).click();
  await expect(d.locator('[role="option"][title="Portrait 3"]')).toHaveAttribute('data-asset', 'ast_pub_portrait_2');
});

test('virtualized grid: 200 public items render only the rows in view', async ({ page }) => {
  await page.goto('/create/avatar');
  await page.locator('[data-look="character"]').click();
  const d = picker(page, 'Character');
  const grid = d.getByRole('listbox');
  await d.locator('[data-picker-scroll]').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(async () => Number(await grid.getAttribute('data-count'))).toBeGreaterThan(24);
  const rendered = await d.getByRole('option').count();
  expect(rendered).toBeLessThan(Number(await grid.getAttribute('data-count')));
});

test('upload from the modal: progress tile, then the new asset is selected, used, and listed in Assets', async ({ page }) => {
  await page.goto('/create/quick');
  await page.getByTestId('tool-composer').getByRole('button', { name: 'Add assets or skills' }).click();
  const d = picker(page, 'Add assets or skills');
  const option = await uploadFromPicker(d, { ...PNG, name: 'fresh-shot.png' });
  expect(await option.getAttribute('data-asset')).toMatch(/^ast_/);
  await expect(d.getByText('1 selected')).toBeVisible();
  await use(d);
  await expect(page.getByTestId('tool-composer').locator('[data-ref="@fresh-shot"]')).toBeVisible();
  // The upload went into the user's Assets first.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page.getByText('fresh-shot.png').first()).toBeVisible();
});

test('drop on the canvas uploads into Assets and adds an asset node', async ({ page }) => {
  await page.goto('/p/prj_demo?mock=frozen');
  await expect(page.locator('[data-node-kind="asset"]').first()).toBeVisible();
  const before = await page.locator('.react-flow__node').count();
  await page.locator('.react-flow__pane').evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'dropped-photo.png', { type: 'image/png' }));
    const at = { clientX: 500, clientY: 400, bubbles: true, cancelable: true, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragover', at));
    el.dispatchEvent(new DragEvent('drop', at));
  }, [...PNG.buffer]);
  await expect(page.getByText('Uploading 1 file to your assets.')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(page.locator('.react-flow__node').filter({ hasText: 'dropped-photo' })).toHaveCount(1);
});

test('keyboard: arrows move, Enter picks and uses (single select), Tab stays in the dialog, Esc closes', async ({ page }) => {
  await page.goto('/create/remix');
  await page.locator('[data-preset="scene"]').click();
  const d = picker(page, 'Scenes');
  await expect(d.getByRole('searchbox')).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[aria-modal="true"]'))).toBe(true);
  }
  await d.getByRole('option').first().focus();
  await page.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  await expect(page.locator('[data-preset="scene"]')).toContainText('Kitchen');

  await page.locator('[data-preset="action"]').click();
  const poses = picker(page, 'Action');
  await poses.getByRole('group', { name: 'Public library categories' }).getByRole('button', { name: 'Portraits' }).click();
  await poses.getByRole('option').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(poses.locator('[role="option"][data-index="1"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const cols = await poses.locator('[role="option"]:focus').getAttribute('data-index');
  expect(Number(cols)).toBeGreaterThan(2);
  await page.keyboard.press('Space');
  await expect(poses.locator('[role="option"]:focus')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(poses).toHaveCount(0);
  await expect(page.locator('[data-preset="action"]')).not.toContainText('Portrait');
});

for (const vp of [
  { width: 1280, height: 720 },
  { width: 760, height: 640 },
  { width: 390, height: 700 },
]) {
  test(`fits the viewport at ${vp.width}×${vp.height}: no overflow, search and footer fully visible`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/create/avatar');
    await page.locator('[data-look="character"]').click();
    const d = picker(page, 'Character');
    await expect(d.getByRole('option').first()).toBeVisible();
    const box = (await d.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    if (vp.width >= 1280) expect(box.width).toBeGreaterThanOrEqual(900);
    const search = (await d.getByRole('searchbox').boundingBox())!;
    expect(search.width).toBeGreaterThan(150);
    expect(search.x + search.width).toBeLessThanOrEqual(box.x + box.width);
    for (const name of ['Upload', 'Cancel', 'Use']) {
      const b = (await d.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width);
      expect(b.y + b.height, name).toBeLessThanOrEqual(box.y + box.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

const sceneLib = Array.from({ length: 40 }, (_, i) => node(i % 3 ? 'scene' : 'lighting', `Scene ${i + 1}`, i));
for (const vp of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 760, height: 720 },
]) {
  test(`grid at ${vp.width}×${vp.height}: never scrolls sideways; every column fits inside the scroller`, async ({ page }) => {
    await mockPublicLibrary(page, (c) => (c === null ? sceneLib : sceneLib.filter((n) => n.category === c)));
    await page.setViewportSize(vp);
    await page.goto('/create/remix');
    await page.locator('[data-preset="scene"]').click();
    const d = picker(page, 'Scenes');
    await expect(d.getByRole('option').first()).toBeVisible();
    const scroll = d.locator('[data-picker-scroll]');
    const geo = await scroll.evaluate((el) => {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const right = box.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight);
      const cells = [...el.querySelectorAll<HTMLElement>('[role="option"]')].map((c) => c.getBoundingClientRect());
      const top = Math.min(...cells.map((c) => c.top));
      const row = cells.filter((c) => Math.abs(c.top - top) < 1);
      return { overflow: el.scrollWidth - el.clientWidth, overflowX: cs.overflowX, right, maxRight: Math.max(...cells.map((c) => c.right)), cols: row.length, minW: Math.min(...row.map((c) => c.width)) };
    });
    expect(geo.overflow).toBeLessThanOrEqual(0);
    expect(geo.overflowX).toBe('hidden');
    expect(geo.maxRight).toBeLessThanOrEqual(geo.right + 0.5);
    expect(geo.cols).toBeGreaterThanOrEqual(vp.width >= 1280 ? 5 : 3);
    expect(geo.minW).toBeGreaterThanOrEqual(140);
    // Every category chip is reachable without a hidden scroll: the row wraps inside the panel.
    const panel = (await d.boundingBox())!;
    for (const chip of await d.getByRole('group', { name: 'Public library categories' }).getByRole('button').all()) {
      const b = (await chip.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
  });
}

test('Public library tiles: no redundant Public badge or kind subtitle; mixed lists (All, Recent) keep what tells items apart', async ({ page }) => {
  await mockPublicLibrary(page, (c) => (c === null ? sceneLib : sceneLib.filter((n) => n.category === c)));
  await page.goto('/create/remix');
  await page.locator('[data-preset="scene"]').click();
  const d = picker(page, 'Scenes');
  const first = d.getByRole('option').first();
  await expect(first).toBeVisible();
  // Inside one category every tile is public and the category is the chip: neither is repeated.
  await expect(d.getByRole('option').filter({ hasText: /^.*Public/ })).toHaveCount(0);
  await expect(d.getByRole('option').filter({ hasText: 'Images' })).toHaveCount(0);
  await expect(first).toHaveText('Scene 2');
  // All categories: the subtitle names each tile's category.
  await d.getByRole('group', { name: 'Public library categories' }).getByRole('button', { name: 'All' }).click();
  await expect(d.locator('[role="option"][title="Scene 1"]')).toHaveText('Scene 1Lighting');
  await expect(d.locator('[role="option"][title="Scene 2"]')).toHaveText('Scene 2Scenes');
  await d.locator('[role="option"][title="Scene 2"]').click();
  await expect(d.locator('[role="option"][title="Scene 2"]')).toHaveAttribute('aria-selected', 'true');
  await use(d);
  // Recent mixes sources: the badge says where the item came from.
  await page.locator('[data-preset="scene"]').click();
  await d.getByRole('tab', { name: 'Recent' }).click();
  await expect(d.locator('[role="option"][title="Scene 2"]')).toContainText('Public');
});

test('reduced motion: the modal only fades; light and dark themes use their tokens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/create/avatar');
  await page.locator('[data-look="character"]').click();
  const d = picker(page, 'Character');
  const transform = await d.evaluate((el) => getComputedStyle(el).transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
  const dark = await d.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.locator('[data-look="character"]').click();
  const light = await picker(page, 'Character').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(light).not.toBe(dark);
});

test('no popover pickers remain: no LibraryPanel / PickPopover / bare file pickers for media in the app source', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) files.push(p);
    }
  };
  walk(src);
  const offenders = files.filter((f) => /\b(LibraryPanel|PickPopover|useFilePicker)\b/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
  // Library rows open the modal.
  const row = readFileSync(join(src, 'features/tools/shared/LibraryPicker.tsx'), 'utf8');
  expect(row).not.toMatch(/\bPopover\b/);
  expect(row).toContain('useAssetPicker');
});
