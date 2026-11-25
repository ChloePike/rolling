import type { PlanId } from '@rolling/core/pricing/config';
import { useSyncExternalStore } from 'react';
import type { Role } from '@/lib/api/types';

/**
 * The session store: who is signed in and what the workspace may do, plus the
 * live credit balance. One sync store read by the header, Home, tools, canvas
 * and account pages (`useSession`, `useCredits`; `getSession`, `getCredits`
 * outside React). Real API: filled from `GET /api/me` (TanStack Query, see
 * `./real.ts`) and the user socket; mock mode: from `./mock.ts`.
 */

export type BillingPeriod = 'monthly' | 'yearly';

export interface SessionPlan {
  id: PlanId;
  period: BillingPeriod;
  status: 'active' | 'canceled';
  /** Purchased seats on Team (D-013); personal plans have 1. */
  seats?: number;
  label?: string;
  /** The plan ends at `currentPeriodEnd` (canceled in the portal, still active). */
  cancelAtPeriodEnd?: boolean;
  /** Epoch ms. */
  currentPeriodEnd?: number;
}

export interface SessionUser {
  id: string;
  email: string | null;
  name: string;
  image: string | null;
}

export interface SessionWorkspace {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: Role;
  plan: PlanId | null;
}

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

export interface Session {
  status: SessionStatus;
  user: SessionUser | null;
  /** The active workspace (the `x-workspace-id` the client sends). */
  workspace: { id: string; name: string; kind: 'personal' | 'team'; matureAllowed: boolean } | null;
  /** Every workspace the user belongs to, personal first (switcher). */
  workspaces: SessionWorkspace[];
  role: Role;
  /** The member's monthly credit limit in this workspace, null = none. */
  monthlyCreditLimit: number | null;
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

export interface CreditsBreakdown {
  /** Plan + purchased credits not held by running jobs. */
  available: number;
  plan: number;
  planExpires: Date;
  purchased: number;
  usedThisMonth: number;
  held: number;
  expiringThisMonth: number;
}

export function derive(
  plan: SessionPlan | null,
  workspaceMatureAllowed: boolean,
  rest: Partial<Pick<Session, 'status' | 'user' | 'workspace' | 'workspaces' | 'role' | 'monthlyCreditLimit'>> = {},
): Session {
  const isMember = plan?.status === 'active';
  const isTeam = isMember && plan!.id === 'team';
  const seats = isTeam ? Math.max(1, plan!.seats ?? 1) : 1;
  return {
    status: rest.status ?? 'signedIn',
    user: rest.user ?? null,
    workspace: rest.workspace ?? null,
    workspaces: rest.workspaces ?? [],
    role: rest.role ?? 'owner',
    monthlyCreditLimit: rest.monthlyCreditLimit ?? null,
    plan,
    planId: isMember ? plan!.id : null,
    isMember,
    matureAllowed: isMember && workspaceMatureAllowed,
    workspaceMatureAllowed,
    seats,
    isTeam,
  };
}

export const SIGNED_OUT: Session = derive(null, false, { status: 'signedOut', role: 'viewer' });
export const LOADING: Session = derive(null, false, { status: 'loading', role: 'viewer' });

export const ZERO_CREDITS: CreditsBreakdown = {
  available: 0,
  plan: 0,
  planExpires: new Date(0),
  purchased: 0,
  usedThisMonth: 0,
  held: 0,
  expiringThisMonth: 0,
};

let state: Session | null = null;
let initial: () => Session = () => LOADING;
const listeners = new Set<() => void>();

/** Mode setup: how the first read builds the session (mock seams, or loading until `/api/me`). */
export function setInitialSession(fn: () => Session) {
  initial = fn;
}

export function getSession(): Session {
  if (!state) state = initial();
  return state;
}

export function setSession(next: Session) {
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

let credits: CreditsBreakdown | null = null;
let initialCredits: () => CreditsBreakdown = () => ZERO_CREDITS;
const creditListeners = new Set<() => void>();

export function setInitialCredits(fn: () => CreditsBreakdown) {
  initialCredits = fn;
}

export function getCredits(): CreditsBreakdown {
  if (!credits) credits = initialCredits();
  return credits;
}

export function setCredits(next: CreditsBreakdown) {
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

/** Test helper: forget cached state so the next read re-applies the seams. */
export function resetStore() {
  state = null;
  credits = null;
}
