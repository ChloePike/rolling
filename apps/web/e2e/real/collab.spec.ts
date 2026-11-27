import { expect, test, type Browser, type Page } from '@playwright/test';
import { env, signIn } from './support';

/**
 * D-031 with two browsers against a real backend (`PW_REAL_LOCAL=1` or a
 * staging `PW_BASE_URL` with the test inbox): an owner on Team invites an
 * editor; both open the canvas. Each sees the other's avatar, live cursor and
 * selection over the global socket; a comment with an @mention arrives live
 * in the other browser (unread badge), and a reply comes back.
 *   PW_REAL_LOCAL=1 pnpm exec playwright test --project=real collab
 */

test.skip(!env.inboxToken, 'Set TEST_INBOX_TOKEN (EMAIL_PROVIDER=test-inbox on the Worker)');

const stamp = Date.now().toString(36);
const ownerEmail = `e2e+collab-owner-${stamp}@rolling.test`;
const editorEmail = `e2e+collab-editor-${stamp}@rolling.test`;

async function inboxText(page: Page, to: string, pattern: RegExp): Promise<RegExpExecArray> {
  for (let i = 0; i < 30; i++) {
    const r = await page.request.get(`/api/test/inbox?to=${encodeURIComponent(to)}&limit=10`, { headers: { authorization: `Bearer ${env.inboxToken}` } });
    const body = (await r.json()) as { messages: Array<{ text: string }> };
    for (const m of body.messages) {
      const hit = pattern.exec(m.text);
      if (hit) return hit;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`No email to ${to} matching ${pattern}`);
}

async function person(browser: Browser, email: string, baseURL: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await signIn(page, email, baseURL);
  return { context, page };
}

async function openCanvas(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
}

test('two people see each other on the canvas and talk in comments', async ({ browser, baseURL }) => {
  test.setTimeout(5 * 60_000);
  const origin = new URL(baseURL!).origin;
  const owner = await person(browser, ownerEmail, baseURL!);
  const editor = await person(browser, editorEmail, baseURL!);

  // Owner: Team with a free seat, a project with one node, an invite.
  const plan = await owner.page.request.post('/api/test/plan', { data: { planId: 'team', seats: 3 }, headers: { authorization: `Bearer ${env.inboxToken}` } });
  expect(plan.status(), await plan.text()).toBe(200);
  const created = await owner.page.request.post('/api/projects', { data: { title: 'E2E collaboration' }, headers: { origin } });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = (await created.json()) as { project: { id: string } };
  const patched = await owner.page.request.post(`/api/projects/${project.id}/patch`, {
    data: { baseRevision: 0, ops: [{ op: 'addNode', tempId: 'k', kind: 'image', title: 'Keyframe', params: { prompt: 'A bottle at dawn', ratio: '9:16' } }] },
    headers: { origin },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const nodeId = ((await patched.json()) as { idMap: Record<string, string> }).idMap.k!;
  const invite = await owner.page.request.post('/api/workspace/invites', { data: { email: editorEmail, role: 'editor' }, headers: { origin } });
  expect(invite.status(), await invite.text()).toBe(201);
  const token = (await inboxText(owner.page, editorEmail, /\/invite\/([A-Za-z0-9_%-]+)/))[1]!;
  const accepted = await editor.page.request.post('/api/workspace/invites/accept', { data: { token: decodeURIComponent(token) }, headers: { origin } });
  expect(accepted.status(), await accepted.text()).toBe(200);

  await openCanvas(owner.page, project.id);
  await openCanvas(editor.page, project.id);

  // Presence: avatars on both sides.
  await expect(owner.page.getByTestId('presence-avatar')).toHaveCount(1, { timeout: 20_000 });
  await expect(editor.page.getByTestId('presence-avatar')).toHaveCount(1, { timeout: 20_000 });

  // The owner's cursor shows in the editor's browser and follows it.
  const box = (await owner.page.getByTestId('canvas').boundingBox())!;
  await owner.page.mouse.move(box.x + 500, box.y + 400);
  await owner.page.mouse.move(box.x + 520, box.y + 420, { steps: 4 });
  const cursor = editor.page.getByTestId('remote-cursor');
  await expect(cursor).toHaveCount(1, { timeout: 15_000 });
  // The editor's selection outlines the node in the owner's browser.
  await editor.page.getByTestId(`node-${nodeId}`).click();
  await expect(owner.page.locator(`[data-testid="remote-selection"][data-node="${nodeId}"]`)).toBeVisible({ timeout: 15_000 });

  // Comments: the owner comments on the node and mentions the editor.
  await owner.page.getByTestId(`node-${nodeId}`).click();
  await owner.page.getByTestId('comments-button').click();
  await owner.page.getByTestId('anchor-node').click();
  const input = owner.page.getByTestId('comment-input');
  await input.fill('Warmer light please @');
  const option = owner.page.getByRole('option').first();
  await expect(option).toBeVisible();
  await option.click();
  await owner.page.getByTestId('comment-input-submit').click();
  await expect(owner.page.getByTestId('thread')).toHaveCount(1);

  // It arrives live in the editor's browser as unread, with the node badge.
  await expect(editor.page.getByTestId('comments-unread')).toHaveText('1', { timeout: 15_000 });
  await expect(editor.page.getByTestId(`comment-badge-${nodeId}`)).toBeVisible();
  await editor.page.getByTestId(`comment-badge-${nodeId}`).click();
  const thread = editor.page.getByTestId('thread');
  await expect(thread).toContainText('Warmer light please');
  await editor.page.getByTestId('reply-input').fill('Done in the next take');
  await editor.page.getByTestId('reply-input-submit').click();

  // The reply reaches the owner; the editor may resolve.
  await expect(owner.page.getByTestId('comment')).toHaveCount(2, { timeout: 15_000 });
  await editor.page.getByTestId('thread-resolve').click();
  await expect(owner.page.getByTestId('thread')).toHaveCount(0, { timeout: 15_000 });

  // Closing the editor's tab removes their cursor and avatar for the owner.
  await editor.context.close();
  await expect(owner.page.getByTestId('presence-avatar')).toHaveCount(0, { timeout: 20_000 });
  await owner.context.close();
});
