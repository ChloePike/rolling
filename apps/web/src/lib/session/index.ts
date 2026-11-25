import { planMonthlyCredits, PLANS, prorate, SEAT_PRICE, TEAM_SEATS, type PlanId } from '@rolling/core/pricing/config';
import { topUpFor } from '@/lib/topUp';
import { useSyncExternalStore } from 'react';

/**
 * Who is signed in and what their workspace may do: the one membership source
 * for the header, Home, tools, canvas and account pages (D-005, D-007).
 *
 * Mock until `GET /api/me` lands. Defaults to an active Pro member, as the
 * screens are drawn. Test seams, all read here:
 * - `window.__rollingMocks.me` (set before the app loads): `{ plan: null }`
 *   for a workspace without a plan, `{ plan: { id: 'starter', ... } }` for
 *   another plan, `{ workspace: { matureAllowed: false } }`;
 * - `?member=0` in the URL at load: signed up, no plan;
 * - localStorage `rolling.mock.isMember` = `false`: same.
 *
 * Team (D-013): `plan: { id: 'team', seats: 5, ... }` for a Team workspace;
 * `seats` is the purchased count (members incl. the owner), 1 on personal plans.
 */

export type BillingPeriod = 'monthly' | 'yearly';

export interface SessionPlan {
  id: PlanId;
  period: BillingPeriod;
  status: 'active' | 'canceled';
  /** Purchased seats on Team (D-013); personal plans have 1. */
  seats?: number;
}

export interface Session {
  /** Null when the workspace has no plan. */
  plan: SessionPlan | null;
  /** Id of the active plan, or null for non-members. */
  planId: PlanId | null;
  /** Active plan: may generate, use the agent and top up (D-007). */
  isMember: boolean;
  /** Mature content may be offered (D-005): an active plan and the workspace allows it. */
  matureAllowed: boolean;
  /** The workspace setting alone (`workspaces.matureAllowed`). */
  workspaceMatureAllowed: boolean;
  /** Purchased seats (D-013): Team's seat count, 1 otherwise. */
  seats: number;
  /** The workspace is on Team and may invite people. */
  isTeam: boolean;
}

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
const DEFAULT_PLAN: SessionPlan = { id: 'pro', period: 'monthly', status: 'active' };

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

function derive(plan: SessionPlan | null, workspaceMatureAllowed: boolean): Session {
  const isMember = plan?.status === 'active';
  const isTeam = isMember && plan!.id === 'team';
  const seats = isTeam ? Math.max(1, plan!.seats ?? 1) : 1;
  return { plan, planId: isMember ? plan!.id : null, isMember, matureAllowed: isMember && workspaceMatureAllowed, workspaceMatureAllowed, seats, isTeam };
}

let state: Session | null = null;
const listeners = new Set<() => void>();

export function getSession(): Session {
  if (!state) {
    const o = mockOverrides();
    const plan = guestFlag() ? null : o.plan === undefined ? DEFAULT_PLAN : o.plan;
    state = derive(plan, o.workspace?.matureAllowed ?? true);
  }
  return state;
}

function set(next: Session) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

function mocks() {
  return (typeof window !== 'undefined' && window.__rollingMocks) || {};
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const latency = () => mocks().latencyMs ?? 600;

/** Error a mock flow rejects with; `code` follows docs/api.md error codes. */
export class MockFlowError extends Error {
  constructor(public code: 'PAYMENT_FAILED' | 'NO_PLAN' | 'INSUFFICIENT_CREDITS' | 'RUN_FAILED' | 'TEAM_REQUIRED' | 'SEATS_IN_USE') {
    super(code);
  }
}

/**
 * Plan checkout (`POST /api/billing/checkout`, Stripe Checkout in M2). The mock
 * waits like a redirect round trip, then makes the workspace a member of
 * `planId` and grants the plan's monthly credits. Rejects with
 * `PAYMENT_FAILED` when `__rollingMocks.checkout` is `fail`.
 */
export async function checkoutPlan(planId: string, period: BillingPeriod = 'monthly', seats = 1): Promise<Session> {
  const id = (Object.keys(PLANS) as PlanId[]).includes(planId as PlanId) ? (planId as PlanId) : DEFAULT_PLAN.id;
  const n = id === 'team' ? clampSeats(seats) : 1;
  await wait(latency());
  if (mocks().checkout === 'fail') throw new MockFlowError('PAYMENT_FAILED');
  const cur = getSession();
  const wasMember = cur.isMember;
  const toTeam = id === 'team' && cur.planId !== 'team';
  set(derive({ id, period, status: 'active', ...(id === 'team' ? { seats: n } : {}) }, cur.workspaceMatureAllowed));
  // A new member gets the plan's credits; a switch to Team (D-013) is granted by its paid invoice.
  if (!wasMember || toTeam) {
    const c = getCredits();
    const grant = planMonthlyCredits(id, n);
    const plan = wasMember ? grant : c.plan + grant;
    setCredits({ ...c, plan, available: plan + c.purchased });
  }
  return getSession();
}

export function clampSeats(n: number): number {
  return Math.min(TEAM_SEATS.max, Math.max(TEAM_SEATS.min, Math.round(Number.isFinite(n) ? n : 1)));
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

/**
 * Team seats (`PATCH /api/billing/seats`, D-013). Increases are charged now
 * and grant the prorated share of 500 credits per added seat for the rest of
 * the month, once per month (removing and re-adding grants nothing new);
 * decreases apply now without a refund. `used` = members + pending invites:
 * lowering below it rejects with `SEATS_IN_USE`.
 */
export async function changeSeats(seats: number, used: number): Promise<SeatChange> {
  const cur = getSession();
  if (!cur.isTeam || !cur.plan) throw new MockFlowError('TEAM_REQUIRED');
  const n = clampSeats(seats);
  if (n < used) throw new MockFlowError('SEATS_IN_USE');
  await wait(latency());
  const previous = cur.seats;
  if (n > previous && mocks().checkout === 'fail') throw new MockFlowError('PAYMENT_FAILED');
  const high = seatHighWater ?? previous;
  let granted = 0;
  if (n > high) {
    const p = mockPeriod();
    granted = prorate((n - high) * SEAT_PRICE.monthlyCredits, p.start, p.end, Date.now());
    seatHighWater = n;
    const c = getCredits();
    setCredits({ ...c, plan: c.plan + granted, available: c.available + granted });
  } else if (seatHighWater === null) seatHighWater = previous;
  set(derive({ ...cur.plan, seats: n }, cur.workspaceMatureAllowed));
  return { seats: n, previous, granted };
}

// Credits (mock of `GET /api/credits` + the CreditAccount ledger). The real
// balance only changes in the CreditAccount Durable Object; this mirrors the
// states the UI will see over the user socket.

export interface CreditsBreakdown {
  available: number;
  plan: number;
  planExpires: Date;
  purchased: number;
  usedThisMonth: number;
  held: number;
  expiringThisMonth: number;
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

let credits: CreditsBreakdown | null = null;
const creditListeners = new Set<() => void>();

export function getCredits(): CreditsBreakdown {
  if (!credits) credits = { ...DEFAULT_CREDITS, ...mocks().credits };
  return credits;
}

function setCredits(next: CreditsBreakdown) {
  credits = next;
  for (const l of creditListeners) l();
}

function subscribeCredits(onChange: () => void): () => void {
  creditListeners.add(onChange);
  return () => creditListeners.delete(onChange);
}

/** Live credits (header button and popover, quotes, paywalls). */
export function useCredits(): CreditsBreakdown {
  return useSyncExternalStore(subscribeCredits, getCredits, getCredits);
}

export interface TopUpResult {
  amountUsd: number;
  /** Credits added, bonus included. */
  credits: number;
  balance: number;
}

/**
 * Top-up checkout (`POST /api/billing/topup` → Stripe Checkout in M2). Members
 * only (D-007). The mock waits, then adds the quoted credits (tier + plan bonus
 * from `quoteTopUp`) to purchased credits.
 */
export async function checkoutTopUp(amountUsd: number): Promise<TopUpResult> {
  const session = getSession();
  if (!session.isMember) throw new MockFlowError('NO_PLAN');
  await wait(latency());
  if (mocks().checkout === 'fail') throw new MockFlowError('PAYMENT_FAILED');
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
 * (refunded). Members only. Resolves when the mock job finishes.
 */
export async function startMockRun(cost: number): Promise<MockRun> {
  const session = getSession();
  if (!session.isMember) throw new MockFlowError('NO_PLAN');
  const c = getCredits();
  if (c.available < cost) throw new MockFlowError('INSUFFICIENT_CREDITS');
  runSeq += 1;
  const id = `run_mock${String(runSeq).padStart(4, '0')}`;
  setCredits({ ...c, available: c.available - cost, held: c.held + cost });
  await wait(latency());
  const now = getCredits();
  if (mocks().run === 'fail') {
    setCredits({ ...now, available: now.available + cost, held: Math.max(0, now.held - cost) });
    throw new MockFlowError('RUN_FAILED');
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

// Workspace switch (account menu) and sign-out.

export const ACTIVE_WORKSPACE_KEY = 'rolling.mock.workspace';
const workspaceListeners = new Set<() => void>();

export function getActiveWorkspace(fallback: string): string {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setActiveWorkspace(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    /* Storage unavailable. */
  }
  for (const l of workspaceListeners) l();
}

export function useActiveWorkspace(fallback: string): string {
  return useSyncExternalStore(
    (cb) => {
      workspaceListeners.add(cb);
      return () => workspaceListeners.delete(cb);
    },
    () => getActiveWorkspace(fallback),
    () => fallback,
  );
}

/** `POST /api/auth/sign-out`: the mock just forgets the cached session. */
export async function signOut(): Promise<void> {
  state = null;
}

/** Test helper: forget the cached session so the next read re-applies the seams. */
export function resetSessionForTests() {
  state = null;
  credits = null;
  seatHighWater = null;
}
