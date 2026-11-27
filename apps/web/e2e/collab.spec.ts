import { expect, test, type Page } from '@playwright/test';

/**
 * Collaboration on the mock canvas (D-031): other people's presence (cursor,
 * selection, avatars) through the `window.__collabPresence` seam, reduced
 * motion for cursors, and the comment panel (new thread on a canvas point,
 * filters, resolve, reply). Two real browsers against a real backend:
 * e2e/real/collab.spec.ts.
 */

const maya = (cursor: { x: number; y: number } | null, selection: string[] = []) => ({
  id: 'conn1:t1',
  userId: 'usr_mock_maya',
  name: 'Maya Chen',
  image: null,
  canEdit: true,
  cursor,
  selection,
  at: Date.now(),
});

async function open(page: Page) {
  await page.goto('/p/prj_demo?mock=frozen');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__collabPresence)).toBe(true);
}

test('shows another person: avatar, named cursor and their selection', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('presence-avatars')).toHaveCount(0);
  const nodeId = await page.locator('[data-testid^="node-"]').first().getAttribute('data-testid').then((t) => t!.replace(/^node-/, ''));
  await page.evaluate((e) => window.__collabPresence!.set(e), maya({ x: 100, y: 120 }, [nodeId]));
  await expect(page.getByTestId('presence-avatars')).toBeVisible();
  await expect(page.getByTestId('presence-avatar')).toHaveAttribute('title', 'Maya Chen is here');
  const cursor = page.getByTestId('remote-cursor');
  await expect(cursor).toContainText('Maya Chen');
  await expect(page.getByTestId('remote-selection')).toHaveAttribute('data-node', nodeId);
  await page.evaluate(() => window.__collabPresence!.remove('conn1:t1'));
  await expect(cursor).toHaveCount(0);
  await expect(page.getByTestId('presence-avatars')).toHaveCount(0);
});

test('this tab sends its cursor and selection (throttled)', async ({ page }) => {
  await open(page);
  const box = (await page.getByTestId('canvas').boundingBox())!;
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 300 + i * 5, box.y + 300);
  await page.waitForTimeout(200);
  const sent = await page.evaluate(() => window.__collabPresence!.sent as Array<{ type: string; cursor?: unknown }>);
  const cursors = sent.filter((m) => m.type === 'presence' && m.cursor);
  expect(cursors.length).toBeGreaterThan(0);
  // 20 moves in well under a second: the 50 ms throttle keeps far fewer messages.
  expect(cursors.length).toBeLessThan(20);
});

test('cursors glide, and jump under reduced motion', async ({ page }) => {
  await open(page);
  await page.evaluate((e) => window.__collabPresence!.set(e), maya({ x: 10, y: 10 }));
  const duration = () => page.getByTestId('remote-cursor').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await duration()).toBe('0.12s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await duration()).toBe('0s');
});

test('comments: pin a comment on the canvas, filter, resolve and reply', async ({ page }) => {
  await open(page);
  await page.getByTestId('comments-button').click();
  const panel = page.getByTestId('collab-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('anchor-canvas').click();
  await page.getByTestId('comment-placing').click({ position: { x: 400, y: 300 } });
  await page.getByTestId('comment-input').fill('Add a title card here');
  await page.getByTestId('comment-input-submit').click();
  await expect(panel.getByTestId('thread')).toHaveCount(1);
  await expect(page.getByTestId('comment-pin')).toHaveCount(1);
  await panel.getByTestId('reply-input').fill('On it');
  await panel.getByTestId('reply-input-submit').click();
  await expect(panel.getByTestId('comment')).toHaveCount(2);
  await panel.getByTestId('thread-resolve').click();
  // Open filter: the resolved thread leaves the list; Resolved shows it.
  await expect(panel.getByTestId('thread')).toHaveCount(0);
  await expect(page.getByTestId('comment-pin')).toHaveCount(0);
  await panel.getByTestId('filter-resolved').click();
  await expect(panel.getByTestId('thread')).toHaveCount(1);
  await panel.getByTestId('collab-tab-activity').click();
  await expect(panel.getByTestId('activity-row').first()).toContainText('resolved a comment');
});
