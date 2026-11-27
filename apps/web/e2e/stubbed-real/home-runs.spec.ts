import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { ME, stubApi } from './support';

/**
 * Home generations and the Home agent in real mode against a stubbed API and a
 * stubbed global socket (D-014): the run card follows the run (queued → live
 * progress over the socket → done or failed), cancels, survives a reload; the
 * cost line and the card show the server's quote, never a client estimate;
 * the agent streams over the socket, handles small talk and builds a plan.
 */

const OUT = fileURLToPath(new URL('../__screens__/home/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7ADmUAAAAASUVORK5CYII=', 'base64');

/** Seedance 2.0 Fast as the old catalog listed it: 182 credits per 5 s at 720p (a client scaling it gets 10 s = 364). */
const VIDEO_MODEL = {
  id: 'bytedance/seedance-2.0-fast',
  kind: 'video',
  name: 'Seedance 2.0 Fast',
  tags: [],
  default: true,
  auto: true,
  mature: false,
  matureOnly: false,
  requiresIdentitySafety: false,
  operations: ['t2v', 'i2v'],
  seconds: { min: 4, max: 15 },
  defaultSeconds: 5,
  resolutions: ['480p', '720p'],
  defaultResolution: '720p',
  ratios: ['9:16', '16:9', '1:1'],
  audio: false,
  lipSync: false,
  credits: [
    { resolution: '480p', seconds: 5, credits: 85 },
    { resolution: '720p', seconds: 5, credits: 182 },
  ],
};
const CHAT_MODEL = { ...VIDEO_MODEL, id: 'deepseek-v4.1-flash', kind: 'chat', name: 'DeepSeek V4.1 Flash', operations: ['chat'], seconds: null, defaultSeconds: null, resolutions: [], defaultResolution: null, credits: [] };

interface Stub {
  /** What `GET /api/runs/:id` answers next. */
  run: Record<string, unknown>;
  quoteTotal: number;
  starts: number;
  cancels: number;
  ws: WebSocketRoute | null;
  /** Agent turns: text (sent as deltas) and an optional plan. */
  turns: Array<{ text: string; plan?: boolean }>;
  messages: string[];
  /** Bodies of `POST /api/runs/quote`. */
  quotes: Array<{ surface?: string; promptSpec?: unknown }>;
}

const QUOTE = (total: number) => ({
  quoteId: 'q_stub',
  items: [{ ref: 'r1', title: 'Shot', kind: 'video', action: 'run', model: VIDEO_MODEL.id, modelName: VIDEO_MODEL.name, credits: total }],
  total,
  balance: 5000,
  balanceAfter: 5000 - total,
  expiresAt: Date.now() + 600_000,
  confirmThreshold: 1000,
  needsConfirm: false,
});

const runView = (over: Record<string, unknown>) => ({
  id: 'run_stub1',
  ref: 'R-1',
  name: 'A lamp turning on',
  source: 'quickCreate',
  projectId: null,
  projectTitle: null,
  params: '',
  status: 'queued',
  progress: 0,
  credits: 363,
  quoted: 363,
  spent: 0,
  refunded: 0,
  error: null,
  createdAt: Date.now(),
  finishedAt: null,
  items: [],
  tool: 'quick',
  retryable: false,
  ...over,
});

const PLAN = {
  id: 'prop_stub1',
  kind: 'plan',
  status: 'proposed',
  baseRevision: null,
  summary: 'Two options',
  createdAt: Date.now(),
  estimate: { credits: 420, items: [], applyIsFree: true, balanceAfter: 4580, needsConfirm: true },
  risks: [],
  body: {
    kind: 'plan',
    seconds: 10,
    refs: [],
    options: [
      {
        title: 'Desk at dusk',
        ratio: '9:16',
        resolution: '720p',
        seconds: 10,
        estimate: { credits: 420, items: [], applyIsFree: true, balanceAfter: 4580, needsConfirm: true },
        ops: [],
        shots: [
          { n: 1, title: 'Switch', seconds: 5, visual: 'A hand turns the lamp on', model: VIDEO_MODEL.id, mode: 'i2v', resolution: '720p', credits: 210 },
          { n: 2, title: 'Glow', seconds: 5, visual: 'Warm light fills the desk', line: 'Light that works late', model: VIDEO_MODEL.id, mode: 'i2v', resolution: '720p', credits: 210 },
        ],
      },
    ],
  },
};

async function setup(page: Page): Promise<Stub> {
  const s: Stub = { run: runView({}), quoteTotal: 363, starts: 0, cancels: 0, ws: null, turns: [], messages: [], quotes: [] };
  // Main-thread socket (no SharedWorker), so the page's WebSocket route sees it.
  await page.addInitScript(() => {
    delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  });
  await stubApi(page, { delayMs: 30 });
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    s.ws = ws;
    ws.onMessage(() => {});
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    // Theme follows the system (D-010), so the light-mode check below can switch it.
    if (path === '/api/me') return json(route, { ...ME, prefs: { ...ME.prefs, theme: 'system' } });
    if (path.startsWith('/api/models')) {
      const kind = url.searchParams.get('kind');
      return json(route, { models: kind === 'chat' ? [CHAT_MODEL] : kind === 'video' ? [VIDEO_MODEL] : kind ? [] : [VIDEO_MODEL, CHAT_MODEL] });
    }
    if (path === '/api/agent/allowance') return json(route, { plan: 'plus', allowanceUsd: 3.5, usedUsd: 0, resetsAt: Date.now() + 86_400_000, models: [{ id: CHAT_MODEL.id, name: CHAT_MODEL.name, unlimited: true }] });
    if (path === '/api/runs/quote' && method === 'POST') {
      s.quotes.push(JSON.parse(req.postData() ?? '{}') as Stub['quotes'][number]);
      return json(route, QUOTE(s.quoteTotal));
    }
    if (path === '/api/runs' && method === 'POST') {
      s.starts += 1;
      return json(route, { runId: `run_stub${s.starts}`, status: 'queued' }, 201);
    }
    const one = /^\/api\/runs\/(run_stub\d+)$/.exec(path);
    if (one && method === 'GET') return json(route, { run: { ...s.run, id: one[1] } });
    if (path === '/api/runs/run_stub1/cancel') {
      s.cancels += 1;
      s.run = runView({ status: 'canceled', refunded: 363, finishedAt: Date.now() });
      return json(route, { runId: 'run_stub1', refunded: 363, canceled: 1 });
    }
    if (path.startsWith('/api/media/private/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (path === '/api/agent/threads' && method === 'POST') return json(route, { thread: { id: 'thr_stub', workspaceId: 'ws_stub', projectId: null, canvasId: null, surface: 'home', skill: null, tool: null, llm: null, messages: [], proposals: [] } }, 201);
    if (path === '/api/agent/threads/thr_stub' && method === 'GET') {
      const msgs = s.messages.map((content, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content, createdAt: i }));
      return json(route, { thread: { id: 'thr_stub', workspaceId: 'ws_stub', projectId: null, canvasId: null, surface: 'home', skill: null, tool: null, llm: null, messages: msgs, proposals: [] } });
    }
    if (path === '/api/agent/threads/thr_stub/messages' && method === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as { text: string; llm?: string };
      const turn = s.turns.shift() ?? { text: 'Okay.' };
      s.messages.push(body.text, turn.text);
      // Tokens stream over the user socket while the request is open (agent.delta, D-014).
      await new Promise((r) => setTimeout(r, 400));
      s.ws?.send(JSON.stringify({ channel: 'user', type: 'agent.tool', id: 't1', payload: { threadId: 'thr_stub', turnId: 'turn1', name: 'models.capabilities', status: 'started' } }));
      await new Promise((r) => setTimeout(r, 1500));
      for (const word of turn.text.split(/(?<= )/)) {
        s.ws?.send(JSON.stringify({ channel: 'user', type: 'agent.delta', id: `d${Math.random()}`, payload: { threadId: 'thr_stub', turnId: 'turn1', delta: word } }));
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 300));
      return json(route, { turnId: 'turn1', messageId: 'm1', text: turn.text, reason: turn.plan ? 'proposal' : 'completed', proposal: turn.plan ? PLAN : null, error: null, llm: body.llm ?? 'deepseek-v4.1-flash' });
    }
    if (path === '/api/agent/proposals/prop_stub1/apply') return json(route, { ok: true, proposalId: 'prop_stub1', kind: 'plan', projectId: 'prj_stub' });
    return route.fallback();
  });
  return s;
}

const send = async (page: Page, mode: string, text: string) => {
  await page.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab', { name: mode }).click();
  await page.locator('#brief').fill(text);
};
const userEvent = (s: Stub, type: string, payload: unknown) => s.ws?.send(JSON.stringify({ channel: 'user', type, id: `e${Math.random()}`, payload }));

test('video run card: the cost line is the server quote, the card holds the same; queued → live progress → done with the video inline', async ({ page }) => {
  const s = await setup(page);
  s.quoteTotal = 181;
  s.run = runView({ credits: 181, quoted: 181 });
  await page.goto('/');
  await send(page, 'Video', 'A lamp turning on');
  // The catalog sample says 182 for 5 s; the server quote (181) is what the line shows and what is held.
  const box = page.locator('section[aria-label="Start creating"]');
  await expect(box.getByText('181 credits', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  const card = page.getByTestId('home-run').first();
  await expect(card).toHaveAttribute('data-status', 'queued');
  await expect(card.getByTestId('home-run-cost')).toHaveText('181 credits held · charged only if it succeeds');
  expect(s.starts).toBe(1);
  // The run is quoted as a Home run (Activity's Source says Home, not Quick Create).
  expect(s.quotes.at(-1)?.surface).toBe('home');
  // No "started · N credits held" toast any more.
  await expect(page.getByText(/credits held$/)).toHaveCount(0);
  await expect(page.locator('#brief')).toHaveValue('A lamp turning on');
  // Live progress over the user socket.
  userEvent(s, 'activity.updated', { runId: 'run_stub1', jobId: 'job_1', progress: 0.42 });
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  await expect(card).toContainText('Generating · 42%');
  await page.screenshot({ path: `${OUT}real-run-progress.png` });
  // Done: the run view brings the asset; the video plays inline, muted, with controls.
  s.run = runView({ status: 'done', progress: null, spent: 181, credits: 181, finishedAt: Date.now(), items: [{ ref: 'r1', status: 'succeeded', assetId: 'ast_video1', kind: 'video' }] });
  userEvent(s, 'activity.updated', { runId: 'run_stub1', jobId: 'job_1' });
  await expect(card).toHaveAttribute('data-status', 'done');
  const video = card.getByTestId('home-run-video');
  await expect(video).toHaveAttribute('src', /\/api\/media\/private\/ast_video1/);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted && v.controls)).toBe(true);
  await expect(card.getByTestId('home-run-cost')).toHaveText('181 credits');
  await expect(card.getByRole('button', { name: 'Open in canvas' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Download' })).toBeVisible();
  // Reload: the card comes back from the runs API.
  await page.reload();
  await expect(page.getByTestId('home-run')).toHaveCount(1);
  await expect(page.getByTestId('home-run').first()).toHaveAttribute('data-status', 'done');
});

test('a running card whose provider reports no progress shows the elapsed time and an indeterminate bar, never a percentage', async ({ page }) => {
  const s = await setup(page);
  await page.goto('/');
  await send(page, 'Video', 'A lamp turning on');
  await page.getByRole('button', { name: 'Start' }).click();
  const card = page.getByTestId('home-run').first();
  await expect(card).toHaveAttribute('data-status', 'queued');
  s.run = runView({ status: 'running', progress: 0 });
  userEvent(s, 'activity.updated', { runId: 'run_stub1', jobId: 'job_1', progress: 0 });
  await expect(card).toHaveAttribute('data-status', 'running');
  const bar = card.getByRole('progressbar');
  await expect(bar).not.toHaveAttribute('aria-valuenow', /.*/);
  await expect(bar.locator('.rl-indeterminate')).toHaveCount(1);
  await expect(card).not.toContainText('%');
  await expect(card).toContainText(/\d+:\d{2}/);
});

test('a run left running survives a reload and keeps following; Cancel releases the hold', async ({ page }) => {
  const s = await setup(page);
  await page.goto('/');
  await send(page, 'Video', 'A lamp turning on');
  await expect(page.locator('section[aria-label="Start creating"]').getByText('363 credits', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('home-run').first()).toHaveAttribute('data-status', 'queued');
  s.run = runView({ status: 'running', progress: 0.25 });
  await page.reload();
  const card = page.getByTestId('home-run').first();
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card).toContainText('Generating · 25%');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toHaveAttribute('data-status', 'canceled');
  await expect(card.getByTestId('home-run-cost')).toHaveText('No credits were charged · 363 held credits released');
  expect(s.cancels).toBe(1);
});

test('a failed run shows the reason, that nothing was charged, and Retry', async ({ page }) => {
  const s = await setup(page);
  await page.goto('/');
  await send(page, 'Video', 'A lamp turning on');
  await page.getByRole('button', { name: 'Start' }).click();
  const card = page.getByTestId('home-run').first();
  await expect(card).toHaveAttribute('data-status', 'queued');
  s.run = runView({ status: 'failed', refunded: 363, finishedAt: Date.now(), retryable: false, items: [{ ref: 'r1', status: 'failed', assetId: null, error: 'The model timed out.', kind: 'video' }] });
  userEvent(s, 'activity.updated', { runId: 'run_stub1' });
  await expect(card).toHaveAttribute('data-status', 'failed');
  await expect(card.getByTestId('home-run-error')).toHaveText('The model timed out.');
  await expect(card.getByTestId('home-run-cost')).toHaveText('No credits were charged · 363 held credits released');
  await page.screenshot({ path: `${OUT}real-run-failed.png` });
  s.run = runView({});
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('home-run')).toHaveCount(2);
  await expect.poll(() => s.starts).toBe(2);
  await expect(page.getByTestId('home-run').first()).toHaveAttribute('data-status', 'queued');
  await expect(page.getByTestId('home-run').nth(1)).toHaveAttribute('data-status', 'failed');
});

test('agent: small talk streams a short reply over the socket; a brief returns a plan; Build on canvas opens the project; the thread survives a reload', async ({ page }) => {
  const s = await setup(page);
  s.turns.push({ text: 'Hi. Tell me what the video is for, how long it should be and whether it is vertical or widescreen.' });
  s.turns.push({ text: 'Here is a **10-second** plan.\n\n- Shot 1: the switch\n- Shot 2: the glow', plan: true });
  await page.goto('/');
  await page.locator('#brief').fill('hello');
  await page.locator('#brief').press('Enter');
  const agent = page.getByTestId('home-agent');
  await expect(agent.getByTestId('home-agent-user')).toHaveText('hello');
  await expect(agent.getByTestId('home-agent-typing')).toContainText('Checking models…');
  const reply = agent.getByTestId('home-agent-reply').last();
  await expect(reply).toHaveAttribute('data-status', 'streaming');
  await expect(reply).toContainText('Hi. Tell me');
  await expect(reply).toHaveAttribute('data-status', 'done');
  await expect(agent.getByTestId('home-plan')).toHaveCount(0);
  await expect(agent.getByTestId('home-agent-llm')).toHaveText(/DeepSeek V4\.1 Flash.*No turn limit/);
  const replyBox = agent.getByRole('textbox', { name: 'Reply to the agent' });
  await replyBox.fill('A 10s vertical ad for a desk lamp');
  await replyBox.press('Enter');
  const plan = agent.getByTestId('home-plan');
  await expect(plan).toBeVisible();
  await expect(agent.locator('strong', { hasText: '10-second' })).toBeVisible();
  await expect(plan).toContainText('Switch');
  await expect(plan).toContainText('5s · Seedance 2.0 Fast');
  await expect(plan).toContainText('“Light that works late”');
  await expect(plan).toContainText('About 420 credits to generate. Building is free.');
  await page.screenshot({ path: `${OUT}real-agent-plan.png` });
  // Reload: the conversation comes back from the thread.
  await page.reload();
  await expect(page.getByTestId('home-agent').getByTestId('home-agent-user')).toHaveCount(2);
  await expect(page.getByTestId('home-agent')).toContainText('Hi. Tell me what the video is for');
});

test('agent: the Home conversation comes from the server on a new device; Recent switches conversations; New conversation sticks after a reload', async ({ page }) => {
  const s = await setup(page);
  s.messages.push('A lamp ad for my desk brand', 'Here is what I would make.');
  const thread = (id: string, msgs: string[]) => ({
    thread: { id, workspaceId: 'ws_stub', projectId: null, canvasId: null, surface: 'home', skill: null, tool: null, llm: null, proposals: [], messages: msgs.map((content, i) => ({ id: `${id}_m${i}`, role: i % 2 ? 'assistant' : 'user', content, createdAt: i })) },
  });
  let graphql = 0;
  await page.route(/\/api\/(graphql|agent\/threads\/thr_old)$/, async (route) => {
    const req = route.request();
    if (req.url().endsWith('/thr_old')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(thread('thr_old', ['Sneaker drop teaser', 'Two options below.'])) });
    if (!(req.postData() ?? '').includes('agentThreads')) return route.fallback();
    graphql += 1;
    const items = [
      { id: 'thr_stub', projectId: null, surface: 'home', title: 'A lamp ad for my desk brand', updatedAt: Date.now() - 60_000 },
      { id: 'thr_old', projectId: null, surface: 'home', title: 'Sneaker drop teaser', updatedAt: Date.now() - 86_400_000 },
    ];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { agentThreads: items } }) });
  });
  // A browser that never had a Home thread (another device): the latest one comes from the server.
  await page.goto('/');
  const agent = page.getByTestId('home-agent');
  await expect(agent.getByTestId('home-agent-user')).toHaveText('A lamp ad for my desk brand');
  expect(graphql).toBeGreaterThan(0);
  await agent.getByRole('button', { name: 'Recent' }).click();
  const menu = page.getByRole('menu', { name: 'Recent conversations' });
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await menu.getByRole('menuitem', { name: /Sneaker drop teaser/ }).click();
  await expect(agent.getByTestId('home-agent-user')).toHaveText('Sneaker drop teaser');
  // This browser now remembers the one picked.
  await page.reload();
  await expect(page.getByTestId('home-agent').getByTestId('home-agent-user')).toHaveText('Sneaker drop teaser');
  // New conversation: a reload does not bring an older one back.
  await page.getByTestId('home-agent').getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByTestId('home-agent')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#brief')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('home-agent')).toHaveCount(0);
});

test('agent plan: Build on canvas applies it (free) and opens the new project', async ({ page }) => {
  const s = await setup(page);
  s.turns.push({ text: 'One option.', plan: true });
  await page.goto('/');
  await page.locator('#brief').fill('A 10s vertical ad for a desk lamp');
  const turn = page.waitForRequest((r) => r.url().includes('/api/agent/threads/thr_stub/messages'));
  await page.getByRole('button', { name: 'Start' }).click();
  // The pills go with the turn (they were dead controls): ratio, length and Auto video model.
  expect(JSON.parse((await turn).postData() ?? '{}')).toMatchObject({ settings: { ratio: '9:16', seconds: 15, videoModel: null } });
  const plan = page.getByTestId('home-plan');
  await expect(plan).toBeVisible();
  // UX audit: a plan that lands below the fold scrolls into view with its button.
  await expect(plan.getByRole('button', { name: 'Build on canvas' })).toBeInViewport();
  const applied = page.waitForRequest((r) => r.url().includes('/api/agent/proposals/prop_stub1/apply'));
  await plan.getByRole('button', { name: 'Build on canvas' }).click();
  expect(JSON.parse((await applied).postData() ?? '{}')).toMatchObject({ optionIndex: 0, title: 'Desk at dusk' });
  await expect(page).toHaveURL(/\/p\/prj_stub/);
});

test('light mode and reduced motion: the card and the conversation use theme tokens; the typing dots hold still', async ({ page }) => {
  const s = await setup(page);
  s.turns.push({ text: 'Hi. What is the video for?' });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await send(page, 'Video', 'A lamp turning on');
  await page.getByRole('button', { name: 'Start' }).click();
  const card = page.getByTestId('home-run').first();
  await expect(card).toHaveAttribute('data-status', 'queued');
  const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe(body);
  await page.screenshot({ path: `${OUT}real-run-light.png` });
  await page.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab', { name: 'Agent' }).click();
  await page.locator('#brief').fill('hello');
  await page.locator('#brief').press('Enter');
  const dot = page.getByTestId('home-agent-typing').locator('i').first();
  await expect(dot).toBeVisible();
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.getByTestId('home-agent-reply').last()).toHaveAttribute('data-status', 'done');
  await page.screenshot({ path: `${OUT}real-agent-light.png` });
});
