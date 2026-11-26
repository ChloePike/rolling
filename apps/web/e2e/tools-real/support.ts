import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * API stubs for the tool pages in real mode. The catalog models are made up on
 * purpose (names not in any design), so a design literal on screen can only
 * come from a demo branch.
 */
type Point = { resolution: string | null; seconds: number | null; credits: number };

const model = (o: Record<string, unknown> & { kind: string }) => ({
  tags: [],
  default: false,
  placement: 'featured',
  auto: true,
  mature: false,
  matureOnly: false,
  requiresIdentitySafety: false,
  substituteFor: null,
  operations: ['t2v', 'i2v', 'refs'],
  seconds: { min: 4, max: 12, allowed: null },
  defaultSeconds: 6,
  resolutions: ['480p', '720p', '1080p'],
  defaultResolution: '720p',
  ratios: ['21:9', '1:1', '9:16'],
  audio: true,
  lipSync: false,
  limits: { referenceImages: 4, referenceVideos: 1, referenceAudios: 0, inputImages: 1, imagesPerRequest: 1 },
  credits: [] as Point[],
  ...o,
});

export const CATALOG = [
  // The default video model: Auto starts from it.
  model({ id: 'acme/reel-2', kind: 'video', name: 'Reel Two', default: true, seconds: { min: 4, max: 12, allowed: [4, 8, 12] }, defaultSeconds: 8, ratios: ['21:9', '1:1', '9:16'] }),
  // No audio, other ratios and lengths.
  model({ id: 'acme/quiet-1', kind: 'video', name: 'Quiet One', audio: false, ratios: ['4:3'], resolutions: ['480p', '720p'], seconds: { min: 5, max: 10, allowed: null }, defaultSeconds: 5 }),
  // Text-only: not offered in Remix (no reference or first-frame input).
  model({ id: 'acme/text-only', kind: 'video', name: 'Text Only', operations: ['t2v'] }),
  // Tool-only and hidden models never show (D-009).
  model({ id: 'acme/face-swap', kind: 'video', name: 'Face Swapper', placement: 'tool', operations: ['face_swap'] }),
  model({ id: 'acme/lips-1', kind: 'video', name: 'Lips One', lipSync: true, operations: ['lip_sync'], ratios: ['9:16'], resolutions: ['720p'], defaultResolution: '720p' }),
  model({ id: 'acme/still-3', kind: 'image', name: 'Still Three', default: true, operations: ['t2i', 'edit'], seconds: null, defaultSeconds: null, resolutions: ['1K', '2K', '4K'], defaultResolution: '2K', ratios: ['1:1', '3:4'], audio: false, limits: { referenceImages: 0, referenceVideos: 0, referenceAudios: 0, inputImages: 4, imagesPerRequest: 4 } }),
];

export const POSES = Array.from({ length: 30 }, (_, i) => ({
  id: `pw_pose_${i}`,
  category: 'pose',
  sub: null,
  title: `Pose number ${i + 1}`,
  promptEn: `standing pose ${i + 1}`,
  tags: [],
  assetId: `ast_pose_${i}`,
  license: 'FIRST_PARTY',
  source: 'https://posewear.pages.dev/',
  attribution: null,
  thumbUrl: null,
  depthUrl: null,
  angles: [],
}));
const OUTFITS = [{ ...POSES[0]!, id: 'pw_outfit_1', category: 'outfit', title: 'Linen suit', promptEn: 'a beige linen suit', assetId: 'ast_outfit_1' }];

export interface Calls {
  quotes: Array<{ promptSpec: Record<string, unknown> }>;
  runs: unknown[];
  library: Array<Record<string, unknown>>;
}

export const ME = {
  user: { id: 'usr_e2e', email: 'e2e@example.com', name: 'Robin', image: null, emailVerified: true },
  workspace: { id: 'ws_e2e', name: 'Personal', kind: 'personal', matureAllowed: false },
  role: 'owner',
  monthlyCreditLimit: null,
  workspaces: [{ id: 'ws_e2e', name: 'Personal', kind: 'personal', role: 'owner', plan: 'starter' }],
  prefs: { language: 'en', currency: 'USD', creationMode: 'simple', defaultRatio: '9:16', defaultModel: 'auto', confirmThreshold: 300, notifications: { done: true, low: true, renewal: true, product: true }, theme: 'dark', matureContent: false },
  plan: { id: 'starter', label: 'Starter', interval: 'month', status: 'active', currentPeriodEnd: 1_900_000_000_000, cancelAtPeriodEnd: false, perks: { monthlyCredits: 200, topUpBonus: 0, concurrentJobs: 2, maxVideoResolution: '720p', maxImageResolution: '2K', voiceCloning: false, seats: 1 } },
  isMember: true,
  matureAllowed: false,
  balance: { plan: 200, purchased: 0, held: 0, planExpiresAt: 1_900_000_000_000 },
};

const quote = (spec: Record<string, unknown>) => ({
  quoteId: 'qt_e2e',
  items: [{ ref: 'run', title: String(spec.title ?? 'Run'), kind: spec.kind === 'character' ? 'image' : 'video', action: 'run', model: 'acme/reel-2', modelName: 'Reel Two', credits: 137 }],
  total: 137,
  balance: 200,
  balanceAfter: 63,
  expiresAt: Date.now() + 600_000,
  confirmThreshold: 300,
  needsConfirm: false,
});

/** Stubs every `/api` call the tool pages make; returns the recorded quote and library requests. */
export async function stubApi(page: Page, context: BrowserContext, opts: { creationMode?: 'simple' | 'advanced' } = {}): Promise<Calls> {
  const calls: Calls = { quotes: [], runs: [], library: [] };
  const me = { ...ME, prefs: { ...ME.prefs, creationMode: opts.creationMode ?? 'simple' } };
  await page.addInitScript((mode) => {
    try {
      window.localStorage.setItem('rolling.creationMode', mode);
    } catch {
      /* ignore */
    }
  }, opts.creationMode ?? 'simple');
  // The upload engine runs in a SharedWorker: with no API answering /api/health on localhost it serves uploads from its dev mock (D-011).
  await context.route('**/api/health', (route) => route.fulfill({ status: 503, json: { ok: false } }));
  await page.routeWebSocket(/\/api\//, () => undefined);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    if (path === '/health') return route.fulfill({ status: 503, json: { ok: false } });
    if (path === '/me') return route.fulfill({ json: me });
    if (path === '/models') {
      const kind = url.searchParams.get('kind');
      return route.fulfill({ json: { models: kind ? CATALOG.filter((m) => m.kind === kind) : CATALOG } });
    }
    if (path === '/graphql') {
      const body = req.postDataJSON() as { query: string; variables?: Record<string, unknown> };
      const v = body.variables ?? {};
      if (body.query.includes('publicCategories')) return route.fulfill({ json: { data: { publicCategories: [{ key: 'pose', count: 30 }, { key: 'outfit', count: 1 }] } } });
      if (body.query.includes('publicItems')) {
        calls.library.push(v);
        const all = v.category === 'pose' ? POSES : v.category === 'outfit' ? OUTFITS : [];
        const q = typeof v.q === 'string' ? v.q.toLowerCase() : '';
        const list = all.filter((n) => !q || n.title.toLowerCase().includes(q));
        const after = typeof v.after === 'string' ? Number(v.after) : 0;
        const first = Number(v.first ?? 24);
        const page2 = list.slice(after, after + first);
        const end = after + page2.length;
        return route.fulfill({ json: { data: { publicItems: { edges: page2.map((node) => ({ cursor: node.id, node })), pageInfo: { hasNextPage: end < list.length, endCursor: end < list.length ? String(end) : null } } } } });
      }
      return route.fulfill({ json: { data: {} } });
    }
    if (path === '/runs/quote' && method === 'POST') {
      const body = req.postDataJSON() as { promptSpec: Record<string, unknown> };
      calls.quotes.push(body);
      return route.fulfill({ json: quote(body.promptSpec) });
    }
    if (path === '/runs' && method === 'POST') {
      calls.runs.push(req.postDataJSON());
      return route.fulfill({ json: { runId: 'run_e2e', status: 'queued' } });
    }
    if (path === '/runs' && method === 'GET') return route.fulfill({ json: { stats: { usedThisMonth: 0, usedLastMonth: 0, running: 0, successRate: null, runsLast7Days: 0, refundedThisMonth: 0 }, runs: [], nextCursor: null } });
    if (path.startsWith('/runs/run_e2e')) return route.fulfill({ json: { run: { id: 'run_e2e', ref: 'r', name: 'x', source: 'quickCreate', projectId: null, projectTitle: null, params: '', status: 'running', progress: 0.1, credits: 137, quoted: 137, spent: 0, refunded: 0, error: null, createdAt: Date.now(), finishedAt: null, items: [] } } });
    if (path === '/templates') return route.fulfill({ json: { featured: [], items: [], total: 0 } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'stub', data: null } } });
  });
  return calls;
}

/** Copy from the approved designs and mock data that must never render in real mode. */
export const DEMO_LITERALS = [
  'Table demo',
  'Smart casual',
  'Daylight studio',
  'Slow push-in. Character 1',
  'Lead template v3',
  'Sporty',
  'Seedance 2.5',
  'Seedance 2.0 Mini',
  'Wan 2.2',
  'Two-person product demo',
  'Here is what I use every morning',
  'Shot 2 · Lighting',
  'Product advisor',
  'Office · Uploaded',
  'Clear female',
  'My voice 01',
  'Messy desk',
  'Max 15s on this model',
  '2480',
];
