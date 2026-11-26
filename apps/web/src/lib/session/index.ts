import { useSyncExternalStore } from 'react';
import { isMockApi } from '@/lib/api/mode';
import { mockCheckoutRedirect, realChangeSeats, realCheckoutPlan, realCheckoutTopUp, type CheckoutOptions } from './checkout';
import { mockData } from '@/lib/api/mode';
import {
  clampSeats,
  FlowError,
  getMockWorkspace,
  mocks,
  setMockWorkspace,
  subscribeMockWorkspace,
  type MockRun,
  type SeatChange,
  type TopUpResult,
} from './seams';
import { realSignOut, realSwitchWorkspace, startRealSession } from './real';
import { derive, getCredits, getSession, resetStore, setInitialCredits, setInitialSession, setSession, useSession, type BillingPeriod, type Session } from './store';
import type { PlanId } from '@rolling/core/pricing/config';

/**
 * Who is signed in and what their workspace may do: the one membership source
 * for the header, Home, tools, canvas and account pages (D-005, D-007), plus
 * the live credit balance.
 *
 * Real API (default): `GET /api/me` via TanStack Query (`./real.ts`), the user
 * socket (`credits.changed`, `prefs.changed`, `agent.allowance`) and Stripe
 * Checkout redirects (`./checkout.ts`). `VITE_API_MODE=mock`: the mock flows
 * and test seams in `./mock.ts` (`window.__rollingMocks`).
 */

export * from './store';
export {
  clampSeats,
  FlowError,
  MOCK_MEMBER_KEY,
  MockFlowError,
  mockOverrides,
  mockPeriod,
  ACTIVE_WORKSPACE_KEY,
  type MockOutcome,
  type MockRun,
  type SeatChange,
  type SessionMockOverrides,
  type TopUpResult,
} from './seams';

/** The mock session flows (`./mock.ts`), through the mock-mode adapter only. */
const mockSession = () => mockData().session;

/**
 * Mock mode only: a paid run on the mock balance (quote → hold → settle, or
 * release on failure). The real run flow lives with the creation features.
 */
export function startMockRun(cost: number): Promise<MockRun> {
  return mockSession().startMockRun(cost);
}
export {
  currentReturnPath,
  emitCheckoutResume,
  onCheckoutResume,
  openBillingPortal,
  pollCheckout,
  redirectTo,
  startCheckout,
  startPortal,
  toInterval,
  RETURN_PARAMS,
  useCheckoutResume,
  type CheckoutOptions,
  type CheckoutResume,
} from './checkout';
export { bindPendingToCheckout, hasPendingAction, markCheckoutResumed, savePendingAction, takePendingAction, type PendingAction } from './pending';
export { ALLOWANCE_KEY, currentMe, ensureMe, ME_KEY, meQuery, refetchMe } from './real';

if (isMockApi()) {
  setInitialSession(() => mockSession().initialMockSession());
  setInitialCredits(() => mockSession().initialMockCredits());
} else if (typeof window !== 'undefined') {
  startRealSession();
}

/**
 * Plan checkout. Real: Stripe Checkout (the page leaves, so the promise never
 * settles; the return resumes through `onCheckoutResume`), or an in-place
 * switch to Team (resolves with the refreshed session). Mock: waits, then the
 * workspace becomes a member of `planId`. Rejects with a `FlowError`
 * (`PAYMENT_FAILED`, `SEATS_REQUIRED`, `CONFLICT`, ...).
 */
export async function checkoutPlan(planId: string, period: BillingPeriod = 'monthly', seats = 1, opts: CheckoutOptions = {}): Promise<Session> {
  if (isMockApi()) return mocks().checkoutRedirect ? mockCheckoutRedirect({ kind: 'plan', planId, period, seats }) : mockSession().mockCheckoutPlan(planId, period, seats);
  await realCheckoutPlan(planId as PlanId, period, planId === 'team' ? clampSeats(seats) : 1, opts);
  return getSession();
}

/** Top-up checkout (members only, D-007). Real: Stripe Checkout (never settles). Mock: adds the quoted credits. */
export async function checkoutTopUp(amountUsd: number, opts: CheckoutOptions = {}): Promise<TopUpResult> {
  if (isMockApi()) {
    if (mocks().checkoutRedirect) {
      if (!getSession().isMember) throw new FlowError('NO_PLAN');
      return mockCheckoutRedirect({ kind: 'topUp', amountUsd });
    }
    return mockSession().mockCheckoutTopUp(amountUsd);
  }
  if (!getSession().isMember) throw new FlowError('NO_PLAN');
  return realCheckoutTopUp(amountUsd, opts);
}

/**
 * Team seats (`PATCH /api/billing/seats`, D-013). Increases are charged now
 * and grant the prorated plan credits of the added seats; decreases apply now
 * without a refund. `used` = members + pending invites (mock check only; the
 * server answers `SEATS_IN_USE`).
 */
export async function changeSeats(seats: number, used: number): Promise<SeatChange> {
  if (isMockApi()) return mockSession().mockChangeSeats(seats, used);
  const previous = getSession().seats;
  const r = await realChangeSeats(clampSeats(seats));
  return { seats: r.seats.purchased, previous, granted: r.granted };
}

// Workspace switch (account menu) and sign-out.

export function getActiveWorkspace(fallback: string): string {
  if (isMockApi()) return getMockWorkspace(fallback);
  return getSession().workspace?.id ?? fallback;
}

/** Switches the active workspace: real API sets `x-workspace-id` and refetches; mock remembers it. */
export function setActiveWorkspace(id: string) {
  if (isMockApi()) {
    setMockWorkspace(id);
    const cur = getSession();
    setSession(derive(cur.plan, cur.workspaceMatureAllowed, { ...mockSession().mockIdentity(id), monthlyCreditLimit: cur.monthlyCreditLimit }));
    return;
  }
  void realSwitchWorkspace(id);
}

export function useActiveWorkspace(fallback: string): string {
  const session = useSession();
  const mock = useSyncExternalStore(
    subscribeMockWorkspace,
    () => (isMockApi() ? getMockWorkspace(fallback) : fallback),
    () => fallback,
  );
  return isMockApi() ? mock : (session.workspace?.id ?? fallback);
}

/** `POST /api/auth/logout` (real) and forget the cached session. */
export async function signOut(): Promise<void> {
  if (isMockApi()) {
    resetStore();
    return;
  }
  await realSignOut();
}

/** Test helper: forget the cached session so the next read re-applies the seams. */
export function resetSessionForTests() {
  resetStore();
  if (isMockApi()) mockSession().resetMockForTests();
}

