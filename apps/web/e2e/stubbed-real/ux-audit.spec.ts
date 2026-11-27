import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { stubApi } from './support';

/**
 * UX audit fixes (docs/ux-audit.md) in real mode against a stubbed API: each
 * test answers the requests its screen makes on top of the empty stub.
 */

const OUT = fileURLToPath(new URL('../__screens__/ux-audit/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7ADmUAAAAASUVORK5CYII=', 'base64');
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Answers `handler`'s paths (anything it returns undefined for falls back to the empty stub). */
async function stub(page: Page, handler: (method: string, path: string, body: string, route: Route) => unknown | Promise<unknown>) {
  await stubApi(page, { delayMs: 30 });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const out = await handler(req.method(), url.pathname, req.postData() ?? '', route);
    if (out === undefined) return route.fallback();
    if (out === 'handled') return;
    return json(route, out);
  });
}

test('Home “Blank canvas” creates one project and opens it (it used to open /p/prj_new: “This canvas doesn’t exist”)', async ({ page }) => {
  let creates = 0;
  await stub(page, (method, path) => {
    if (path === '/api/projects' && method === 'POST') {
      creates += 1;
      return { project: { id: 'prj_blank1', title: 'Untitled project' } };
    }
    return undefined;
  });
  await page.goto('/');
  const entry = page.getByRole('navigation', { name: /start/i }).getByRole('link', { name: 'Blank canvas' });
  await entry.dblclick();
  await expect(page).toHaveURL(/\/p\/prj_blank1$/);
  expect(creates).toBe(1);
});

test('Home “All projects” lists every project in place, and “Show fewer” folds it back', async ({ page }) => {
  const node = (i: number) => ({ node: { id: `prj_p${i}`, title: `Project ${i}`, kind: 'canvas', nodeCount: 3, updatedAt: Date.now() - i * 60_000, thumbUrl: null } });
  await stub(page, (method, path, body) => {
    if (path === '/api/graphql' && body.includes('projects(')) {
      const first = (JSON.parse(body) as { variables?: { first?: number } }).variables?.first ?? 4;
      return { data: { projects: { edges: Array.from({ length: Math.min(first, 9) }, (_, i) => node(i + 1)), pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return undefined;
  });
  await page.goto('/');
  const grid = page.locator('#home-projects-grid');
  await expect(grid.getByText('Project 4')).toBeVisible();
  await expect(grid.getByText('Project 5')).toHaveCount(0);
  const all = page.getByRole('button', { name: 'All projects ›' });
  await all.click();
  await expect(grid.getByText('Project 9')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Show fewer' }).click();
  await expect(grid.getByText('Project 5')).toHaveCount(0);
});

test('Activity: result thumbnails, stat notes without “down 0%” or “0 min”, a dash for a rate with no runs, and next steps when empty', async ({ page }) => {
  let runs: unknown[] = [];
  const stats = { usedThisMonth: 47, usedLastMonth: 0, running: 0, successRate: null, runsLast7Days: 0, refundedThisMonth: 0 };
  await stub(page, (method, path, _b, route) => {
    if (path === '/api/runs' && method === 'GET') return { runs, stats, nextCursor: null };
    if (path.startsWith('/api/media/private/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG }).then(() => 'handled');
    return undefined;
  });
  await page.goto('/activity');
  await expect(page.getByText('No runs yet. Images and videos you generate show up here.')).toBeVisible();
  await expect(page.getByText('credits · down')).toHaveCount(0);
  await expect(page.getByText('Nothing running')).toBeVisible();
  await expect(page.getByText('Done in about 0 min')).toHaveCount(0);
  await expect(page.getByText('–', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start creating' }).click();
  await expect(page).toHaveURL(/\/$/);

  runs = [
    {
      id: 'run_a1', ref: 'T-AAAA1', name: 'Bottle on rock', source: 'quickCreate', projectId: null, projectTitle: null, params: 'Seedream 5.0 Flash · 2K · 16:9',
      status: 'done', progress: null, credits: 6, quoted: 6, spent: 6, refunded: 0, error: null, createdAt: Date.now() - 60_000, finishedAt: Date.now(),
      items: [{ ref: 'r1', nodeId: null, title: 'Bottle on rock', kind: 'image', model: 'bytedance/seedream-5.0-flash', modelName: 'Seedream 5.0 Flash', status: 'succeeded', jobId: 'job_1', progress: 1, credits: 6, spent: 6, refunded: 0, assetId: 'ast_thumb1', error: null, errorCode: null }],
      request: null, tool: 'quick', retryOf: null, characterId: null, retryable: false,
    },
  ];
  stats.runsLast7Days = 1;
  (stats as { successRate: number | null }).successRate = 1;
  await page.goto('/activity');
  const thumb = page.locator('img[src*="/api/media/private/ast_thumb1"]');
  await expect(thumb).toBeVisible();
  expect(await thumb.getAttribute('src')).toContain('variant=poster');
  await expect(page.getByText('100%')).toBeVisible();
  await page.getByRole('tab', { name: 'Failed' }).or(page.getByRole('button', { name: 'Failed', exact: true })).first().click();
  await expect(page.getByText('No runs match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('Bottle on rock')).toBeVisible();
  await page.screenshot({ path: `${OUT}activity-real.png` });
});

test('Assets: the detail panel shows the media, the file type and the project by name (not “SHOT 1: …” and a prj_ id); an empty library offers Upload', async ({ page }) => {
  let assets: unknown[] = [];
  await stub(page, (method, path, body, route) => {
    if (path === '/api/graphql' && body.includes('assets(')) return { data: { assets: { edges: assets.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } };
    if (path === '/api/projects' && method === 'GET') return { items: [{ id: 'prj_bottle', title: 'Still morning', updatedAt: Date.now() }], projects: [], nextCursor: null };
    if (path.startsWith('/api/media/private/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG }).then(() => 'handled');
    return undefined;
  });
  await page.goto('/assets');
  await expect(page.getByText(/No assets yet/)).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-empty]').getByRole('button', { name: 'Upload' }).click();
  await chooser;

  assets = [
    {
      id: 'ast_img1', kind: 'IMAGE', source: 'generated', name: 'Shot 1: Bottle on mossy rock', status: 'ready', mature: false, rating: 'safe', size: 1000, contentType: 'image/png',
      license: null, projectId: 'prj_bottle', createdAt: Date.now(), url: null, thumbUrl: '/api/media/private/ast_img1', meta: { width: 2688, height: 1536, durationSec: null },
    },
  ];
  await page.goto('/assets');
  await page.getByText('Shot 1: Bottle on mossy rock').first().click();
  const detail = page.getByRole('complementary', { name: /details/i });
  await expect(detail.getByText('PNG', { exact: true })).toBeVisible();
  await expect(detail.getByText('SHOT 1: BOTTLE ON MOSSY ROCK', { exact: true })).toHaveCount(0);
  await expect(detail.getByRole('link', { name: 'Still morning ›' })).toBeVisible();
  await expect(detail.getByText(/prj_bottle/)).toHaveCount(0);
  await expect(detail.locator('img[src*="ast_img1"]')).toBeVisible();
});

test('Profile: an unknown profile offers a way back (it was a dead end)', async ({ page }) => {
  await stub(page, () => undefined);
  await page.goto('/u/nobody-here');
  const box = page.getByTestId('profile-unavailable');
  await expect(box).toContainText('This profile doesn’t exist or isn’t public.');
  await box.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL(/\/$/);
});
