import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type APIResponse, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

/**
 * Helpers for the full feature suite (docs/test-matrix.md) against staging.
 * Every spec signs in its own fresh accounts (`full.<tag>.<ts>@rolling.test`), so specs never share
 * state and the 30 s resend cooldown never stalls them. Members get a plan through `POST /api/test/plan`.
 */
function readToken(): string {
  if (process.env.TEST_INBOX_TOKEN) return process.env.TEST_INBOX_TOKEN.trim();
  const file = process.env.PW_TEST_INBOX_TOKEN_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return '';
}

export const env = {
  inboxToken: readToken(),
  generate: process.env.PW_GENERATE === '1',
  exportRender: process.env.PW_EXPORT === '1',
  out: process.env.PW_FULL_OUT ?? 'test-results/full',
};

export type PlanId = 'starter' | 'plus' | 'pro' | 'team';

let seq = 0;
export function freshEmail(tag: string): string {
  seq += 1;
  return `full.${tag}.${Date.now().toString(36)}${process.pid.toString(36)}${seq}@rolling.test`;
}

export function originOf(baseURL: string | undefined): string {
  return new URL(baseURL ?? 'https://staging.rolling.actor').origin;
}

/** Latest sign-in code sent to `email` at or after `after` (test inbox). */
export async function codeFor(request: APIRequestContext, email: string, after: number, template = 'sign-in-code'): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await request.get(`/api/test/inbox?to=${encodeURIComponent(email)}&limit=5`, { headers: { authorization: `Bearer ${env.inboxToken}` } });
    expect(r.status(), 'test inbox reachable (EMAIL_PROVIDER=test-inbox, TEST_INBOX_TOKEN)').toBe(200);
    const body = (await r.json()) as { messages: Array<{ code: string | null; sentAt: number; template: string }> };
    const m = body.messages.find((x) => x.code && x.template === template && x.sentAt >= after - 5_000);
    if (m?.code) return m.code;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`No sign-in code for ${email}`);
}

export async function inbox(request: APIRequestContext, email: string) {
  const r = await request.get(`/api/test/inbox?to=${encodeURIComponent(email)}&limit=10`, { headers: { authorization: `Bearer ${env.inboxToken}` } });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { messages: Array<{ to: string; subject: string; text: string; code: string | null; template: string; sentAt: number }> }).messages;
}

/** Polls the test inbox for a message with `template` (emails go out through a queue: allow ~30 s). */
export async function waitMail(request: APIRequestContext, email: string, template: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = (await inbox(request, email)).find((x) => x.template === template);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/** Email-code sign-in through the API; the session cookie lands in the request's context (page.request shares the browser context). */
export async function apiSignIn(request: APIRequestContext, email: string, baseURL: string | undefined) {
  const origin = originOf(baseURL);
  let started = Date.now();
  let send = await request.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers: { origin } });
  if (send.status() === 429) {
    const body = (await send.json().catch(() => ({}))) as { error?: { data?: { retryAfter?: number } } };
    await new Promise((res) => setTimeout(res, ((body.error?.data?.retryAfter ?? 30) + 1) * 1000));
    started = Date.now();
    send = await request.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers: { origin } });
  }
  expect(send.status(), await send.text()).toBe(200);
  const otp = await codeFor(request, email, started);
  const res = await request.post('/api/auth/sign-in/email-otp', { data: { email, otp }, headers: { origin } });
  expect(res.status(), await res.text()).toBe(200);
}

export async function signIn(page: Page, email: string, baseURL: string | undefined) {
  await apiSignIn(page.request, email, baseURL);
}

/** Active plan + purchased credits for the signed-in caller's workspace. */
export async function grantPlan(request: APIRequestContext, planId: PlanId = 'plus', extraCredits = 0, seats?: number) {
  const r = await request.post('/api/test/plan', {
    data: { planId, extraCredits, ...(seats ? { seats } : {}) },
    headers: { authorization: `Bearer ${env.inboxToken}` },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as { balance: { plan: number; purchased: number; held: number } };
}

/** A fresh signed-in account in `context` (optionally a member of `plan`). */
export async function account(context: BrowserContext, baseURL: string | undefined, tag: string, plan?: PlanId, extraCredits = 0) {
  const email = freshEmail(tag);
  await apiSignIn(context.request, email, baseURL);
  if (plan) await grantPlan(context.request, plan, extraCredits);
  const me = await getJson<{ user: { id: string }; workspace: { id: string } }>(context.request, '/api/me');
  return { email, userId: me.user.id, workspaceId: me.workspace.id };
}

export async function getJson<T = Record<string, unknown>>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(path);
  expect(r.status(), `${path}: ${await r.text().catch(() => '')}`).toBe(200);
  return (await r.json()) as T;
}

/** JSON call with the Origin header Better Auth and the CSRF checks want. */
export async function api(request: APIRequestContext, baseURL: string | undefined, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET', path: string, data?: unknown): Promise<APIResponse> {
  const headers = { origin: originOf(baseURL) };
  const opts = data === undefined ? { headers } : { headers, data };
  switch (method) {
    case 'GET':
      return request.get(path, { headers });
    case 'POST':
      return request.post(path, opts);
    case 'PATCH':
      return request.patch(path, opts);
    case 'PUT':
      return request.put(path, opts);
    case 'DELETE':
      return request.delete(path, opts);
  }
}

export async function errorCode(r: APIResponse): Promise<string | undefined> {
  const body = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
  return body.error?.code;
}

export interface SnapshotNode { id: string; kind: string; title: string; params: Record<string, unknown>; bypass: number | boolean; collapsed: number | boolean; status: string }
export interface Snapshot { revision: number; canvases: Array<{ id: string }>; nodes: SnapshotNode[]; edges: Array<{ id: string }> }

/** `GET /api/projects/:id` snapshot with node params parsed (the room stores them as JSON text). */
export async function projectSnapshot(request: APIRequestContext, id: string): Promise<Snapshot> {
  const s = (await getJson<{ snapshot: Snapshot & { nodes: Array<SnapshotNode & { params: unknown }> } }>(request, `/api/projects/${id}`)).snapshot;
  for (const n of s.nodes) if (typeof n.params === 'string') n.params = JSON.parse(n.params) as Record<string, unknown>;
  return s;
}

/** Creates a project and applies ops as revision 2 (retrying once on a stale base). */
export async function seedProject(request: APIRequestContext, baseURL: string | undefined, title: string, ops: unknown[]): Promise<{ id: string; revision: number; idMap: Record<string, string> }> {
  const created = await api(request, baseURL, 'POST', '/api/projects', { title });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = (await created.json()) as { project: { id: string } };
  if (ops.length === 0) return { id: project.id, revision: 1, idMap: {} };
  const snap = await getJson<{ snapshot: { revision: number } }>(request, `/api/projects/${project.id}`);
  const patched = await api(request, baseURL, 'POST', `/api/projects/${project.id}/patch`, { baseRevision: snap.snapshot.revision, ops });
  expect(patched.status(), await patched.text()).toBe(200);
  const body = (await patched.json()) as { revision: number; idMap: Record<string, string> };
  return { id: project.id, revision: body.revision, idMap: body.idMap ?? {} };
}

/** The small graph most canvas specs use: script → keyframe (cheap image) → video (cheapest i2v model, 480p, 1 s; the Lite model is t2v only). */
export const SAMPLE_OPS = [
  { op: 'addNode', tempId: 's', kind: 'script', title: 'Script', position: { x: 0, y: 0 }, params: { rows: [{ n: 1, title: 'Bottle', visual: 'A glass bottle on a mossy rock at dawn', seconds: 5 }] } },
  { op: 'addNode', tempId: 'k', kind: 'image', title: 'Keyframe', position: { x: 420, y: 0 }, params: { prompt: 'A glass bottle on a mossy rock at dawn, soft light', model: 'bytedance/seedream-5.0-flash', ratio: '9:16' } },
  { op: 'addNode', tempId: 'v', kind: 'video', title: 'Shot A', position: { x: 840, y: 0 }, params: { prompt: 'Slow push-in on the bottle', model: 'x-ai/grok-imagine-video-1.5', ratio: '9:16', resolution: '480p', length: 1 } },
  { op: 'connect', from: { node: 's', port: 'out' }, to: { node: 'k', port: 'prompt' } },
  { op: 'connect', from: { node: 'k', port: 'out' }, to: { node: 'v', port: 'frame' } },
];

export async function openCanvas(page: Page, id: string, query = '') {
  await page.goto(`/p/${id}${query}`);
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'saved', { timeout: 45_000 });
}

/** Records page errors, console errors and 5xx responses; `assertClean()` fails on any. */
export function watchErrors(page: Page, opts: { ignore?: RegExp[] } = {}) {
  const errors: string[] = [];
  const ignore = [/favicon/i, /Error retrieving a token|accounts list is empty|FedCM/ /* One Tap (FedCM) without a Google session in a headless browser */, /Failed to load resource: the server responded with a status of 4\d\d/, /accounts\.google\.com/, /gsi/i, ...(opts.ignore ?? [])];
  const skip = (t: string) => ignore.some((r) => r.test(t));
  page.on('pageerror', (e) => {
    if (!skip(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !skip(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500 && !skip(r.url())) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return {
    errors,
    assertClean(label = '') {
      expect(errors, `${label} console errors / 5xx`).toEqual([]);
    },
  };
}

/** Screenshot for our own visual inspection (not attached to the report). */
export async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = `${env.out}/shots`;
  mkdirSync(dir, { recursive: true });
  // The test id prefix plus the shot name (long titles are cut before the name, so names never collide).
  const safe = `${testInfo.title.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60)}-${name.replace(/[^a-z0-9._-]+/gi, '_')}`;
  const path = `${dir}/${safe}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => undefined);
  return path;
}

/** Appends a spend line (credits charged on staging) to `<out>/spend.jsonl`. */
export function logSpend(testInfo: TestInfo, entry: { runId?: string; model?: string; credits: number; refunded?: number; note?: string }) {
  mkdirSync(env.out, { recursive: true });
  appendFileSync(`${env.out}/spend.jsonl`, `${JSON.stringify({ test: testInfo.title, at: new Date().toISOString(), ...entry })}\n`);
}

export interface RunView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'canceled';
  credits: number;
  quoted: number;
  spent: number;
  refunded: number;
  error: string | null;
  items: Array<{ ref: string; status: string; credits: number; spent: number; refunded: number; assetId: string | null; error: string | null; errorCode: string | null; model: string | null }>;
}

export async function waitRun(request: APIRequestContext, runId: string, timeoutMs = 8 * 60_000): Promise<RunView> {
  const until = Date.now() + timeoutMs;
  let run: RunView | null = null;
  while (Date.now() < until) {
    run = (await getJson<{ run: RunView }>(request, `/api/runs/${runId}`)).run;
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`run ${runId} still ${run?.status} after ${timeoutMs} ms`);
}

export async function balance(request: APIRequestContext) {
  return (await getJson<{ balance: { plan: number; purchased: number; held: number } }>(request, '/api/billing')).balance;
}

/** Budget guard: the whole suite may charge at most this many credits on staging ($5 retail at $0.01/credit). */
export const SPEND_CEILING_CREDITS = 500;

/** Whether this environment takes payments (`GET /api/billing/plans` → `paymentsEnabled`). */
export async function paymentsEnabled(request: APIRequestContext): Promise<boolean> {
  return ((await getJson<{ paymentsEnabled?: boolean }>(request, '/api/billing/plans')).paymentsEnabled ?? true) !== false;
}

/**
 * The shared upgrade modal (every locked click opens it in place). With payments on it is titled by the reason
 * (“The agent needs a plan”, “1080p needs Plus”, …) and offers “Continue with <plan>”; while the environment takes
 * no payments (staging today) it says “Payments aren’t available yet” whatever the reason.
 */
export async function expectUpgradeModal(page: Page, title: string | RegExp) {
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('upgrade-modal') });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  if (await paymentsEnabled(page.request)) {
    await expect(dialog.getByRole('heading').first()).toHaveText(title);
    await expect(dialog.getByRole('button', { name: /^Continue with/ })).toBeVisible();
  } else {
    // Payments off: the reason stays the headline and the notice under it says payments are not available (UX fix 7).
    await expect(dialog.getByTestId('upgrade-modal')).toHaveAttribute('data-phase', 'unavailable');
    await expect(dialog.getByRole('heading').first()).toHaveText(title);
    await expect(dialog.getByTestId('upgrade-unavailable')).toContainText('Payments aren’t available yet');
  }
  return dialog;
}
