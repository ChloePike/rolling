import { expect, test, type Page } from '@playwright/test';
import { dragWire, env, nodesByKind, portCenter, signIn } from './support';

/**
 * Canvas basics on the real backend without the agent or a gateway (works on
 * `wrangler dev` with the test inbox): a project seeded through REST opens
 * from the snapshot, edits sync to a second tab and survive a reload, an
 * invalid connection is refused with the room's reason, Run all quotes.
 *   PW_BASE_URL=http://localhost:<port> TEST_INBOX_TOKEN=… pnpm exec playwright test --project=real canvas-basics
 */

test.skip(!env.inboxToken, 'Set TEST_INBOX_TOKEN (EMAIL_PROVIDER=test-inbox on the Worker)');

const email = process.env.PW_BASICS_EMAIL ?? `e2e+basics-${Date.now().toString(36)}@rolling.test`;

async function seed(page: Page, baseURL: string): Promise<string> {
  const origin = new URL(baseURL).origin;
  const created = await page.request.post('/api/projects', { data: { title: 'E2E canvas basics' }, headers: { origin } });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = (await created.json()) as { project: { id: string } };
  const ops = [
    { op: 'addNode', tempId: 's', kind: 'script', title: 'Script', params: { rows: [{ n: 1, title: 'Bottle', visual: 'Bottle on a rock at dawn', seconds: 5 }] } },
    { op: 'addNode', tempId: 'k', kind: 'image', title: 'Keyframe', params: { prompt: 'Bottle on a rock at dawn', ratio: '9:16', resolution: '1K' } },
    { op: 'addNode', tempId: 'v', kind: 'video', title: 'Shot A', params: { prompt: 'Slow push-in', ratio: '9:16', resolution: '480p', length: 5 } },
    { op: 'connect', from: { node: 's', port: 'out' }, to: { node: 'k', port: 'prompt' } },
    { op: 'connect', from: { node: 'k', port: 'out' }, to: { node: 'v', port: 'frame' } },
  ];
  const patched = await page.request.post(`/api/projects/${project.id}/patch`, { data: { baseRevision: 1, ops }, headers: { origin } });
  if (patched.status() === 409) {
    const snap = ((await patched.json()) as { error: { data: { snapshot: { revision: number } } } }).error.data.snapshot;
    const again = await page.request.post(`/api/projects/${project.id}/patch`, { data: { baseRevision: snap.revision, ops }, headers: { origin } });
    expect(again.status(), await again.text()).toBe(200);
  } else expect(patched.status(), await patched.text()).toBe(200);
  return project.id;
}

async function openCanvas(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
}

test('a REST-seeded project opens from the snapshot, syncs edits to a second tab, refuses an invalid wire and quotes Run all', async ({ page, context, baseURL }) => {
  await signIn(page, email, baseURL!);
  const id = await seed(page, baseURL!);
  await openCanvas(page, id);
  const [script] = await nodesByKind(page, 'script');
  const [image] = await nodesByKind(page, 'image');
  const [video] = await nodesByKind(page, 'video');
  expect(script && image && video).toBeTruthy();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  // Title from the project.
  await expect(page.getByRole('button', { name: /E2E canvas basics/ }).first()).toBeVisible();

  const other = await context.newPage();
  await openCanvas(other, id);

  // Edit the video prompt: ack here, graph.patched there.
  await page.getByTestId(`node-${video!.id}`).click();
  const panel = page.getByTestId('prompt-panel');
  await panel.getByTestId('prompt-text').click();
  const text = `Warmer push-in ${Date.now().toString(36)}`;
  await panel.getByRole('textbox', { name: 'Prompt' }).fill(text);
  await panel.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  await other.getByTestId(`node-${video!.id}`).click();
  await expect(other.getByTestId('prompt-panel').getByTestId('prompt-text')).toHaveText(text, { timeout: 15_000 });

  // Invalid: video output into the image's input → refused, nothing changes.
  await dragWire(page, await portCenter(page, video!.id, 'out'), await portCenter(page, image!.id, 'in'));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);

  // Survives a reload.
  await page.reload();
  await page.getByTestId(`node-${video!.id}`).click();
  await expect(page.getByTestId('prompt-panel').getByTestId('prompt-text')).toHaveText(text);

  // Run all: the quote comes from POST /api/runs/quote (open to non-members, D-007).
  await page.getByRole('button', { name: /^Run all/ }).click();
  const dialog = page.getByTestId('plan-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Keyframe', { timeout: 30_000 });
  await expect(dialog).toContainText('Shot A');
  await other.close();
});

test('a missing project shows the not-found state', async ({ page, baseURL }) => {
  await signIn(page, email, baseURL!);
  await page.goto('/p/prj_01JDNOTAREALPROJECT0000000');
  await expect(page.getByTestId('canvas-error')).toHaveAttribute('data-reason', 'NOT_FOUND', { timeout: 30_000 });
});
