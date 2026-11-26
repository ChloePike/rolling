import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The right panel of `/login` and `/signup` with the real API client and `/api`
 * stubbed: the three tiles show template posters, then play the preview clips;
 * one tile crossfades to the next unused clip every 6 s (fake timers), and only
 * that next clip preloads. Reduced motion shows posters only; no clips (or a
 * failed request) keeps the design's tone tiles, without a caption.
 */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==', 'base64');
const CLIP = readFileSync(new URL('./fixtures/showcase-clip.webm', import.meta.url));

const item = (n: number) => ({
  id: `tpl_show_${n}`,
  name: `Showcase clip ${n}`,
  posterUrl: `/media-stub/${n}/poster.webp`,
  poster: { avif: null, webp: `/media-stub/${n}/poster.webp`, jpg: `/media-stub/${n}/poster.jpg` },
  previewUrl: `/media-stub/${n}/preview.webm`,
  aspect: '9/16',
  width: 720,
  height: 1280,
  color: '#334455',
});
const ITEMS = [0, 1, 2, 3, 4].map(item);

async function stub(page: Page, showcase: { status: number; body: unknown }, seen: string[] = []) {
  await page.addInitScript(() => {
    (globalThis as { __rollingApiMode?: string }).__rollingApiMode = 'real';
  });
  await page.route('**/media-stub/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    seen.push(path);
    return path.endsWith('.webm') ? route.fulfill({ contentType: 'video/webm', body: CLIP }) : route.fulfill({ contentType: 'image/png', body: PNG_1X1 });
  });
  await page.route('**/api/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/showcase') return json(showcase.body, showcase.status);
    if (path === '/api/auth/providers') return json({ emailCode: true, google: false });
    if (path === '/api/me') return json({ error: { code: 'UNAUTHENTICATED', message: 'stub' } }, 401);
    return json({ error: { code: 'NOT_FOUND', message: 'stub' } }, 404);
  });
}

const tiles = (page: Page) => page.getByTestId('showcase-tile');
const caption = (page: Page) => page.getByTestId('showcase-caption');

test('login: tiles show posters first, then play the previews; only the next clip preloads', async ({ page }) => {
  const seen: string[] = [];
  await stub(page, { status: 200, body: { items: ITEMS } }, seen);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  // The form is there at once; the clips come in behind it.
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeEnabled();
  await expect(page.locator('aside [data-showcase="clips"]')).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);
  await expect(tiles(page).nth(0)).toHaveAttribute('data-item', 'tpl_show_0');
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_1');
  await expect(tiles(page).nth(2)).toHaveAttribute('data-item', 'tpl_show_2');
  // Poster first, then the clip plays (muted, looping, inline).
  const first = tiles(page).nth(1).locator('video[data-item="tpl_show_1"]');
  await expect(first).toHaveAttribute('poster', '/media-stub/1/poster.webp');
  const props = await first.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop, inline: v.playsInline }));
  expect(props).toEqual({ muted: true, loop: true, inline: true });
  await expect(tiles(page).locator('video[data-playing]')).toHaveCount(3);
  await expect(caption(page)).toHaveText('Showcase clip 1');
  // Three on screen plus the next one hidden in the middle tile; the fifth is not loaded.
  await expect(page.getByTestId('showcase-video')).toHaveCount(4);
  await expect(tiles(page).nth(1).locator('video[data-state="next"]')).toHaveAttribute('data-item', 'tpl_show_3');
  expect(seen).not.toContain('/media-stub/4/preview.webm');
  // Same boxes as the design's tone tiles: no layout shift.
  const boxes = await tiles(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(boxes).toEqual([170, 200, 170]);
});

test('login: every 6 s one tile crossfades to the next unused clip, round-robin, and the caption follows', async ({ page }) => {
  await page.clock.install();
  await stub(page, { status: 200, body: { items: ITEMS } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.clock.runFor(2000);
  await expect(page.locator('aside [data-showcase="clips"]')).toBeVisible();
  await expect(caption(page)).toHaveText('Showcase clip 1');

  await page.clock.runFor(5900);
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_1');
  await page.clock.runFor(200);
  // Fading: the incoming clip is on top and playing.
  await expect(tiles(page).nth(1).locator('video[data-state="in"]')).toHaveAttribute('data-item', 'tpl_show_3');
  await page.clock.runFor(700);
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_3');
  await expect(tiles(page).nth(1).getByTestId('showcase-video')).toHaveCount(1);
  await expect(caption(page)).toHaveText('Showcase clip 3');
  // The other tiles did not change at the same time; the right one is next.
  await expect(tiles(page).nth(0)).toHaveAttribute('data-item', 'tpl_show_0');
  await expect(tiles(page).nth(2)).toHaveAttribute('data-item', 'tpl_show_2');

  await page.clock.runFor(6700);
  await expect(tiles(page).nth(2)).toHaveAttribute('data-item', 'tpl_show_4');
  await expect(tiles(page).nth(0)).toHaveAttribute('data-item', 'tpl_show_0');
  await page.clock.runFor(6700);
  // Clip 1 left the screen and is unused again.
  await expect(tiles(page).nth(0)).toHaveAttribute('data-item', 'tpl_show_1');
  await expect(caption(page)).toHaveText('Showcase clip 3');
});

test('signup: the tab going hidden pauses the clips and the rotation', async ({ page }) => {
  await page.clock.install();
  await stub(page, { status: 200, body: { items: ITEMS } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/signup');
  await page.clock.runFor(2000);
  await expect(tiles(page).locator('video[data-playing]')).toHaveCount(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(tiles(page).locator('video[data-playing]')).toHaveCount(0);
  await page.clock.runFor(20_000);
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_1');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(tiles(page).locator('video[data-playing]')).toHaveCount(3);
  await page.clock.runFor(6700);
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_3');
});

test('reduced motion: posters only, nothing plays or rotates', async ({ page }) => {
  const seen: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await stub(page, { status: 200, body: { items: ITEMS } }, seen);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.clock.runFor(2000);
  await expect(page.locator('aside [data-showcase="posters"]')).toBeVisible();
  await expect(page.getByTestId('showcase-poster')).toHaveCount(3);
  await expect(page.getByTestId('showcase-video')).toHaveCount(0);
  await expect(caption(page)).toHaveText('Showcase clip 1');
  await page.clock.runFor(30_000);
  await expect(tiles(page).nth(1)).toHaveAttribute('data-item', 'tpl_show_1');
  expect(seen.filter((p) => p.endsWith('.webm'))).toEqual([]);
});

for (const c of [
  { name: 'an empty list', showcase: { status: 200, body: { items: [] } } },
  { name: 'a failed request', showcase: { status: 500, body: { error: { code: 'INTERNAL', message: 'stub' } } } },
]) {
  test(`login: ${c.name} keeps the tone tiles without a caption`, async ({ page }) => {
    let asked = false;
    await stub(page, c.showcase);
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/showcase') asked = true;
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await expect.poll(() => asked).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.locator('aside [data-showcase="tones"]')).toBeVisible();
    await expect(page.locator('aside [data-showcase="tones"] > div')).toHaveCount(3);
    await expect(page.locator('aside video, aside img')).toHaveCount(0);
    await expect(page.locator('aside')).not.toContainText('Morning');
    await expect(caption(page)).toHaveCount(0);
  });
}
