import { planMonthlyCredits, PLANS, prorate, SEAT_PRICE, TEAM_SEATS, type PlanId } from '@rolling/core/pricing/config';
import { ApiError, type ApiErrorCode } from '@/lib/api/errors';
import { topUpFor } from '@/lib/topUp';
import { derive, getCredits, getSession, setCredits, setSession, type BillingPeriod, type CreditsBreakdown, type Session, type SessionPlan } from './store';

/**
 * Mock session (`VITE_API_MODE=mock`: Playwright fidelity and flow specs, unit
 * tests). Defaults to an active Pro member, as the screens are drawn. Test
 * seams, all read here:
 * - `window.__rollingMocks.me` (set before the app loads): `{ plan: null }`
 *   for a workspace without a plan, `{ plan: { id: 'starter', ... } }` for
 *   another plan, `{ workspace: { matureAllowed: false } }`;
 * - `?member=0` in the URL at load: signed up, no plan;
 * - localStorage `rolling.mock.isMember` = `false`: same.
 *
 * Team (D-013): `plan: { id: 'team', seats: 5, ... }` for a Team workspace.
 */

export interface SessionMockOverrides {
  plan?: SessionPlan | null;
  workspace?: { matureAllowed?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

/** How the mock checkout and mock runs end: `ok` (default), `fail` (payment or run error). */
export type MockOutcome = 'ok' | 'fail';

declare global {
  interface Window {
    __rollingMocks?: {
      me?: SessionMockOverrides;
      /** Starting balance for `useCredits` (default 2,480: 1,800 plan + 680 purchased). */
      credits?: Partial<CreditsBreakdown>;
      checkout?: MockOutcome;
      run?: MockOutcome;
      /** Mock latency in ms for checkout and runs (default 600). */
      latencyMs?: number;
    };
  }
}

export const MOCK_MEMBER_KEY = 'rolling.mock.isMember';
export const DEFAULT_PLAN: SessionPlan = { id: 'pro', period: 'monthly', status: 'active' };

/** The mock identity (Settings.dc.html, Main.dc.html). */
export const MOCK_USER = { id: 'usr_alex', email: 'alex@ridgeline.co', name: 'Alex Chen', image: null };
export const MOCK_WORKSPACES = [
  { id: 'ws_personal', name: 'Personal', kind: 'personal' as const, role: 'owner' as const, plan: null },
  { id: 'ws_ridgeline', name: 'Ridgeline brand team', kind: 'team' as const, role: 'owner' as const, plan: 'pro' as PlanId },
];

/** Error the session flows reject with; `code` follows docs/api.md error codes (also thrown, wrapped, by the real API path). */
export class FlowError extends ApiError {
  constructor(code: ApiErrorCode, message: string = code, status = 0, data: Record<string, unknown> = {}) {
    super(code, message, status, data as never);
  }
}

/** Older name, kept for callers that check `instanceof MockFlowError`. */
export const MockFlowError = FlowError;
export type MockFlowError = FlowError;

/** The test seam `window.__rollingMocks.me`, if set. */
export function mockOverrides(): SessionMockOverrides {
  return (typeof window !== 'undefined' && window.__rollingMocks?.me) || {};
}

function guestFlag(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('member') === '0') return true;
  try {
    return window.localStorage.getItem(MOCK_MEMBER_KEY) === 'false';
  } catch {
    return false;
  }
}

function mocks() {
  return (typeof window !== 'undefined' && window.__rollingMocks) || {};
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const latency = () => mocks().latencyMs ?? 600;

export function mockIdentity(workspaceId: string = getMockWorkspace(MOCK_WORKSPACES[0]!.id)): Pick<Session, 'user' | 'workspace' | 'workspaces' | 'role' | 'status'> {
  const ws = MOCK_WORKSPACES.find((w) => w.id === workspaceId) ?? MOCK_WORKSPACES[0]!;
  return {
    status: 'signedIn',
    user: MOCK_USER,
    workspace: { id: ws.id, name: ws.name, kind: ws.kind, matureAllowed: mockOverrides().workspace?.matureAllowed ?? true },
    workspaces: MOCK_WORKSPACES,
    role: 'owner',
  };
}

export function initialMockSession(): Session {
  const o = mockOverrides();
  const plan = guestFlag() ? null : o.plan === undefined ? DEFAULT_PLAN : o.plan;
  return derive(plan, o.workspace?.matureAllowed ?? true, mockIdentity());
}

const DEFAULT_CREDITS: CreditsBreakdown = {
  available: 2480,
  plan: 1800,
  planExpires: new Date(2026, 10, 30),
  purchased: 680,
  usedThisMonth: 1284,
  held: 16,
  expiringThisMonth: 300,
};

export function initialMockCredits(): CreditsBreakdown {
  return { ...DEFAULT_CREDITS, ...mocks().credits };
}

function keepIdentity(cur: Session): Parameters<typeof derive>[2] {
  return { status: cur.status, user: cur.user, workspace: cur.workspace, workspaces: cur.workspaces, role: cur.role, monthlyCreditLimit: cur.monthlyCreditLimit };
}

export function clampSeats(n: number): number {
  return Math.min(TEAM_SEATS.max, Math.max(TEAM_SEATS.min, Math.round(Number.isFinite(n) ? n : 1)));
}

export async function mockCheckoutPlan(planId: string, period: BillingPeriod = 'monthly', seats = 1): Promise<Session> {
  const id = (Object.keys(PLANS) as PlanId[]).includes(planId as PlanId) ? (planId as PlanId) : DEFAULT_PLAN.id;
  const n = id === 'team' ? clampSeats(seats) : 1;
  await wait(latency());
  if (mocks().checkout === 'fail') throw new FlowError('PAYMENT_FAILED');
  const cur = getSession();
  const wasMember = cur.isMember;
  const toTeam = id === 'team' && cur.planId !== 'team';
  setSession(derive({ id, period, status: 'active', ...(id === 'team' ? { seats: n } : {}) }, cur.workspaceMatureAllowed, keepIdentity(cur)));
  // A new member gets the plan's credits; a switch to Team (D-013) is granted by its paid invoice.
  if (!wasMember || toTeam) {
    const c = getCredits();
    const grant = planMonthlyCredits(id, n);
    const plan = wasMember ? grant : c.plan + grant;
    setCredits({ ...c, plan, available: plan + c.purchased });
  }
  return getSession();
}

/** Mock billing period for prorations: the current calendar month. */
export function mockPeriod(now = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}

export interface SeatChange {
  seats: number;
  previous: number;
  /** Prorated plan credits granted for added seats (D-013). */
  granted: number;
}

let seatHighWater: number | null = null;

export async function mockChangeSeats(seats: number, used: number): Promise<SeatChange> {
  const cur = getSession();
  if (!cur.isTeam || !cur.plan) throw new FlowError('TEAM_REQUIRED');
  const n = clampSeats(seats);
  if (n < used) throw new FlowError('SEATS_IN_USE');
  await wait(latency());
  const previous = cur.seats;
  if (n > previous && mocks().checkout === 'fail') throw new FlowError('PAYMENT_FAILED');
  const high = seatHighWater ?? previous;
  let granted = 0;
  if (n > high) {
    const p = mockPeriod();
    granted = prorate((n - high) * SEAT_PRICE.monthlyCredits, p.start, p.end, Date.now());
    seatHighWater = n;
    const c = getCredits();
    setCredits({ ...c, plan: c.plan + granted, available: c.available + granted });
  } else if (seatHighWater === null) seatHighWater = previous;
  setSession(derive({ ...cur.plan, seats: n }, cur.workspaceMatureAllowed, keepIdentity(cur)));
  return { seats: n, previous, granted };
}

export interface TopUpResult {
  amountUsd: number;
  /** Credits added, bonus included. */
  credits: number;
  balance: number;
}

export async function mockCheckoutTopUp(amountUsd: number): Promise<TopUpResult> {
  const session = getSession();
  if (!session.isMember) throw new FlowError('NO_PLAN');
  await wait(latency());
  if (mocks().checkout === 'fail') throw new FlowError('PAYMENT_FAILED');
  const q = topUpFor(amountUsd, session.planId);
  const c = getCredits();
  setCredits({ ...c, purchased: c.purchased + q.credits, available: c.available + q.credits });
  return { amountUsd, credits: q.credits, balance: getCredits().available };
}

export interface MockRun {
  id: string;
  cost: number;
}

let runSeq = 0;

/**
 * A paid run (`POST /api/runs`): quote → hold → settle, or release on failure
 * (refunded). Members only. Resolves when the mock job finishes. Mock only:
 * the real run flow lives with the creation features.
 */
export async function startMockRun(cost: number): Promise<MockRun> {
  const session = getSession();
  if (!session.isMember) throw new FlowError('NO_PLAN');
  const c = getCredits();
  if (c.available < cost) throw new FlowError('INSUFFICIENT_CREDITS');
  runSeq += 1;
  const id = `run_mock${String(runSeq).padStart(4, '0')}`;
  setCredits({ ...c, available: c.available - cost, held: c.held + cost });
  await wait(latency());
  const now = getCredits();
  if (mocks().run === 'fail') {
    setCredits({ ...now, available: now.available + cost, held: Math.max(0, now.held - cost) });
    throw new FlowError('RUN_FAILED');
  }
  // Plan credits are used first, then purchased (shell.credits.note).
  const fromPlan = Math.min(now.plan, cost);
  setCredits({
    ...now,
    held: Math.max(0, now.held - cost),
    plan: now.plan - fromPlan,
    purchased: now.purchased - (cost - fromPlan),
    usedThisMonth: now.usedThisMonth + cost,
  });
  return { id, cost };
}

// Workspace switch (account menu).

export const ACTIVE_WORKSPACE_KEY = 'rolling.mock.workspace';
const workspaceListeners = new Set<() => void>();

export function getMockWorkspace(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setMockWorkspace(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    /* Storage unavailable. */
  }
  for (const l of workspaceListeners) l();
}

export function subscribeMockWorkspace(cb: () => void): () => void {
  workspaceListeners.add(cb);
  return () => workspaceListeners.delete(cb);
}

export function resetMockForTests() {
  seatHighWater = null;
}
