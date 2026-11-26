import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Home Inspiration with the real API client and every `/api` call stubbed: template
 * cards show their poster at once (no empty tone tiles), sized from the stored poster
 * dimensions, with the real duration badge (none for image-only templates), and the
 * preview clip loads nothing until hover. At rest a card is the poster and the duration;
 * hover or focus brings up a solid bar with the name and Use template; touch devices show
 * the name below. Clicking a card opens the preview modal.
 */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==', 'base64');

function template(id: string, name: string, category: string, durationSec: number, w: number, h: number, video: boolean) {
  const base = `/api/media/public/templates/${id}`;
  return {
    id, name, description: null, category, source: 'builtin', durationSec, ratio: '9:16', coverAspect: `${w}/${h}`, roles: 1, hasLines: false,
    tags: [], featured: false, uses: 0, nodeCount: 3, skill: null, coverUrl: `${base}/poster-a.webp`,
    cover: { jpg: `${base}/poster-a.jpg`, webp: `${base}/poster-a.webp`, avif: `${base}/poster-a.avif`, width: w, height: h, color: '#334455' },
    previewUrl: video ? `${base}/preview-a.mp4` : null, slots: [], createdAt: 0,
  };
}

const ME = {
  user: { id: 'usr_e2e', email: 'e2e@rolling.test', name: 'E2E', image: null, emailVerified: true, handle: null, bio: null },
  workspace: { id: 'ws_e2e', name: 'Personal', kind: 'personal', matureAllowed: false },
  role: 'owner',
  monthlyCreditLimit: null,
  workspaces: [{ id: 'ws_e2e', name: 'Personal', kind: 'personal', role: 'owner', plan: 'pro' }],
  prefs: { language: 'en', currency: 'USD', creationMode: 'simple', defaultRatio: '9:16', defaultModel: 'auto', confirmThreshold: 300, notifications: { done: true, low: true, renewal: true, product: false }, theme: 'system', matureContent: false },
  plan: { id: 'pro', label: 'Pro', interval: 'month', status: 'active', currentPeriodEnd: 4102444800000, cancelAtPeriodEnd: false, perks: { monthlyCredits: 2500, topUpBonus: 0.1, concurrentJobs: 10, maxVideoResolution: '4K', maxImageResolution: '4K', voiceCloning: true, seats: 1 } },
  isMember: true,
  matureAllowed: false,
  balance: { plan: 2500, purchased: 0, held: 0, planExpiresAt: 4102444800000 },
};

const TEMPLATES = [
  template('tpl_holiday_greeting', 'Holiday greeting', 'holiday', 5, 720, 1280, true),
  template('tpl_tv_ad_15s', 'TV ad, 15 seconds', 'product', 15, 720, 404, true),
  template('tpl_character_sheet', 'Character sheet', 'comic', 0, 720, 476, false),
];

const GRAPH = {
  nodes: [
    { id: 'k1', kind: 'image', title: 'Keyframe 1', params: { model: 'bytedance/seedream-5.5' }, position: { x: 0, y: 0 }, groupId: null },
    { id: 'v1', kind: 'video', title: 'Shot 1', params: { model: 'lumina/berry-1.0' }, position: { x: 0, y: 0 }, groupId: null },
    { id: 'v2', kind: 'video', title: 'Shot 2', params: { model: 'lumina/berry-1.0' }, position: { x: 0, y: 0 }, groupId: null },
  ],
  edges: [],
  groups: [],
};
const model = (id: string, kind: 'image' | 'video', name: string) => ({
  id, kind, name, tags: [], default: false, placement: 'featured', auto: true, mature: false, matureOnly: false, requiresIdentitySafety: false,
  operations: kind === 'image' ? ['t2i', 'edit'] : ['t2v', 'i2v'], seconds: kind === 'image' ? null : { min: 2, max: 15 }, defaultSeconds: kind === 'image' ? null : 5,
  resolutions: kind === 'image' ? [] : ['720p'], defaultResolution: kind === 'image' ? null : '720p', ratios: ['9:16', '16:9', '1:1'], audio: false, lipSync: false,
  credits: [{ resolution: kind === 'image' ? null : '720p', seconds: kind === 'image' ? null : 5, credits: kind === 'image' ? 11 : 150 }],
});
const MODELS = [model('bytedance/seedream-5.5', 'image', 'Seedream 5.5'), model('lumina/berry-1.0', 'video', 'Wan 3.0')];

async function stubApi(page: Page, seen: string[]) {
  await page.addInitScript(() => {
    (globalThis as { __rollingApiMode?: string }).__rollingApiMode = 'real';
  });
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/media/')) {
      if (url.pathname.endsWith('.mp4')) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'image/png', body: PNG_1X1 });
    }
    if (url.pathname === '/api/me') return json(ME);
    if (url.pathname === '/api/projects') return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/templates') return json({ items: TEMPLATES, featured: [], total: TEMPLATES.length });
    if (url.pathname.startsWith('/api/templates/')) {
      const t = TEMPLATES.find((x) => url.pathname.endsWith(`/${x.id}`));
      return t ? json({ template: { ...t, graph: GRAPH } }) : json({ error: { code: 'NOT_FOUND', message: 'stub' } }, 404);
    }
    if (url.pathname === '/api/models') return json({ models: MODELS });
    return json({ error: { code: 'NOT_FOUND', message: 'stub' } }, 404);
  });
}

async function openInspiration(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const section = page.locator('section[aria-labelledby="h-insp"]');
  await section.scrollIntoViewIfNeeded();
  return section;
}

test('Home inspiration cards render template posters sized from the stored dimensions, real durations and lazy previews', async ({ page }) => {
  const seen: string[] = [];
  await stubApi(page, seen);
  const section = await openInspiration(page);
  const cards = section.locator('[data-template-card]');
  await expect(cards).toHaveCount(3);
  // Every card shows a loaded poster, not an empty tone tile.
  const posters = section.getByTestId('template-poster');
  await expect(posters).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect.poll(() => posters.nth(i).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
  // Aspect from the stored poster size (no layout shift when it loads).
  const box = (await cards.nth(0).boundingBox())!;
  expect(box.height / box.width).toBeCloseTo(1280 / 720, 1);
  // Real durations; the image-only template has no badge.
  await expect(cards.nth(0)).toContainText('5s');
  await expect(cards.nth(1)).toContainText('15s');
  await expect(cards.nth(2)).not.toContainText(/\d+s/);
  // Previews load nothing until hover, then play muted.
  const video = cards.nth(0).getByTestId('template-preview');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(cards.nth(2).getByTestId('template-preview')).toHaveCount(0);
  expect(seen.some((p) => p.endsWith('.mp4'))).toBe(false);
  await cards.nth(0).hover();
  await expect(video).toHaveAttribute('preload', 'auto');
  await expect.poll(() => seen.some((p) => p.endsWith('/tpl_holiday_greeting/preview-a.mp4'))).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted && v.loop)).toBe(true);
});

test('Reduced motion keeps the poster only', async ({ page }) => {
  const seen: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stubApi(page, seen);
  const section = await openInspiration(page);
  const cards = section.locator('[data-template-card]');
  await expect(section.getByTestId('template-poster')).toHaveCount(3);
  await cards.nth(0).hover();
  await cards.nth(1).getByRole('button').focus();
  await page.waitForTimeout(500);
  await expect(cards.nth(0).getByTestId('template-preview')).toHaveAttribute('preload', 'none');
  expect(seen.some((p) => p.endsWith('.mp4'))).toBe(false);
});

test('At rest a card shows only the poster and the duration; hover or focus brings up the name and Use template on a solid bar', async ({ page }) => {
  await stubApi(page, []);
  const section = await openInspiration(page);
  const card = section.locator('[data-template-card]').nth(1);
  const bar = card.getByTestId('template-bar');
  await expect(card.getByTestId('template-poster')).toBeVisible();
  await expect(bar).toBeHidden();
  await expect(card.getByTestId('template-caption')).toBeHidden();
  await card.hover();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('TV ad, 15 seconds');
  await expect(bar.getByRole('link', { name: 'Use template: TV ad, 15 seconds' })).toBeVisible();
  // Solid, no gradient and no translucency.
  const bg = await bar.evaluate((el) => getComputedStyle(el));
  expect(bg.backgroundImage).toBe('none');
  expect(bg.backgroundColor).toMatch(/^rgb\(/);
  await page.mouse.move(2, 2);
  await expect(bar).toBeHidden();
  await card.getByRole('button', { name: 'Preview TV ad, 15 seconds' }).focus();
  await expect(bar).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/create\/quick\?template=tpl_tv_ad_15s$/);
});

test('Clicking a card opens the preview: clip, facts, models; arrows move through the tab; Esc and the backdrop close; Use template opens Quick Create', async ({ page }) => {
  await stubApi(page, []);
  const section = await openInspiration(page);
  await section.locator('[data-template-card]').nth(1).getByRole('button', { name: 'Preview TV ad, 15 seconds' }).click();
  const dialog = page.getByRole('dialog', { name: 'TV ad, 15 seconds' });
  await expect(dialog).toBeVisible();
  const video = dialog.getByTestId('template-preview-video');
  await expect(video).toHaveAttribute('src', /tpl_tv_ad_15s\/preview-a\.mp4$/);
  // The silent clip plays at once with the native controls (play/pause, scrub, fullscreen).
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted && v.autoplay && v.controls)).toBe(true);
  expect(await video.getAttribute('controlslist')).not.toContain('nofullscreen');
  await expect(dialog).toContainText('15s');
  await expect(dialog).toContainText('9:16');
  await expect(dialog).toContainText('2 shots');
  await expect(dialog).toContainText('Seedream 5.5');
  await expect(dialog).toContainText('Wan 3.0');
  await page.keyboard.press('ArrowRight');
  const next = page.getByRole('dialog', { name: 'Character sheet' });
  await expect(next).toBeVisible();
  // Image templates show the cover large, no clip.
  await expect(next.getByTestId('template-preview-video')).toHaveCount(0);
  await expect(next.getByRole('button', { name: 'Next template' })).toBeDisabled();
  await next.getByRole('button', { name: 'Previous template' }).click();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: 'Holiday greeting' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await section.locator('[data-template-card]').nth(0).getByRole('button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.mouse.click(4, 450);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await section.locator('[data-template-card]').nth(0).getByRole('button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use template' }).click();
  await expect(page).toHaveURL(/\/create\/quick\?template=tpl_holiday_greeting$/);
});

test('Reduced motion: the preview does not autoplay; a play button starts it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stubApi(page, []);
  const section = await openInspiration(page);
  await section.locator('[data-template-card]').nth(0).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Holiday greeting' });
  const video = dialog.getByTestId('template-preview-video');
  expect(await video.evaluate((v: HTMLVideoElement) => v.autoplay || !v.paused)).toBe(false);
  await expect(video).toHaveAttribute('preload', 'none');
  await dialog.getByRole('button', { name: 'Play preview' }).click();
  await expect(video).toHaveAttribute('preload', 'auto');
  await expect(dialog.getByRole('button', { name: 'Play preview' })).toHaveCount(0);
});

test.describe('touch devices', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('the name sits below the card and the hover bar never shows', async ({ page }) => {
    await stubApi(page, []);
    const section = await openInspiration(page);
    const card = section.locator('[data-template-card]').nth(0);
    await expect(card.getByTestId('template-caption')).toBeVisible();
    await expect(card.getByTestId('template-caption')).toHaveText('Holiday greeting');
    const media = await card.locator('[data-testid="template-poster"]').boundingBox();
    const caption = await card.getByTestId('template-caption').boundingBox();
    expect(caption!.y).toBeGreaterThanOrEqual(media!.y + media!.height - 1);
    await card.getByRole('button').tap();
    await expect(page.getByRole('dialog', { name: 'Holiday greeting' })).toBeVisible();
    await expect(card.getByTestId('template-bar')).toBeHidden();
  });
});

