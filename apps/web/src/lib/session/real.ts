import { queryOptions } from '@tanstack/react-query';
import { api, getWorkspaceId, setWorkspaceId } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { queryClient } from '@/lib/api/queryClient';
import type { AllowanceView, BalanceView, MeResponse } from '@/lib/api/types';
import { applyServerPrefs, registerPrefsRemote, toServerPatch, type ServerPrefsShape } from '@/lib/prefs';
import { userSocket } from '@/lib/realtime/client';
import { derive, getCredits, LOADING, setCredits, setSession, SIGNED_OUT, ZERO_CREDITS, type CreditsBreakdown, type Session } from './store';

/**
 * Real session: `GET /api/me` through TanStack Query (`meQuery`), mirrored into
 * the session store on every cache change (fetch, socket update, mutation).
 * While signed in it also owns the user socket and routes preference writes to
 * `PATCH /api/me/prefs`.
 */

export const ME_KEY = ['session', 'me'] as const;
export const ALLOWANCE_KEY = ['agent', 'allowance'] as const;

/** `null` = signed out. A stale workspace id (removed from a team) falls back to the personal workspace. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api.get<MeResponse>('/me');
  } catch (e) {
    if (isApiError(e, 'UNAUTHENTICATED')) return null;
    if ((isApiError(e, 'FORBIDDEN') || isApiError(e, 'BAD_REQUEST')) && getWorkspaceId()) {
      setWorkspaceId(null);
      return fetchMe();
    }
    throw e;
  }
}

export const meQuery = () =>
  queryOptions({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

export function sessionFromMe(me: MeResponse): Session {
  const p = me.plan;
  const ws = me.workspaces.find((w) => w.id === me.workspace.id);
  const planId = p?.id ?? (me.isMember ? (ws?.plan ?? null) : null);
  const plan = planId
    ? {
        id: planId,
        period: p?.interval === 'year' ? ('yearly' as const) : ('monthly' as const),
        status: 'active' as const,
        seats: p?.perks.seats ?? 1,
        label: p?.label,
        cancelAtPeriodEnd: p?.cancelAtPeriodEnd ?? false,
        currentPeriodEnd: p?.currentPeriodEnd,
      }
    : null;
  return derive(me.isMember ? plan : null, me.workspace.matureAllowed, {
    status: 'signedIn',
    user: { id: me.user.id, email: me.user.email, name: me.user.name, image: me.user.image, handle: me.user.handle ?? null },
    workspace: me.workspace,
    workspaces: me.workspaces,
    role: me.role,
    monthlyCreditLimit: me.monthlyCreditLimit,
  });
}

export function creditsFromBalance(b: BalanceView, me: MeResponse | null, prev: CreditsBreakdown = ZERO_CREDITS): CreditsBreakdown {
  const expiresAt = b.planExpiresAt ?? me?.plan?.currentPeriodEnd ?? null;
  return {
    available: b.plan + b.purchased,
    plan: b.plan,
    purchased: b.purchased,
    held: b.held,
    planExpires: expiresAt ? new Date(expiresAt) : new Date(0),
    // Plan credits expire at the period end (D-006); purchased never do.
    expiringThisMonth: b.plan,
    usedThisMonth: prev.usedThisMonth,
  };
}

let current: MeResponse | null | undefined;

function applyMe(me: MeResponse | null) {
  const was = current;
  current = me;
  if (!me) {
    setSession(SIGNED_OUT);
    setCredits(ZERO_CREDITS);
    registerPrefsRemote(null);
    userSocket.stop();
    return;
  }
  setSession(sessionFromMe(me));
  setCredits(creditsFromBalance(me.balance, me, getCredits()));
  applyServerPrefs(me.prefs as ServerPrefsShape);
  registerPrefsRemote(savePrefsRemote);
  if (!was || was.user.id !== me.user.id) userSocket.reconnect();
}

async function savePrefsRemote(patch: Parameters<typeof toServerPatch>[0]): Promise<void> {
  const body = toServerPatch(patch);
  if (!Object.keys(body).length) return;
  const r = await api.patch<{ prefs: MeResponse['prefs']; matureAllowed: boolean }>('/me/prefs', body);
  queryClient.setQueryData<MeResponse | null>(ME_KEY, (m) => (m ? { ...m, prefs: r.prefs, matureAllowed: r.matureAllowed } : m));
}

/** The latest `/api/me` body (signed in), else null. */
export function currentMe(): MeResponse | null {
  return current ?? null;
}

function updateMe(fn: (m: MeResponse) => MeResponse) {
  queryClient.setQueryData<MeResponse | null>(ME_KEY, (m) => (m ? fn(m) : m));
}

let started = false;

/** Wires the cache mirror and the user socket handlers (once, real API only). */
export function startRealSession() {
  if (started) return;
  started = true;
  setSession(LOADING);
  queryClient.getQueryCache().subscribe((event) => {
    const q = event.query;
    if (q.queryHash !== JSON.stringify(ME_KEY)) return;
    if (event.type !== 'updated' && event.type !== 'added' && event.type !== 'removed') return;
    if (event.type === 'removed') return applyMe(null);
    const data = q.state.data as MeResponse | null | undefined;
    // Refetching after a workspace switch keeps showing the old state until the answer lands.
    if (data === undefined) {
      if (q.state.status === 'error' && current === undefined) setSession(SIGNED_OUT);
      return;
    }
    if (data !== current) applyMe(data);
  });

  userSocket.on('credits.changed', (p) => {
    const me = current;
    if (!me || (p.workspaceId && p.workspaceId !== me.workspace.id)) return;
    const plan = p.plan ?? Math.min(getCredits().plan, p.balance);
    const purchased = p.purchased ?? Math.max(0, p.balance - plan);
    updateMe((m) => ({ ...m, balance: { ...m.balance, plan, purchased, held: p.held } }));
  });
  userSocket.on('prefs.changed', (p) => {
    updateMe((m) => ({ ...m, prefs: p.prefs, matureAllowed: m.isMember && p.prefs.matureContent && m.workspace.matureAllowed }));
  });
  userSocket.on('agent.allowance', (p) => {
    const me = current;
    if (!me || (p.workspaceId && p.workspaceId !== me.workspace.id)) return;
    queryClient.setQueryData<AllowanceView>([...ALLOWANCE_KEY, me.workspace.id], p);
  });
  userSocket.on('activity.updated', () => {
    void queryClient.invalidateQueries({ queryKey: ['activity'] });
  });
  userSocket.onEvent('unauthorized', () => {
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
  });
  // A refused upgrade (signed out) looks like a dropped connection: check the session.
  userSocket.onEvent('failure', (attempt) => {
    if (attempt === 2) void queryClient.invalidateQueries({ queryKey: ME_KEY });
  });
}

/** Waits for the session (route guard). Signed out → null. */
export function ensureMe(): Promise<MeResponse | null> {
  startRealSession();
  return queryClient.ensureQueryData(meQuery());
}

/** Fetches `/api/me` now (also without mounted observers, e.g. right after sign-in before navigating). */
export async function refetchMe(): Promise<void> {
  await queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
}

/** `POST /api/auth/logout`, then forget everything cached for this user. */
export async function realSignOut(): Promise<void> {
  try {
    await api.post('/auth/logout', {}, { noWorkspace: true });
  } finally {
    userSocket.stop();
    registerPrefsRemote(null);
    setWorkspaceId(null);
    queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'models' });
    queryClient.setQueryData(ME_KEY, null);
  }
}

/** Switches `x-workspace-id` and refetches everything workspace-scoped. */
export async function realSwitchWorkspace(id: string): Promise<void> {
  if (current?.workspace.id === id) return;
  setWorkspaceId(id);
  await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'models' });
}
