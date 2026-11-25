import { PLANS, type PlanId } from '@rolling/core/pricing/config';
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
 */

export type BillingPeriod = 'monthly' | 'yearly';

export interface SessionPlan {
  id: PlanId;
  period: BillingPeriod;
  status: 'active' | 'canceled';
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
}

export interface SessionMockOverrides {
  plan?: SessionPlan | null;
  workspace?: { matureAllowed?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __rollingMocks?: { me?: SessionMockOverrides };
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
  return { plan, planId: isMember ? plan!.id : null, isMember, matureAllowed: isMember && workspaceMatureAllowed, workspaceMatureAllowed };
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

/**
 * Checkout (`POST /api/billing/checkout`) — the mock completes at once and
 * makes the workspace a member of `planId`.
 */
export async function checkoutPlan(planId: string, period: BillingPeriod = 'monthly'): Promise<Session> {
  const id = (Object.keys(PLANS) as PlanId[]).includes(planId as PlanId) ? (planId as PlanId) : DEFAULT_PLAN.id;
  const cur = getSession();
  set(derive({ id, period, status: 'active' }, cur.workspaceMatureAllowed));
  return getSession();
}

/** Test helper: forget the cached session so the next read re-applies the seams. */
export function resetSessionForTests() {
  state = null;
}
