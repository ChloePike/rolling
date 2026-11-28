import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { ME, stubApi } from './support';

/**
 * D-021 agent modes in real mode against a stubbed API and global socket: the turn
 * carries the mode (and Auto's budget), Read answers without a proposal, Auto shows
 * "Agent changed …" with Undo (sent to the server), the spend against the budget,
 * and a run over the budget as "Run · N credits" that goes through the run flow.
 */

const PROJECT = 'prj_01stubmodesstubmodesstub0';
const CANVAS = `cnv_${PROJECT.slice(4)}`;
const SHOT = 'node_01stubshot2stubshot2stub';

const node = (id: string, title: string, x: number) => ({
  id,
  canvas_id: CANVAS,
  kind: 'video',
  title,
  params: JSON.stringify({ prompt: `${title}, a bottle on a rock`, model: 'bytedance/seedance-2.0-fast', mode: 't2v', seconds: 5, resolution: '720p', ratio: '9:16' }),
  x,
  y: 120,
  group_id: null,
  active_version_id: null,
  status: 'idle',
  created_by: 'agent',
  updated_at: 1,
});

const SNAPSHOT = { projectId: PROJECT, revision: 3, canvases: [{ id: CANVAS, title: 'Modes', viewport: null }], nodes: [node('node_01stubshot1stubshot1stub', 'Shot 1', 200), node(SHOT, 'Shot 2', 600)], edges: [], groups: [] };

interface Stub {
  ws: WebSocketRoute | null;
  sends: Array<{ text: string; mode?: string; autoBudget?: number }>;
  undos: unknown[];
  quotes: Array<{ scope?: string; nodeIds?: string[] }>;
  starts: number;
}

const THREAD = { id: 'thr_modes', workspaceId: 'ws_stub', projectId: PROJECT, canvasId: CANVAS, surface: 'canvas', skill: null, tool: null, llm: null, mode: null, autoBudget: null, messages: [], proposals: [], auto: [] };
const CHANGE = { id: 'turn_a:chg:1', proposalId: 'prop_a', kind: 'graphPatch', summary: 'Warmer shot 2', projectId: PROJECT, revision: 4, ops: 1, nodeIds: [SHOT], status: 'applied' };
const AUTO = { turnId: 'turn_a', budget: 300, spent: 0, changes: [CHANGE], runs: [{ id: 'turn_a:run:1', nodeIds: [SHOT], credits: 420, status: 'needs_approval' }] };

async function setup(page: Page): Promise<Stub> {
  const s: Stub = { ws: null, sends: [], undos: [], quotes: [], starts: 0 };
  await page.addInitScript(() => {
    delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  });
  await stubApi(page, { delayMs: 30 });
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    s.ws = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; id: string; payload?: { projectId?: string } };
      if (msg.type === 'subscribe' && msg.payload?.projectId === PROJECT) {
        ws.send(JSON.stringify({ type: 'subscribed', id: msg.id, channel: 'project', projectId: PROJECT, payload: { projectId: PROJECT, revision: 3, seq: 0, canEdit: true, snapshot: SNAPSHOT } }));
      }
    });
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path === '/api/me') return json(route, { ...ME, prefs: { ...ME.prefs, agentMode: 'edit', autoBudget: null } });
    if (path === `/api/projects/${PROJECT}` && method === 'GET') return json(route, { project: { id: PROJECT, title: 'Modes', workspaceId: 'ws_stub' }, role: 'owner', canEdit: true, snapshot: SNAPSHOT });
    if (path === '/api/agent/threads' && method === 'POST') return json(route, { thread: THREAD }, 201);
    if (path === '/api/agent/threads/thr_modes' && method === 'GET') return json(route, { thread: THREAD });
    if (path === '/api/agent/threads/thr_modes/messages' && method === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Stub['sends'][number];
      s.sends.push(body);
      if (body.mode === 'read') return json(route, { turnId: 'turn_r', messageId: 'm_r', text: 'Shot 2 would get warmer light; switch to Edit or Auto to change it.', reason: 'completed', proposal: null, error: null, llm: 'deepseek-v4.1-flash', mode: 'read', auto: null });
      // Auto: the server applied the patch and left the run over the budget for approval (agent.auto streams first).
      s.ws?.send(JSON.stringify({ channel: 'project', projectId: PROJECT, type: 'agent.auto', id: 'e1', payload: { threadId: 'thr_modes', turnId: 'turn_a', auto: AUTO } }));
      return json(route, {
        turnId: 'turn_a',
        messageId: 'm_a',
        text: 'Shot 2 has warmer light. Its run is over this turn’s budget, so it waits for you.',
        reason: 'proposal',
        proposal: { id: 'prop_a', kind: 'graphPatch', status: 'applied', baseRevision: 3, summary: 'Warmer shot 2', createdAt: 1, estimate: { credits: 420, items: [], applyIsFree: true, balanceAfter: 0, needsConfirm: true }, risks: [], body: { kind: 'graphPatch', projectId: PROJECT, ops: [], touched: { added: [], updated: [SHOT], removed: [], edges: 0 } } },
        error: null,
        llm: 'deepseek-v4.1-flash',
        mode: 'auto',
        auto: AUTO,
      });
    }
    if (path === '/api/agent/threads/thr_modes/auto/undo' && method === 'POST') {
      s.undos.push(JSON.parse(req.postData() ?? '{}'));
      return json(route, { ok: true, undone: [CHANGE.id], failed: [], auto: { ...AUTO, changes: [{ ...CHANGE, status: 'undone' }] } });
    }
    if (path === '/api/runs/quote' && method === 'POST') {
      s.quotes.push(JSON.parse(req.postData() ?? '{}') as Stub['quotes'][number]);
      return json(route, {
        quoteId: 'q_modes',
        items: [{ ref: 'r1', nodeId: SHOT, title: 'Shot 2', kind: 'video', action: 'run', model: 'bytedance/seedance-2.0-fast', modelName: 'Seedance 2.0 Fast', credits: 420, dependsOn: [] }],
        total: 420,
        balance: 5000,
        balanceAfter: 4580,
        expiresAt: Date.now() + 600_000,
        confirmThreshold: 300,
        needsConfirm: true,
      });
    }
    if (path === '/api/runs' && method === 'POST') {
      s.starts += 1;
      return json(route, { runId: 'run_modes1', status: 'queued' }, 201);
    }
    return route.fallback();
  });
  return s;
}

const panel = (page: Page) => page.locator('aside[aria-label="Agent"]');

async function ask(page: Page, text: string) {
  const box = page.getByLabel('Tell the agent');
  await box.fill(text);
  await box.press('Enter');
}

test('canvas agent: the turn carries the mode; Read proposes nothing; Auto shows the change with Undo, the spend and the run waiting for approval', async ({ page }) => {
  const s = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${PROJECT}`);
  await panel(page).getByRole('button', { name: 'Agent mode: Edit' }).click();
  await page.getByRole('menuitemradio', { name: /^Read/ }).click();
  await ask(page, 'make shot 2 warmer');
  await expect(panel(page)).toContainText('switch to Edit or Auto');
  expect(s.sends.at(-1)).toMatchObject({ text: 'make shot 2 warmer', mode: 'read' });
  expect(s.sends.at(-1)).not.toHaveProperty('autoBudget');
  await expect(page.getByTestId('graph-proposal')).toHaveCount(0);

  await panel(page).getByRole('button', { name: 'Agent mode: Read' }).click();
  await page.getByRole('menuitemradio', { name: /^Auto/ }).click();
  await expect(panel(page).getByTestId('agent-budget')).toHaveText('Budget 300');
  await ask(page, 'make shot 2 warmer and run it');
  const summary = panel(page).getByTestId('auto-summary').last();
  await expect(summary).toContainText('Agent changed 1 thing');
  expect(s.sends.at(-1)).toMatchObject({ mode: 'auto', autoBudget: 300 });
  await expect(summary.getByTestId('auto-spend')).toHaveText('0 of 300 credits');
  // Applied by the server: no Apply card.
  await expect(page.getByTestId('graph-proposal')).toHaveCount(0);

  await summary.getByRole('button', { name: 'Undo: Warmer shot 2' }).click();
  await expect(summary.getByTestId('auto-change')).toHaveAttribute('data-status', 'undone');
  expect(s.undos).toEqual([{ changeId: CHANGE.id }]);

  const approve = summary.getByTestId('auto-run-approve');
  await expect(approve).toHaveText('Run · 420 credits');
  await approve.click();
  await expect.poll(() => s.quotes.at(-1)).toMatchObject({ scope: 'selection', nodeIds: [SHOT] });
  // Over the confirm threshold: the normal confirm asks before anything is held.
  const confirm = page.getByRole('dialog', { name: 'Confirm' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: /^Generate · 420 credits$/ }).click();
  await expect.poll(() => s.starts).toBe(1);
});

test('Home agent in Auto (D-039): the brief opens its own canvas; its first turn carries the mode and budget, and the plan the server built shows there', async ({ page }) => {
  const sends: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  });
  await stubApi(page, { delayMs: 30 });
  await page.routeWebSocket(/\/api\/ws/, (ws) =>
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; id: string; payload?: { projectId?: string } };
      if (msg.type === 'subscribe' && msg.payload?.projectId === PROJECT) {
        ws.send(JSON.stringify({ type: 'subscribed', id: msg.id, channel: 'project', projectId: PROJECT, payload: { projectId: PROJECT, revision: 0, seq: 0, canEdit: true, snapshot: { ...SNAPSHOT, revision: 0, nodes: [] } } }));
      }
    }),
  );
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/me') return json(route, { ...ME, prefs: { ...ME.prefs, agentMode: 'auto', autoBudget: 500 } });
    if (path === '/api/projects' && req.method() === 'POST') return json(route, { project: { id: PROJECT, title: 'A lamp ad for my desk brand', kind: 'canvas' } }, 201);
    if (path === `/api/projects/${PROJECT}` && req.method() === 'GET') return json(route, { project: { id: PROJECT, title: 'A lamp ad for my desk brand', workspaceId: 'ws_stub' }, role: 'owner', canEdit: true, snapshot: { ...SNAPSHOT, nodes: [] } });
    if (path === '/api/agent/threads' && req.method() === 'POST') return json(route, { thread: { ...THREAD, id: 'thr_home' } }, 201);
    if (path === '/api/agent/threads/thr_home/messages') {
      sends.push(JSON.parse(req.postData() ?? '{}') as Record<string, unknown>);
      const plan = { id: 'turn_h:chg:1', proposalId: 'prop_h', kind: 'plan', summary: 'Desk at dusk', projectId: PROJECT, revision: 1, ops: 6, nodeIds: [], status: 'applied' };
      return json(route, { turnId: 'turn_h', messageId: 'm_h', text: 'Two shots by the desk.', reason: 'proposal', proposal: null, error: null, llm: 'deepseek-v4.1-flash', mode: 'auto', auto: { turnId: 'turn_h', budget: 500, spent: 0, changes: [plan], runs: [] } });
    }
    return route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // The Preferences default (Auto, 500 credits) applies on Home.
  await expect(page.getByRole('button', { name: 'Agent mode: Auto' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run budget per turn' })).toHaveText(/Budget 500/);
  await page.locator('#brief').fill('A lamp ad for my desk brand');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}`));
  await expect(panel(page).getByRole('button', { name: 'Agent mode: Auto' })).toBeVisible();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ text: 'A lamp ad for my desk brand', mode: 'auto', autoBudget: 500 });
  await expect(panel(page).getByTestId('auto-summary')).toContainText('Agent changed 1 thing');
});
