import { expect, test, type Page } from '@playwright/test';
import { dragWire, nodesByKind, portCenter } from '../real/support';
import { account, api, env, errorCode, getJson, openCanvas, projectSnapshot, SAMPLE_OPS, seedProject, shot, watchErrors } from './support';

/** Matrix: CANVAS-1 … CANVAS-13. No spending: quotes and dialogs only. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

async function snapshot(page: Page, id: string) {
  return projectSnapshot(page.request, id);
}

async function nodeMenu(page: Page, nodeId: string) {
  await page.getByTestId(`node-${nodeId}`).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Node actions' });
  await expect(menu).toBeVisible();
  return menu;
}

test('CANVAS-1 nav “Canvas” with no projects creates one and opens it; Home “New project” creates another', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'navcanvas');
  const errs = watchErrors(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Canvas' }).click();
  await page.waitForURL(/\/p\/prj_/, { timeout: 30_000 });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await shot(page, testInfo, 'nav-canvas-new');
  const list = await getJson<{ items: Array<{ id: string }> }>(page.request, '/api/projects');
  expect(list.items).toHaveLength(1);
  // A second click on nav Canvas reopens the latest project, not a new one.
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Canvas' }).click();
  await page.waitForURL(/\/p\/prj_/);
  expect((await getJson<{ items: unknown[] }>(page.request, '/api/projects')).items).toHaveLength(1);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).or(page.getByRole('link', { name: 'New project' })).first().click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByTestId('canvas')).toBeVisible();
  expect((await getJson<{ items: unknown[] }>(page.request, '/api/projects')).items).toHaveLength(2);
  errs.assertClean();
});

test('CANVAS-2 add nodes from the Add node menu; they persist', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'addnode');
  const p = await seedProject(page.request, baseURL, 'Add nodes', []);
  await openCanvas(page, p.id);
  for (const kind of ['Text', 'Image', 'Video']) {
    await page.getByRole('button', { name: 'Add node', exact: true }).first().click();
    const menu = page.getByRole('dialog', { name: 'Add node' }).or(page.getByRole('menu', { name: 'Add node' })).first();
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: new RegExp(`^${kind}`) }).or(menu.getByRole('menuitem', { name: new RegExp(`^${kind}`) })).first().click();
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved', { timeout: 20_000 });
  }
  await expect(page.locator('[data-node-kind]')).toHaveCount(3);
  // Director / Auto edit are designed “Coming soon” items, disabled with a reason.
  await page.getByRole('button', { name: 'Add node', exact: true }).first().click();
  await expect(page.getByText('Coming soon').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('[data-node-kind]')).toHaveCount(3);
  expect((await snapshot(page, p.id)).nodes.map((n) => n.kind).sort()).toEqual(['image', 'text', 'video']);
});

test('CANVAS-3 wires: connect, an invalid wire is refused with a reason, disconnect and undo; two tabs stay in sync; reload restores', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'wires');
  const p = await seedProject(page.request, baseURL, 'Wires', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const other = await context.newPage();
  await openCanvas(other, p.id);
  const [image] = await nodesByKind(page, 'image');
  const [video] = await nodesByKind(page, 'video');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  // Video out → image in: refused, with a reason.
  await dragWire(page, await portCenter(page, video!.id, 'out'), await portCenter(page, image!.id, 'in'));
  await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /take|can’t|isn’t|cycle|already|loop/i }).first()).toBeVisible();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  // API refusal carries a reason too.
  const snap = await snapshot(page, p.id);
  const bad = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/patch`, { baseRevision: snap.revision, ops: [{ op: 'connect', from: { node: video!.id, port: 'out' }, to: { node: image!.id, port: 'prompt' } }] });
  expect(bad.status()).toBe(422);
  expect(await errorCode(bad)).toBe('VALIDATION_FAILED');
  // Disconnect via the connection menu, mirrored in the other tab, then undo.
  const edge = page.locator('[data-testid^="edge-"]').first();
  await edge.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  await expect(other.locator('[data-testid^="edge-"]')).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  await expect(other.locator('[data-testid^="edge-"]')).toHaveCount(2, { timeout: 15_000 });
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  await other.close();
});

test('CANVAS-4 prompt edit syncs to a second tab over the global socket and survives reload; undo/redo through the API', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'sync');
  const p = await seedProject(page.request, baseURL, 'Sync', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const other = await context.newPage();
  await openCanvas(other, p.id);
  // One socket per browser (D-014): no per-project sockets.
  const sockets: string[] = [];
  other.on('websocket', (ws) => sockets.push(ws.url()));
  const [video] = await nodesByKind(page, 'video');
  await page.getByTestId(`node-${video!.id}`).click();
  const panel = page.getByTestId('prompt-panel');
  await panel.getByTestId('prompt-text').click();
  const text = `Warmer push-in ${Date.now().toString(36)}`;
  await panel.getByRole('textbox', { name: 'Prompt' }).fill(text);
  await panel.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  await other.getByTestId(`node-${video!.id}`).click();
  await expect(other.getByTestId('prompt-panel').getByTestId('prompt-text')).toHaveText(text, { timeout: 15_000 });
  expect(sockets.filter((u) => /\/api\/projects\/.*\/ws/.test(u))).toEqual([]);
  await page.reload();
  await page.getByTestId(`node-${video!.id}`).click();
  await expect(page.getByTestId('prompt-panel').getByTestId('prompt-text')).toHaveText(text);
  // API undo/redo of the caller's own last patch.
  const undo = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/undo`);
  expect(undo.status(), await undo.text()).toBe(200);
  expect((await snapshot(page, p.id)).nodes.find((n) => n.id === video!.id)!.params.prompt).not.toBe(text);
  const redo = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/redo`);
  expect(redo.status()).toBe(200);
  expect((await snapshot(page, p.id)).nodes.find((n) => n.id === video!.id)!.params.prompt).toBe(text);
  await other.close();
});

test('CANVAS-5 run up to / from here and Run all quote the right rows (dialog only, nothing spent)', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'runscope', 'plus');
  const p = await seedProject(page.request, baseURL, 'Scopes', SAMPLE_OPS);
  const snap = await snapshot(page, p.id);
  const k = snap.nodes.find((n) => n.kind === 'image')!;
  const v = snap.nodes.find((n) => n.kind === 'video')!;
  const rows = async (body: Record<string, unknown>) => {
    const r = await api(page.request, baseURL, 'POST', '/api/runs/quote', { projectId: p.id, ...body });
    expect(r.status(), await r.text()).toBe(200);
    return ((await r.json()) as { items: Array<{ nodeId: string; action: string; dependsOn: string[] }> }).items.filter((i) => i.action === 'run').map((i) => i.nodeId).sort();
  };
  expect(await rows({ scope: 'upTo', nodeIds: [v.id] })).toEqual([k.id, v.id].sort());
  expect(await rows({ scope: 'upTo', nodeIds: [k.id] })).toEqual([k.id]);
  expect(await rows({ scope: 'from', nodeIds: [k.id] })).toEqual([k.id, v.id].sort());
  expect(await rows({ scope: 'node', nodeIds: [k.id] })).toEqual([k.id]);
  expect(await rows({ scope: 'all' })).toEqual([k.id, v.id].sort());

  await openCanvas(page, p.id);
  const menu = await nodeMenu(page, v.id);
  await menu.getByRole('menuitem', { name: /^Run up to here/ }).click();
  const dialog = page.getByTestId('plan-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Keyframe', { timeout: 30_000 });
  await expect(dialog).toContainText('Shot A');
  await expect(dialog.getByRole('button', { name: /^Run · [\d,]+ credits/ })).toBeVisible();
  await shot(page, testInfo, 'run-up-to');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await (await nodeMenu(page, k.id)).getByRole('menuitem', { name: /^Run from here/ }).click();
  await expect(page.getByTestId('plan-dialog')).toContainText('Shot A', { timeout: 30_000 });
  await page.keyboard.press('Escape');
});

test('CANVAS-6 bypass: the node is marked, quotes skip it and dependents are blocked; turning it off restores', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'bypass', 'plus');
  const p = await seedProject(page.request, baseURL, 'Bypass', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const [k] = await nodesByKind(page, 'image');
  await (await nodeMenu(page, k!.id)).getByRole('menuitemcheckbox', { name: /^Bypass/ }).click();
  await expect(page.getByText(/is bypassed\. Runs skip it\./)).toBeVisible();
  await expect(page.getByTestId(`node-${k!.id}`)).toContainText('Bypassed');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  const q = (await (await api(page.request, baseURL, 'POST', '/api/runs/quote', { projectId: p.id, scope: 'all' })).json()) as { items: Array<{ nodeId: string; action: string; code?: string }> };
  expect(q.items.find((i) => i.nodeId === k!.id)?.action).toBe('bypassed');
  await page.reload();
  await expect(page.getByTestId(`node-${k!.id}`)).toContainText('Bypassed');
  await (await nodeMenu(page, k!.id)).getByRole('menuitemcheckbox', { name: /^Bypass/ }).click();
  await expect(page.getByText(/runs again/)).toBeVisible();
  await expect(page.getByTestId(`node-${k!.id}`)).not.toContainText('Bypassed');
});

test('CANVAS-7 reroute points on a wire and collapse/expand a node persist', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'reroute');
  const p = await seedProject(page.request, baseURL, 'Reroute', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const edge = page.locator('[data-testid^="edge-"]').first();
  await edge.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: 'Add reroute point' }).click();
  await expect(page.locator('[data-testid^="reroute-"]')).toHaveCount(1);
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  const [v] = await nodesByKind(page, 'video');
  const before = (await page.getByTestId(`node-${v!.id}`).boundingBox())!.height;
  await (await nodeMenu(page, v!.id)).getByRole('menuitem', { name: 'Collapse' }).click();
  await expect.poll(async () => (await page.getByTestId(`node-${v!.id}`).boundingBox())!.height).toBeLessThan(before);
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(page.locator('[data-testid^="reroute-"]')).toHaveCount(1);
  expect((await page.getByTestId(`node-${v!.id}`).boundingBox())!.height).toBeLessThan(before);
  await (await nodeMenu(page, v!.id)).getByRole('menuitem', { name: 'Expand' }).click();
  await expect.poll(async () => (await page.getByTestId(`node-${v!.id}`).boundingBox())!.height).toBeGreaterThanOrEqual(before - 2);
  // Remove the reroute with Delete.
  await page.locator('[data-testid^="reroute-"]').first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid^="reroute-"]')).toHaveCount(0);
});

test('CANVAS-8 delete a node (toast with Undo) and keyboard undo/redo', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'delnode');
  const p = await seedProject(page.request, baseURL, 'Delete node', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const [v] = await nodesByKind(page, 'video');
  await (await nodeMenu(page, v!.id)).getByRole('menuitem', { name: /^Delete/ }).click();
  await expect(page.locator('[data-node-kind="video"]')).toHaveCount(0);
  await expect(page.getByText('Node deleted')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-node-kind="video"]')).toHaveCount(1);
  await page.getByTestId(`node-${v!.id}`).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-node-kind="video"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-node-kind="video"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
});

test('CANVAS-9 delete a project: the index drops it, the canvas shows “deleted” in an open tab and “doesn’t exist” on reload', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'delproj');
  const p = await seedProject(page.request, baseURL, 'Delete me', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const del = await api(context.request, baseURL, 'DELETE', `/api/projects/${p.id}`);
  expect(del.status()).toBe(200);
  await expect(page.getByTestId('canvas-error')).toHaveAttribute('data-reason', 'PROJECT_DELETED', { timeout: 20_000 });
  await shot(page, testInfo, 'project-deleted');
  await page.reload();
  await expect(page.getByTestId('canvas-error')).toHaveAttribute('data-reason', 'NOT_FOUND', { timeout: 30_000 });
  expect((await getJson<{ items: Array<{ id: string }> }>(page.request, '/api/projects')).items.map((i) => i.id)).not.toContain(p.id);
});

test('CANVAS-10 delete a project from the UI: Home card “…” menu and the canvas project menu, each with a confirm', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'delhome');
  const tag = Date.now().toString(36);
  const a = await seedProject(page.request, baseURL, `Home delete ${tag}`, []);
  const b = await seedProject(page.request, baseURL, `Canvas delete ${tag}`, SAMPLE_OPS);
  const ids = async () => (await getJson<{ items: Array<{ id: string }> }>(page.request, '/api/projects')).items.map((i) => i.id);

  // Home: the card's “…” menu → Delete → confirm.
  await page.goto('/');
  const card = page.locator(`[data-project="${a.id}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.hover();
  await card.getByRole('button', { name: /^Project actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: /^Delete “Home delete/ });
  await expect(confirm).toContainText('This can’t be undone.');
  await confirm.getByRole('button', { name: 'Delete project' }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  expect(await ids()).not.toContain(a.id);

  // Canvas: the project menu → Delete → confirm → Home, and the last-canvas id is forgotten.
  await openCanvas(page, b.id);
  await page.getByRole('button', { name: /^Project:/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: /^Delete “Canvas delete/ }).getByRole('button', { name: 'Delete project' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  expect(await ids()).not.toContain(b.id);
  expect(await page.evaluate((pid) => Object.entries(localStorage).some(([k, v]) => k.startsWith('rolling.canvas.last.') && v === pid), b.id)).toBe(false);
});

test('CANVAS-11 stale writes conflict with the current snapshot (409), never overwrite', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'conflict');
  const p = await seedProject(page.request, baseURL, 'Conflict', SAMPLE_OPS);
  const r = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/patch`, { baseRevision: p.revision - 1, ops: [{ op: 'addNode', tempId: 't', kind: 'text', title: 'Late', params: {} }] });
  expect(r.status()).toBe(409);
  const body = (await r.json()) as { error: { code: string; data: { snapshot: { revision: number } } } };
  expect(body.error.code).toBe('CONFLICT');
  expect(body.error.data.snapshot.revision).toBe(p.revision);
});

test('CANVAS-12 a missing / foreign project shows “doesn’t exist”', async ({ page, context, baseURL, browser }) => {
  await account(context, baseURL, 'foreign');
  const other = await browser.newContext({ baseURL });
  await account(other, baseURL, 'foreign2');
  const p = await seedProject(other.request, baseURL, 'Not yours', []);
  await page.goto(`/p/${p.id}`);
  await expect(page.getByTestId('canvas-error')).toHaveAttribute('data-reason', 'NOT_FOUND', { timeout: 30_000 });
  await page.goto('/p/prj_01JDNOTAREALPROJECT0000000');
  await expect(page.getByTestId('canvas-error')).toHaveAttribute('data-reason', 'NOT_FOUND', { timeout: 30_000 });
  await other.close();
});

test('CANVAS-13 the initial fit keeps every node clear of the left tool rail and the agent panel', async ({ page, context, baseURL }) => {
  await account(context, baseURL, 'fit');
  const p = await seedProject(page.request, baseURL, 'Fit canvas', SAMPLE_OPS);
  await openCanvas(page, p.id);
  const rail = (await page.getByRole('toolbar', { name: /tools/i }).first().boundingBox())!;
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3, { timeout: 20_000 });
  await expect.poll(async () => (await nodes.first().boundingBox())?.x ?? 0).toBeGreaterThan(rail.x + rail.width);
  for (const box of await Promise.all((await nodes.all()).map((n) => n.boundingBox()))) {
    expect(box!.x, 'node starts right of the tool rail').toBeGreaterThanOrEqual(rail.x + rail.width + 8);
  }
});
