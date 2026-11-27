import type { AdminMe, AuditRow, CaseItem, CaseView, Dashboard, OpsStatus, SearchResult, UserDetail, WorkspaceDetail } from './types';

/**
 * Admin console mock data (mock mode only, through `mockData().admin`). Seams:
 * `window.__rollingMocks.admin = { staff: false }` (not staff → not found),
 * `{ role: 'reviewer' }` (no money, ops or child-safety).
 */
const DAY = 86_400_000;

function seam(): { staff?: boolean; role?: 'admin' | 'reviewer' } {
  return (typeof window !== 'undefined' && (window as unknown as { __rollingMocks?: { admin?: { staff?: boolean; role?: 'admin' | 'reviewer' } } }).__rollingMocks?.admin) || {};
}

export function mockMe(): AdminMe | null {
  const s = seam();
  if (s.staff === false) return null;
  const role = s.role ?? 'admin';
  return { role, email: 'owner@example.com', permissions: role === 'admin' ? ['view', 'review', 'credits', 'plans', 'ops', 'staff', 'child_safety'] : ['view', 'review'] };
}

export function mockDashboard(days: number): Dashboard {
  const now = Date.UTC(2026, 10, 27);
  const list = Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10));
  const daily = list.map((day, i) => {
    const started = 40 + ((i * 17) % 30);
    const failed = 2 + (i % 4);
    return { day, signups: 12 + ((i * 7) % 15), planStarts: 2 + (i % 5), started, succeeded: started - failed, failed, agentTurns: 80 + ((i * 13) % 50), creditsSpent: 9000 + ((i * 731) % 4000), gatewayCostUsd: 28 + ((i * 3) % 12), agentCostUsd: 1.2 + (i % 3) * 0.4 };
  });
  const sum = (k: keyof (typeof daily)[number]) => daily.reduce((s, d) => s + Number(d[k]), 0);
  const revenueUsd = Math.round(sum('creditsSpent')) / 100;
  const cost = sum('gatewayCostUsd') + sum('agentCostUsd');
  return {
    days: list,
    daily,
    models: [
      { model: 'bytedance/seedance-2.5', started: 820, succeeded: 790, failed: 30, successRate: 790 / 820, creditsSpent: 182000, gatewayCostUsd: 590.4, p50Ms: 72_000, p90Ms: 140_000 },
      { model: 'bytedance/seedream-5.0-lite', started: 640, succeeded: 636, failed: 4, successRate: 636 / 640, creditsSpent: 7040, gatewayCostUsd: 22.1, p50Ms: 6_100, p90Ms: 11_800 },
      { model: 'lumina/wan2.7-i2v-spicy', started: 120, succeeded: 104, failed: 16, successRate: 104 / 120, creditsSpent: 21000, gatewayCostUsd: 70.2, p50Ms: 95_000, p90Ms: 210_000 },
    ],
    totals: { signups: sum('signups'), planStarts: sum('planStarts'), trialsActive: 0, activePlans: 214, creditsSpent: sum('creditsSpent'), gatewayCostUsd: Math.round(sum('gatewayCostUsd') * 100) / 100, agentCostUsd: Math.round(sum('agentCostUsd') * 100) / 100, revenueUsd, marginUsd: Math.round((revenueUsd - cost) * 100) / 100, marginPct: (revenueUsd - cost) / revenueUsd },
    latency: { available: true, reason: null, colos: [{ colo: 'SJC', requests: 41200, p50Ms: 38, p90Ms: 120 }, { colo: 'NRT', requests: 28800, p50Ms: 55, p90Ms: 190 }, { colo: 'FRA', requests: 9100, p50Ms: 61, p90Ms: 230 }] },
  };
}

export function mockSearch(q: string): SearchResult {
  const all: SearchResult = {
    users: [
      { id: 'usr_01ALEX', email: 'alex@example.com', name: 'Alex Chen', created_at: '2026-11-02T10:00:00.000Z' },
      { id: 'usr_01MIRA', email: 'mira@example.com', name: 'Mira Sato', created_at: '2026-11-12T10:00:00.000Z' },
    ],
    workspaces: [
      { id: 'ws_p_alex', name: 'Personal', kind: 'personal', safety_flag: 0, created_at: Date.UTC(2026, 10, 2) },
      { id: 'ws_team_north', name: 'North Studio', kind: 'team', safety_flag: 1, created_at: Date.UTC(2026, 10, 5) },
    ],
  };
  const t = q.toLowerCase();
  return { users: all.users.filter((u) => `${u.email} ${u.name} ${u.id}`.toLowerCase().includes(t)), workspaces: all.workspaces.filter((w) => `${w.name} ${w.id}`.toLowerCase().includes(t)) };
}

const state = { purchased: 680, refunded: new Set<string>(), suspended: false, cases: new Map<string, CaseItem['status']>(), incident: null as null | { message: string; level: 'info' | 'degraded' | 'outage' } };

export function mockWorkspace(id: string): WorkspaceDetail {
  const now = Date.UTC(2026, 10, 27, 12);
  return {
    workspace: { id, name: id === 'ws_team_north' ? 'North Studio' : 'Personal', kind: id === 'ws_team_north' ? 'team' : 'personal', safety_flag: id === 'ws_team_north' ? 1 : 0, created_at: Date.UTC(2026, 10, 2) },
    members: [{ user_id: 'usr_01ALEX', role: 'owner', email: 'alex@example.com', name: 'Alex Chen' }],
    subscriptions: [{ id: 'sub_1', plan: 'plus', status: 'active', current_period_end: now + 20 * DAY, seats: 1 }],
    plan: 'plus',
    balance: { plan: 1800, purchased: state.purchased, held: 0 },
    ledger: [
      { id: 'led_3', kind: 'settle', bucket: 'plan', amount: -347, runId: 'run_01A', jobId: 'job_01A', note: null, createdAt: now - 3_600_000 },
      { id: 'led_2', kind: 'hold', bucket: 'plan', amount: -347, runId: 'run_01A', jobId: 'job_01A', note: null, createdAt: now - 3_700_000 },
      { id: 'led_1', kind: 'grant', bucket: 'plan', amount: 2147, runId: null, jobId: null, note: 'plus:month', createdAt: now - 6 * DAY },
    ],
    runs: [
      { id: 'run_01A', title: 'Ridgeline Sparkling, 15s', status: 'succeeded', credits_spent: 347, credits_refunded: state.refunded.has('run_01A') ? 347 : 0, created_at: now - 3_600_000 },
      { id: 'run_01B', title: 'Cap close-up', status: 'failed', credits_spent: 0, credits_refunded: 11, created_at: now - 7_200_000 },
    ],
    safetyEvents: id === 'ws_team_north' ? [{ id: 'sev_1', stage: 'pre', codes: ['EXTREME_VIOLENCE'], hard: 1, created_at: now - DAY }] : [],
    suspensions: state.suspended ? [{ id: 'sus_1', reason: 'Fraud review', created_at: now, lifted_at: null }] : [],
    cases: [],
  };
}

export function mockUser(id: string): UserDetail {
  return {
    user: { id, email: 'alex@example.com', name: 'Alex Chen', created_at: '2026-11-02T10:00:00.000Z' },
    memberships: [{ workspace_id: 'ws_p_alex', role: 'owner', name: 'Personal', kind: 'personal', plan: 'plus' }],
    suspensions: state.suspended ? [{ id: 'sus_1', reason: 'Fraud review', created_at: Date.now(), lifted_at: null }] : [],
    notices: [],
    safetyEvents: [],
    cases: [],
  };
}

export function mockAdjust(amount: number) {
  state.purchased = Math.max(0, state.purchased + amount);
  return { amount, balance: { plan: 1800, purchased: state.purchased, held: 0 }, auditId: 'aud_mock' };
}

export function mockRefund(runId: string) {
  state.refunded.add(runId);
  return { runId, total: 347, refunded: [{ jobId: 'job_01A', credits: 347 }], skipped: [], auditId: 'aud_mock' };
}

export function mockSuspend(action: 'suspend' | 'unsuspend') {
  state.suspended = action === 'suspend';
  return { auditId: 'aud_mock' };
}

const BASE_CASES: CaseItem[] = [
  { id: 'case_cs1', kind: 'child_safety', status: 'open', priority: 2, category: 'child_safety', workspaceId: 'ws_team_north', userId: 'usr_01MIRA', targetKind: 'job', targetId: 'job_01X', resolution: null, createdAt: Date.UTC(2026, 10, 27, 9) },
  { id: 'case_rep1', kind: 'report', status: 'open', priority: 1, category: 'sexual_real_person', workspaceId: 'ws_p_alex', userId: 'usr_01ALEX', targetKind: 'share', targetId: 'shr_01RIDGE', resolution: null, createdAt: Date.UTC(2026, 10, 27, 8) },
  { id: 'case_saf1', kind: 'safety', status: 'open', priority: 1, category: 'hard_limit', workspaceId: 'ws_team_north', userId: 'usr_01MIRA', targetKind: null, targetId: null, resolution: null, createdAt: Date.UTC(2026, 10, 26, 22) },
  { id: 'case_app1', kind: 'appeal', status: 'open', priority: 0, category: 'block', workspaceId: 'ws_p_alex', userId: 'usr_01ALEX', targetKind: 'run', targetId: 'run_01B', resolution: null, createdAt: Date.UTC(2026, 10, 26, 18) },
  { id: 'case_dmca1', kind: 'dmca', status: 'open', priority: 0, category: 'copyright', workspaceId: 'ws_p_alex', userId: 'usr_01ALEX', targetKind: 'share', targetId: 'shr_01RIDGE', resolution: null, createdAt: Date.UTC(2026, 10, 26, 12) },
];

export function mockCases(role: 'admin' | 'reviewer'): { items: CaseItem[]; flaggedWorkspaces: number } {
  return {
    items: BASE_CASES.filter((c) => role === 'admin' || c.kind !== 'child_safety')
      .map((c) => ({ ...c, status: state.cases.get(c.id) ?? c.status }))
      .filter((c) => c.status === 'open'),
    flaggedWorkspaces: 1,
  };
}

const ACTIONS: Record<string, string[]> = {
  safety: ['dismiss', 'warn', 'suspend', 'escalate_child_safety', 'close'],
  report: ['dismiss', 'warn', 'suspend', 'delete_content', 'escalate_child_safety'],
  appeal: ['uphold', 'overturn'],
  dmca: ['takedown', 'dismiss'],
  child_safety: ['suspend', 'delete_content', 'mark_submitted', 'close'],
};

export function mockCase(id: string): CaseView | null {
  const c = BASE_CASES.find((x) => x.id === id);
  if (!c) return null;
  const status = state.cases.get(id) ?? c.status;
  const child = c.kind === 'child_safety';
  return {
    case: {
      ...c,
      status,
      details: child ? null : c.kind === 'report' ? 'This uses a real person’s face in an intimate scene.' : c.kind === 'appeal' ? 'The prompt was about a museum statue.' : null,
      reporterEmail: child ? null : 'reporter@example.com',
      targetUrl: c.targetKind === 'share' ? `https://rolling.actor/share/${c.targetId}` : null,
      data: child ? { submission: { status: 'pending' }, packet: { incident: { type: 'apparent_child_pornography', incidentDateTime: '2026-11-27T09:00:00.000Z', detection: 'Automated pre- or post-generation safety check (hard limit MINOR_SEXUAL) at stage post' }, reportedPerson: { espUserId: 'usr_01MIRA', email: 'mira@example.com' } } } : {},
    },
    user: { id: c.userId ?? '', email: c.userId === 'usr_01MIRA' ? 'mira@example.com' : 'alex@example.com', name: 'Name' },
    workspace: { id: c.workspaceId ?? '', name: 'North Studio', safety_flag: 1 },
    events: c.kind === 'safety' ? [{ id: 'sev_1', stage: 'pre', codes: ['EXTREME_VIOLENCE'], excerpt: 'graphic …', created_at: Date.UTC(2026, 10, 26, 22) }] : [],
    evidence: child ? [{ id: 'evi_1', kind: 'object', sha256: 'a3f1c9…', size: 482_113, contentType: 'image/png', capturedAt: Date.UTC(2026, 10, 27, 9) }, { id: 'evi_2', kind: 'text', sha256: '91be02…', size: 212, contentType: 'text/plain', capturedAt: Date.UTC(2026, 10, 27, 9) }] : [],
    history: [],
    actions: status === 'open' || child ? ACTIONS[c.kind] ?? [] : [],
  };
}

export function mockAct(id: string, action: string) {
  const resolved = action === 'dismiss' || action === 'uphold' ? 'dismissed' : action === 'close' ? 'closed' : 'actioned';
  state.cases.set(id, resolved);
  return { caseId: id, status: resolved, resolution: action, auditId: 'aud_mock' };
}

export function mockIncident(message: string, level: 'info' | 'degraded' | 'outage') {
  state.incident = message ? { message, level } : null;
  return { incident: state.incident ? { ...state.incident, updatedAt: Date.now() } : null };
}

export function mockOpsStatus(): OpsStatus {
  const now = Date.now();
  return {
    overall: 'operational' as const,
    components: (['api', 'gateway', 'media', 'auth'] as const).map((id) => ({ id, status: 'operational' as const, latencyMs: 40, checkedAt: now - 60_000, uptime24h: 1 })),
    generation: { available: true, breaker: 'closed' as const, since: null },
    incident: state.incident ? { ...state.incident, updatedAt: now } : null,
    updatedAt: now,
    breakerDetail: { state: 'closed', failures: 0, lastError: null },
    backups: [{ id: '2026-11-27', status: 'done', credit_accounts: 412, project_rooms: 1890, bytes: 48_211_000, started_at: now - 9 * 3_600_000, finished_at: now - 9 * 3_600_000 + 600_000 }],
  };
}

export function mockAudit(): { items: AuditRow[] } {
  return {
    items: [
      { id: 'aud_2', actor_kind: 'staff', actor_id: 'usr_owner', action: 'credits.grant', target_kind: 'workspace', target_id: 'ws_p_alex', reason: 'Goodwill for a slow week', created_at: Date.UTC(2026, 10, 27, 10) },
      { id: 'aud_1', actor_kind: 'token', actor_id: null, action: 'plan.comp_grant', target_kind: 'workspace', target_id: 'ws_team_north', reason: 'admin token grant', created_at: Date.UTC(2026, 10, 26, 10) },
    ],
  };
}
