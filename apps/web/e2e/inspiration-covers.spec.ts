import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Home Inspiration with the real API client and every `/api` call stubbed: template
 * cards show their poster at once (no empty tone tiles), sized from the stored poster
 * dimensions, with the real duration badge (none for image-only templates), and the
 * preview clip loads nothing until hover.
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
  const cards = section.getByRole('link');
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
  const cards = section.getByRole('link');
  await expect(section.getByTestId('template-poster')).toHaveCount(3);
  await cards.nth(0).hover();
  await cards.nth(1).focus();
  await page.waitForTimeout(500);
  await expect(cards.nth(0).getByTestId('template-preview')).toHaveAttribute('preload', 'none');
  expect(seen.some((p) => p.endsWith('.mp4'))).toBe(false);
});
