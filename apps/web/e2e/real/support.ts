import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Real-backend helpers (docs/canvas-flow.md). Env:
 * - `PW_BASE_URL` — the deployed Worker (staging) or the local `wrangler dev` (`PW_REAL_LOCAL=1`).
 * - `TEST_INBOX_TOKEN` — bearer token of `GET /api/test/inbox` (`EMAIL_PROVIDER=test-inbox`).
 * - `PW_MEMBER_EMAIL` — a test account with an active plan (steps 1, 5–9 spend credits / use the agent).
 * - `PW_PRODUCT_PHOTO` — optional path of the `@` product photo for step 1.
 * - `PW_GENERATE=1` — run the generation steps (6–8). They need a gateway behind the Worker: staging's
 *   Hyperouter, or locally (`PW_REAL_LOCAL=1`) the fake one (`apps/api/scripts/fake-hyperouter.mjs`),
 *   where they run by default.
 * - `PW_REAL_LOCAL=1` — local defaults: inbox token `e2e-local`, member `e2e-member@rolling.local`
 *   (given a plan through `POST /api/test/plan`), generation on.
 */
const LOCAL = process.env.PW_REAL_LOCAL === '1';
export const env = {
  local: LOCAL,
  inboxToken: process.env.TEST_INBOX_TOKEN ?? (LOCAL ? 'e2e-local' : ''),
  memberEmail: process.env.PW_MEMBER_EMAIL ?? (LOCAL ? 'e2e-member@rolling.local' : ''),
  productPhoto: process.env.PW_PRODUCT_PHOTO ?? '',
  generate: process.env.PW_GENERATE === '1' || (LOCAL && process.env.PW_GENERATE !== '0'),
  /** Give the member account an active plan and credits through the test route (local and staging test accounts). */
  grantPlan: process.env.PW_GRANT_PLAN === '1' || (LOCAL && process.env.PW_GRANT_PLAN !== '0'),
  /** The FFmpeg container answers behind the Worker (staging, or `wrangler dev --enable-containers` with media URLs reachable from Docker). */
  exportRender: process.env.PW_EXPORT === '1',
};

async function latestCode(request: APIRequestContext, email: string, after: number): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const r = await request.get(`/api/test/inbox?to=${encodeURIComponent(email)}&limit=5`, { headers: { authorization: `Bearer ${env.inboxToken}` } });
    expect(r.status(), 'test inbox reachable (EMAIL_PROVIDER=test-inbox, TEST_INBOX_TOKEN)').toBe(200);
    const body = (await r.json()) as { messages: Array<{ code: string | null; sentAt: number }> };
    const m = body.messages.find((x) => x.code && x.sentAt >= after - 5_000);
    if (m?.code) return m.code;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`No sign-in code for ${email}`);
}

/**
 * Session cookies per email, reused across tests in this worker: a new code can only be sent
 * every 30 s (resend cooldown), so signing in again for every test would stall.
 */
const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>>();

/** Email-code sign-in through the API (session cookie lands in the page's context). */
export async function signIn(page: Page, email: string, baseURL: string) {
  const cached = sessions.get(email);
  if (cached) {
    await page.context().addCookies(cached);
    if ((await page.request.get('/api/me')).status() === 200) return;
  }
  // Better Auth checks Origin on cookie-bearing POSTs.
  const origin = new URL(baseURL).origin;
  const req = page.request;
  let started = Date.now();
  let send = await req.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers: { origin } });
  if (send.status() === 429) {
    // Still in the resend cooldown: wait it out, then ask for a fresh code.
    const body = (await send.json().catch(() => ({}))) as { error?: { data?: { retryAfter?: number } } };
    await new Promise((res) => setTimeout(res, ((body.error?.data?.retryAfter ?? 30) + 1) * 1000));
    started = Date.now();
    send = await req.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers: { origin } });
  }
  expect(send.status(), await send.text()).toBe(200);
  const otp = await latestCode(req, email, started);
  const res = await req.post('/api/auth/sign-in/email-otp', { data: { email, otp }, headers: { origin } });
  expect(res.status(), await res.text()).toBe(200);
  sessions.set(email, await page.context().cookies());
}

/** Active plan and credits for the signed-in test account (`POST /api/test/plan`, test inbox token). */
export async function ensureMember(page: Page, planId = 'plus', extraCredits = 50_000) {
  const r = await page.request.post('/api/test/plan', { data: { planId, extraCredits }, headers: { authorization: `Bearer ${env.inboxToken}` } });
  expect(r.status(), await r.text()).toBe(200);
}

/** Center of a node's port (in/out) on screen. */
export async function portCenter(page: Page, nodeId: string, port: 'in' | 'out') {
  const b = (await page.getByTestId(`node-${nodeId}`).locator(`[data-port="${port}"]`).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export async function dragWire(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Node ids on the canvas by kind, left to right. */
export async function nodesByKind(page: Page, kind: string): Promise<Array<{ id: string; x: number }>> {
  const els = page.locator(`[data-node-kind="${kind}"]`);
  const out: Array<{ id: string; x: number }> = [];
  for (let i = 0; i < (await els.count()); i++) {
    const el = els.nth(i);
    const id = (await el.getAttribute('data-testid'))!.replace(/^node-/, '');
    out.push({ id, x: (await el.boundingBox())!.x });
  }
  return out.sort((a, b) => a.x - b.x);
}
