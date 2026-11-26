import { expect, type Page, type Route } from '@playwright/test';

/**
 * A real-mode app whose API answers slowly with empty data: a signed-in member
 * with no projects, templates, assets, runs or models. Every `/api` request is
 * answered here after `delayMs` (long enough for the 150ms skeleton delay), so
 * each page must show skeletons first and then its empty state, never demo data.
 */

/** Demo strings and ids from the mocks and designs; none may ever render in real mode. */
export const MOCK_STRINGS = [
  'Ridgeline',
  'prj_demo',
  'Alex Chen',
  'alex@ridgeline',
  '48213',
  'golden-hour',
  'Shot A',
  'Desk organizer',
  'Product photo',
  'Two-person product demo',
  'Morning. The first sip',
  'Only changes',
  'S02 · Lighting',
  '@Lead',
  '2,480',
  '1,041',
];

const NOW = Date.UTC(2026, 10, 26, 9, 0);

export const ME = {
  user: { id: 'usr_stub', email: 'stub.user@example.test', name: 'Stub User', image: null, emailVerified: true, handle: 'stubuser', bio: null },
  workspace: { id: 'ws_stub', name: 'Personal', kind: 'personal', matureAllowed: false },
  role: 'owner',
  monthlyCreditLimit: null,
  workspaces: [{ id: 'ws_stub', name: 'Personal', kind: 'personal', role: 'owner', plan: 'plus' }],
  prefs: {
    language: 'en',
    currency: 'USD',
    creationMode: 'simple',
    defaultRatio: '9:16',
    defaultModel: 'auto',
    confirmThreshold: 300,
    notifications: {},
    theme: 'dark',
    matureContent: false,
  },
  plan: {
    id: 'plus',
    label: 'Plus',
    interval: 'month',
    status: 'active',
    currentPeriodEnd: NOW + 20 * 86_400_000,
    cancelAtPeriodEnd: false,
    perks: { monthlyCredits: 0, topUpBonus: 0, concurrentJobs: 2, maxVideoResolution: '1080p', maxImageResolution: '2K', voiceCloning: false, seats: 1 },
  },
  isMember: true,
  matureAllowed: false,
  balance: { plan: 137, purchased: 0, held: 0, planExpiresAt: NOW + 20 * 86_400_000 },
};

const EMPTY_STATS = { usedThisMonth: 0, usedLastMonth: 0, running: 0, successRate: null, runsLast7Days: 0, refundedThisMonth: 0 };

function graphql(body: string): unknown {
  const q = (JSON.parse(body || '{}') as { query?: string }).query ?? '';
  const page = { edges: [], pageInfo: { hasNextPage: false, endCursor: null } };
  if (q.includes('publicSubCategories')) return { data: { publicSubCategories: [] } };
  if (q.includes('publicCategories')) return { data: { publicCategories: [] } };
  if (q.includes('publicItems')) return { data: { publicItems: page } };
  if (q.includes('projects(')) return { data: { projects: page } };
  if (q.includes('assets(')) return { data: { assets: page } };
  return { data: {} };
}

/** JSON body for a `/api` request, or null for "not found". */
function answer(method: string, path: string, body: string): unknown {
  if (path === '/api/me') return ME;
  if (path === '/api/health') return { ok: true };
  if (path === '/api/auth/providers') return { emailCode: true, google: false };
  if (path.startsWith('/api/models')) return { models: [] };
  if (path === '/api/graphql') return graphql(body);
  if (path === '/api/templates') return { items: [], featured: [], total: 0 };
  if (path === '/api/runs' && method === 'GET') return { runs: [], stats: EMPTY_STATS, nextCursor: null };
  if (path === '/api/characters' || path === '/api/voices') return { items: [] };
  if (path === '/api/projects' && method === 'GET') return { items: [], projects: [], nextCursor: null };
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (project && method === 'GET') return { project: { id: project[1], title: 'Untitled project' }, role: 'owner', canEdit: true, snapshot: null };
  if (/^\/api\/projects\/[^/]+\/share$/.test(path)) return { enabled: false, audience: 'link', allowDownload: false, showPrompt: true, url: null, snapshotAt: null };
  if (path === '/api/agent/allowance') return { plan: 'plus', allowanceUsd: 1, usedUsd: 0, resetsAt: NOW + 20 * 86_400_000, models: [] };
  if (path === '/api/agent/threads') return { items: [] };
  if (path === '/api/billing') return { plan: 'plus', interval: 'month', status: 'active', renewsAt: NOW + 20 * 86_400_000, cancelAtPeriodEnd: false, periodEnd: NOW + 20 * 86_400_000, periodStart: NOW - 10 * 86_400_000, balance: ME.balance, autoTopUp: null, seats: null };
  if (path === '/api/billing/invoices') return { invoices: [] };
  if (path === '/api/billing/ledger') return { lines: [], nextCursor: null };
  if (path === '/api/billing/payment-method') return { paymentMethod: null };
  if (path === '/api/auth/list-accounts') return [];
  if (path === '/api/workspace/members') return { members: [], invites: [], seats: { used: 1, limit: 1, team: false } };
  return null;
}

export async function stubApi(page: Page, opts: { delayMs?: number } = {}): Promise<void> {
  // Long enough that each skeleton stays up across Playwright's polling back-off.
  const delayMs = opts.delayMs ?? 2000;
  // Keep realtime sockets open and silent (no snapshot, no events).
  await page.routeWebSocket(/\/api\//, () => {});
  await page.route(/\/api\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    await new Promise((r) => setTimeout(r, delayMs));
    const body = answer(req.method(), url.pathname, req.postData() ?? '');
    try {
      if (body === null) await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }) });
      else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    } catch {
      /* The page navigated away meanwhile. */
    }
  });
}

/** Fails if any demo string or id shows up in the page text or markup. */
export async function expectNoMockStrings(page: Page): Promise<void> {
  const html = await page.content();
  for (const s of MOCK_STRINGS) expect(html, `mock string "${s}" rendered in real mode`).not.toContain(s);
}

/**
 * Samples the page every 50ms while `run` waits for the data, so a mock row
 * that shows only briefly (the reported bug: demo data, then empty) is caught.
 */
export async function watchForMockStrings(page: Page, run: () => Promise<void>): Promise<void> {
  const seen = new Set<string>();
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const html = await page.content().catch(() => '');
      for (const s of MOCK_STRINGS) if (html.includes(s)) seen.add(s);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  try {
    await run();
  } finally {
    stop = true;
    await sampler;
  }
  expect([...seen], 'mock strings seen at any point while loading').toEqual([]);
  await expectNoMockStrings(page);
}
