import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { PLAN_ORDER, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { api } from '@/lib/api/client';
import { ApiError as HttpError, isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { AutoTopUpView, BillingSummary, InvoiceView, LedgerPage, MembersResponse, MeResponse, SeatsPreview } from '@/lib/api/types';
import { topUpFor, topUpPresets, type TopUpOption } from '@/lib/topUp';
import { checkoutTopUp, getSession, ME_KEY, meQuery, mockOverrides, MockFlowError, openBillingPortal, refetchMe, useSession } from '@/lib/session';
import { accountHandle } from '@/shell/account';
import { invoicesMock, meMock, membersMock } from './mocks';
import type { Invoice, Me, Member, Prefs, Role } from './types';

/**
 * Account and billing client.
 *
 * Real API (docs/api.md): `GET /api/me` (shared with lib/session), `GET
 * /api/billing`, `PATCH /api/billing/auto-topup`, `GET /api/billing/ledger`,
 * `GET /api/billing/invoices`, `POST /api/billing/portal`, `GET
 * /api/billing/seats/preview`, `/api/workspace/members|invites`, Better Auth
 * `update-user` / `list-accounts` / `link-social` / `unlink-account`.
 *
 * Mock mode (`VITE_API_MODE=mock`): in-memory data from `mocks.ts`. The test
 * seam `window.__rollingMocks.me` is merged over the mock user here, e.g.
 * `{ plan: null }`; `__rollingMocks.delayMs` sets the latency.
 */

// ---------------------------------------------------------------- errors

/** API error with a code from docs/api.md (`NO_PLAN`, `VALIDATION`, ...). Mock flows throw it; real calls throw `HttpError`. */
export class ApiError extends Error {
  constructor(
    readonly code: 'NO_PLAN' | 'VALIDATION' | 'NOT_FOUND' | 'CARD_DECLINED' | 'TEAM_REQUIRED' | 'SEATS_REQUIRED',
    message: string = code,
  ) {
    super(message);
  }
}

/** The error code of a mock `ApiError`, a session `FlowError` or a real `HttpError`. */
export function errorCode(e: unknown): string | null {
  if (e instanceof ApiError || e instanceof HttpError) return e.code;
  return null;
}

// ---------------------------------------------------------------- mock state

let me: Me = structuredClone(meMock);
let overridesApplied = false;

function current(): Me {
  if (!overridesApplied) me = { ...me, ...(mockOverrides() as Partial<Me>) };
  overridesApplied = true;
  // The plan always follows the session (checkout elsewhere updates it).
  me = { ...me, plan: getSession().plan };
  return me;
}

let members: Member[] = structuredClone(membersMock);
let invoices: Invoice[] = structuredClone(invoicesMock);

/** Mock latency so pending states are visible; tests can set `window.__rollingMocks.delayMs`. */
function wait(): Promise<void> {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { delayMs?: number } }).__rollingMocks : undefined;
  const ms = typeof w?.delayMs === 'number' ? w.delayMs : 450;
  return new Promise((r) => setTimeout(r, ms));
}

export const HANDLE_RE = /^[a-z0-9_]{3,24}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- real mapping

const toPeriod = (i: 'month' | 'year' | null | undefined) => (i === 'year' ? ('yearly' as const) : ('monthly' as const));

/** The Settings view model from `/api/me` and `/api/billing`. */
export function accountFromApi(m: MeResponse, b: BillingSummary | undefined, signIn: Me['user']['signIn'] = 'email'): Me {
  const auto: AutoTopUpView | null = b?.autoTopUp ?? null;
  return {
    user: {
      id: m.user.id,
      name: m.user.name || (m.user.email ?? '').split('@')[0] || '',
      handle: accountHandle({ user: m.user }),
      email: m.user.email ?? '',
      signIn,
    },
    workspace: { id: m.workspace.id, name: m.workspace.name, matureAllowed: m.workspace.matureAllowed },
    role: m.role,
    prefs: {
      language: m.prefs.language,
      currency: m.prefs.currency,
      creationMode: m.prefs.creationMode,
      defaultRatio: m.prefs.defaultRatio,
      defaultModel: m.prefs.defaultModel,
      confirmThreshold: m.prefs.confirmThreshold,
      matureContent: m.prefs.matureContent,
      notifications: {
        generationFinished: m.prefs.notifications.done,
        creditsLow: m.prefs.notifications.low,
        planRenewal: m.prefs.notifications.renewal,
        productUpdates: m.prefs.notifications.product,
      },
    },
    plan: m.plan ? { id: m.plan.id, period: toPeriod(m.plan.interval), status: 'active', seats: m.plan.perks.seats } : null,
    balance: { plan: m.balance.plan, purchased: m.balance.purchased, held: m.balance.held },
    autoTopUp: { enabled: auto?.enabled ?? false, below: auto?.thresholdCredits ?? 200, amountUsd: (auto?.amountCents ?? 1000) / 100 },
    // Cards live in the Stripe customer portal; the API does not expose them.
    paymentMethod: null,
    cancelAtPeriodEnd: b?.cancelAtPeriodEnd ?? m.plan?.cancelAtPeriodEnd ?? false,
    periodEnd: b?.periodEnd ?? m.plan?.currentPeriodEnd ?? null,
    periodStart: b?.periodStart ?? null,
    seats: b?.seats ?? null,
  };
}

export function membersFromApi(r: MembersResponse): Member[] {
  return [
    ...r.members.map((m) => ({ id: m.userId, name: m.name || m.email.split('@')[0] || m.email, email: m.email, role: m.role, monthlyCreditLimit: m.monthlyCreditLimit, isYou: m.isYou })),
    ...r.invites.map((i) => ({ id: i.id, name: i.email.split('@')[0] || i.email, email: i.email, role: i.role, monthlyCreditLimit: null, invited: true, expiresAt: i.expiresAt })),
  ];
}

export function invoiceFromApi(i: InvoiceView): Invoice {
  return { id: i.id, kind: 'plan', number: i.number, createdAt: i.createdAt, amountCents: i.amountCents, currency: i.currency, status: i.status, url: i.url, pdfUrl: i.pdfUrl };
}

// ---------------------------------------------------------------- reads

export async function fetchMe(): Promise<Me> {
  return structuredClone(current());
}

export async function fetchMembers(): Promise<Member[]> {
  if (isMockApi()) return structuredClone(members);
  return membersFromApi(await api.get<MembersResponse>('/workspace/members'));
}

export async function fetchInvoices(): Promise<Invoice[]> {
  if (isMockApi()) return structuredClone(invoices);
  try {
    const r = await api.get<{ invoices: InvoiceView[] }>('/billing/invoices');
    return r.invoices.map(invoiceFromApi);
  } catch (e) {
    // Non-owners cannot list invoices.
    if (isApiError(e, 'FORBIDDEN')) return [];
    throw e;
  }
}

/** Preset top-ups (`GET /api/billing/plans` presets) for a member of `plan`, or list amounts without a plan bonus. */
export async function fetchTopUps(plan: PlanId | null): Promise<TopUpOption[]> {
  return topUpPresets(plan);
}

// ---------------------------------------------------------------- writes

/** Profile: name (Better Auth `update-user`); handle and email only in the mock (no API yet). */
export async function patchProfile(patch: Partial<Pick<Me['user'], 'name' | 'handle' | 'email'>>): Promise<Me> {
  if (patch.name !== undefined && !patch.name.trim()) throw new ApiError('VALIDATION', 'name');
  if (!isMockApi()) {
    if (patch.name !== undefined) await api.post('/auth/update-user', { name: patch.name.trim() }, { noWorkspace: true });
    await refetchMe();
    return structuredClone(current());
  }
  await wait();
  if (patch.handle !== undefined && !HANDLE_RE.test(patch.handle)) throw new ApiError('VALIDATION', 'handle');
  if (patch.email !== undefined && !EMAIL_RE.test(patch.email)) throw new ApiError('VALIDATION', 'email');
  const base = current();
  me = { ...base, user: { ...base.user, ...patch } };
  return structuredClone(me);
}

export async function patchPrefs(patch: Partial<Prefs>): Promise<Me> {
  const base = current();
  me = { ...base, prefs: { ...base.prefs, ...patch } };
  return structuredClone(me);
}

/** `PATCH /api/billing/auto-topup` (owner; members only to enable). */
export async function patchAutoTopUp(enabled: boolean, settings?: { below: number; amountUsd: number }): Promise<Me> {
  if (!isMockApi()) {
    await api.patch('/billing/auto-topup', {
      enabled,
      ...(settings ? { thresholdCredits: settings.below, amountCents: Math.round(settings.amountUsd * 100) } : {}),
    });
    return structuredClone(current());
  }
  const base = current();
  me = { ...base, autoTopUp: { ...base.autoTopUp, enabled } };
  return structuredClone(me);
}

/** Top-up checkout (members only, D-007): real goes to Stripe (never resolves); the mock adds the credits now. */
export async function buyTopUp(amountUsd: number, opts: { returnTo?: string } = {}): Promise<{ credits: number; me: Me }> {
  let r;
  try {
    r = await checkoutTopUp(amountUsd, opts);
  } catch (e) {
    if (e instanceof MockFlowError && e.code === 'NO_PLAN') throw new ApiError('NO_PLAN');
    throw e;
  }
  invoices = [{ id: `in_${Date.now()}`, kind: 'topUp', amountUsd, credits: r.credits, createdAt: Date.now() }, ...invoices];
  return { credits: r.credits, me: structuredClone(current()) };
}

/** Cancel at period end / resume. Real: the Stripe portal (plan change, cancel, resume). */
export async function patchCancel(cancelAtPeriodEnd: boolean): Promise<Me> {
  if (!isMockApi()) return openBillingPortal();
  await wait();
  me = { ...current(), cancelAtPeriodEnd };
  return structuredClone(me);
}

/** Card update. Real: the Stripe portal. Mock: accepts any valid-looking card (`…0002` is declined). */
export async function patchPaymentMethod(card: { number: string; expires: string }): Promise<Me> {
  if (!isMockApi()) return openBillingPortal();
  await wait();
  const digits = card.number.replace(/\D/g, '');
  if (digits.length < 13 || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(card.expires)) throw new ApiError('VALIDATION', 'card');
  if (digits.endsWith('0002')) throw new ApiError('CARD_DECLINED');
  const brand = digits.startsWith('4') ? 'Visa' : digits.startsWith('5') ? 'Mastercard' : digits.startsWith('3') ? 'Amex' : 'Card';
  me = { ...current(), paymentMethod: { brand, last4: digits.slice(-4), expires: card.expires } };
  return structuredClone(me);
}

/**
 * `POST /api/workspace/invites`. D-013: only Team invites (`TEAM_REQUIRED`),
 * and members + pending invites must fit the purchased seats
 * (`SEATS_REQUIRED { seats, used, needed }`).
 */
export async function inviteMember(input: { email: string; role: Role; monthlyCreditLimit: number | null }): Promise<Member[]> {
  if (!EMAIL_RE.test(input.email)) throw new ApiError('VALIDATION', 'email');
  if (!isMockApi()) {
    await api.post('/workspace/invites', { email: input.email, role: input.role === 'owner' ? 'editor' : input.role });
    void refetchMe();
    return fetchMembers();
  }
  await wait();
  const s = getSession();
  if (!s.isTeam) throw new ApiError('TEAM_REQUIRED');
  if (members.length >= s.seats) throw new ApiError('SEATS_REQUIRED');
  const name = input.email.split('@')[0]!;
  members = [...members, { id: `mem_${Date.now()}`, name, email: input.email, role: input.role, monthlyCreditLimit: input.monthlyCreditLimit, invited: true }];
  return structuredClone(members);
}

/** `PATCH /api/workspace/members/:userId`: role and monthly credit limit. */
export async function patchMember(id: string, patch: Partial<Pick<Member, 'role' | 'monthlyCreditLimit'>>): Promise<Member[]> {
  if (!isMockApi()) {
    await api.patch(`/workspace/members/${encodeURIComponent(id)}`, patch);
    return fetchMembers();
  }
  await wait();
  members = members.map((m) => (m.id === id ? { ...m, ...patch } : m));
  return structuredClone(members);
}

/** `DELETE /api/workspace/members/:userId`, or `DELETE /api/workspace/invites/:id` for a pending invite. */
export async function removeMember(id: string, opts: { invited?: boolean } = {}): Promise<Member[]> {
  if (!isMockApi()) {
    await api.delete(opts.invited ? `/workspace/invites/${encodeURIComponent(id)}` : `/workspace/members/${encodeURIComponent(id)}`);
    return fetchMembers();
  }
  await wait();
  members = members.filter((m) => m.id !== id);
  return structuredClone(members);
}

/**
 * Invoice download. Real: the Stripe-hosted PDF (`pdfUrl`, else the hosted page).
 * Mock: builds a small text receipt so the download is real.
 */
export function invoiceFile(inv: Invoice, lines: string[]): { name: string; blob: Blob } {
  return { name: `rolling-invoice-${inv.id}.txt`, blob: new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }) };
}

/** Saves a blob through a temporary link (the browser's download flow). */
export function saveFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Account deletion: mock only (the API has no delete route yet; the real dialog says so). */
export async function deleteAccount(): Promise<void> {
  await wait();
}

/** Top-up quotes live in lib/topUp (shared with the header and the paywall). */
export { formatUsd, topUpFor, type TopUpOption } from '@/lib/topUp';

/** Seats used by members and pending invites (D-013). */
export function seatsUsed(list: Member[]): number {
  return list.length;
}

/** Plans in display order with their config (D-006). */
export const planList = () => PLAN_ORDER.map((id) => PLANS[id]);

// ---------------------------------------------------------------- hooks

export const meKey = ['me'] as const;
export const billingKey = ['billing', 'summary'] as const;
export const membersKey = ['workspace', 'members'] as const;
export const invoicesKey = ['billing', 'invoices'] as const;
export const ledgerKey = ['billing', 'ledger'] as const;
export const accountsKey = ['auth', 'accounts'] as const;

/** `GET /api/billing` (real only). */
export function useBilling() {
  const { workspace, status } = useSession();
  return useQuery({
    queryKey: [...billingKey, workspace?.id ?? null],
    queryFn: () => api.get<BillingSummary>('/billing'),
    enabled: !isMockApi() && status === 'signedIn',
    staleTime: 30_000,
  });
}

/** Linked sign-in methods (Better Auth `list-accounts`), real only. */
export function useLinkedAccounts() {
  const { status } = useSession();
  return useQuery({
    queryKey: accountsKey,
    queryFn: () => api.get<{ providerId: string; accountId: string; id: string }[]>('/auth/list-accounts', { noWorkspace: true }),
    enabled: !isMockApi() && status === 'signedIn',
    staleTime: 60_000,
  });
}

export function useMe(): { data: Me | undefined; isPending: boolean } {
  const mock = useQuery({ queryKey: meKey, queryFn: fetchMe, staleTime: Infinity, enabled: isMockApi() });
  const real = useQuery({ ...meQuery(), enabled: !isMockApi() });
  const billing = useBilling();
  const accounts = useLinkedAccounts();
  const data = useMemo(() => {
    if (isMockApi()) return mock.data;
    if (!real.data) return undefined;
    const ids = (accounts.data ?? []).map((a) => a.providerId);
    const signIn: Me['user']['signIn'] = ids.includes('google') ? 'google' : ids.includes('apple') ? 'apple' : 'email';
    return accountFromApi(real.data, billing.data, signIn);
  }, [mock.data, real.data, billing.data, accounts.data]);
  return { data, isPending: isMockApi() ? mock.isPending : real.isPending };
}

/** Credits spent this billing period (settled jobs, from the ledger). Real only; null until loaded. */
export function useUsedThisPeriod(): number | null {
  const billing = useBilling();
  const { workspace, isMember } = useSession();
  const start = billing.data?.periodStart ?? null;
  const q = useQuery({
    queryKey: [...ledgerKey, 'period', workspace?.id ?? null, start],
    queryFn: () => api.get<LedgerPage>('/billing/ledger', { query: { first: 100 } }),
    enabled: !isMockApi() && isMember && billing.isSuccess,
    staleTime: 30_000,
  });
  return useMemo(() => {
    if (!q.data) return null;
    const from = start ?? new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1).getTime();
    return q.data.lines.filter((l) => l.kind === 'settle' && l.createdAt >= from).reduce((n, l) => n - l.amount, 0);
  }, [q.data, start]);
}

export function useLedger() {
  const { workspace, status } = useSession();
  return useQuery({
    queryKey: [...ledgerKey, workspace?.id ?? null],
    queryFn: () => api.get<LedgerPage>('/billing/ledger', { query: { first: 25 } }),
    enabled: !isMockApi() && status === 'signedIn',
    staleTime: 30_000,
  });
}

/** Next page of the ledger (cursor from `pageInfo.endCursor`). */
export function fetchLedgerPage(after: string): Promise<LedgerPage> {
  return api.get<LedgerPage>('/billing/ledger', { query: { first: 25, after } });
}

/** `GET /api/billing/seats/preview?seats=N` (Team owners). */
export function useSeatsPreview(seats: number, enabled: boolean) {
  return useQuery({
    queryKey: ['billing', 'seats-preview', seats],
    queryFn: () => api.get<SeatsPreview>('/billing/seats/preview', { query: { seats } }),
    enabled: !isMockApi() && enabled,
    staleTime: 30_000,
  });
}

export function useUpdatePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchPrefs,
    onMutate: (patch) => {
      const prev = qc.getQueryData<Me>(meKey);
      if (prev) qc.setQueryData<Me>(meKey, { ...prev, prefs: { ...prev.prefs, ...patch } });
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(meKey, ctx.prev);
    },
    onSuccess: (next) => qc.setQueryData(meKey, next),
  });
}

/** Writes into the mock cache, or invalidates the real reads. */
function settle(qc: ReturnType<typeof useQueryClient>, next?: Me) {
  if (isMockApi()) {
    if (next) qc.setQueryData(meKey, next);
    return;
  }
  void qc.invalidateQueries({ queryKey: ME_KEY });
  void qc.invalidateQueries({ queryKey: ['billing'] });
}

export function useAutoTopUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => patchAutoTopUp(enabled),
    onMutate: (enabled) => {
      const prev = qc.getQueryData<Me>(meKey);
      if (prev) qc.setQueryData<Me>(meKey, { ...prev, autoTopUp: { ...prev.autoTopUp, enabled } });
      // Real: optimistic on the billing summary; rolled back on error.
      const key = qc.getQueryCache().findAll({ queryKey: billingKey });
      const snapshots = key.map((q) => [q.queryKey, q.state.data] as const);
      for (const [k, d] of snapshots) {
        const b = d as BillingSummary | undefined;
        if (b) qc.setQueryData<BillingSummary>(k, { ...b, autoTopUp: { thresholdCredits: 200, amountCents: 1000, ...b.autoTopUp, enabled } });
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      for (const [k, d] of ctx?.snapshots ?? []) qc.setQueryData(k, d);
    },
    onSuccess: (next) => settle(qc, next),
  });
}

/** Mutations that return the new `Me` write it into the cache. */
function useMeMutation<A>(fn: (a: A) => Promise<Me>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (next) => settle(qc, next) });
}

export const usePatchProfile = () => useMeMutation(patchProfile);
export const useCancelPlan = () => useMeMutation(patchCancel);
export const usePaymentMethod = () => useMeMutation(patchPaymentMethod);

export function useBuyTopUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amountUsd: number) => buyTopUp(amountUsd),
    onSuccess: (r) => {
      settle(qc, r.me);
      void qc.invalidateQueries({ queryKey: invoicesKey });
    },
  });
}

export function useMembers() {
  const { workspace, status } = useSession();
  return useQuery({
    queryKey: [...membersKey, isMockApi() ? 'mock' : (workspace?.id ?? null)],
    queryFn: fetchMembers,
    staleTime: isMockApi() ? Infinity : 30_000,
    enabled: isMockApi() || status === 'signedIn',
  });
}

export function useInvoices() {
  const { workspace, status, role } = useSession();
  return useQuery({
    queryKey: [...invoicesKey, isMockApi() ? 'mock' : (workspace?.id ?? null)],
    queryFn: fetchInvoices,
    staleTime: isMockApi() ? Infinity : 60_000,
    enabled: isMockApi() || (status === 'signedIn' && role === 'owner'),
  });
}

function useMembersMutation<A>(fn: (a: A) => Promise<Member[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (next) => {
      for (const q of qc.getQueryCache().findAll({ queryKey: membersKey })) qc.setQueryData(q.queryKey, next);
      if (!isMockApi()) void qc.invalidateQueries({ queryKey: ['billing'] });
    },
  });
}

export const useInviteMember = () => useMembersMutation(inviteMember);
export const usePatchMember = () => useMembersMutation((a: { id: string; patch: Partial<Pick<Member, 'role' | 'monthlyCreditLimit'>> }) => patchMember(a.id, a.patch));
export const useRemoveMember = () => useMembersMutation((a: string | { id: string; invited?: boolean }) => (typeof a === 'string' ? removeMember(a) : removeMember(a.id, { invited: a.invited })));

export function useTopUps(plan: PlanId | null) {
  return useQuery({ queryKey: ['billing', 'topups', plan], queryFn: () => fetchTopUps(plan), staleTime: Infinity });
}

// ---------------------------------------------------------------- sign-in methods (Better Auth)

/** Links Google or Apple to this account: the provider round trip returns to Settings → Account. */
export async function linkProvider(provider: 'google' | 'apple'): Promise<never> {
  const r = await api.post<{ url: string }>('/auth/link-social', { provider, callbackURL: '/settings/account' }, { noWorkspace: true });
  const seam = (window as unknown as { __rollingRedirect?: (u: string) => void }).__rollingRedirect;
  if (seam) seam(r.url);
  else window.location.assign(r.url);
  return new Promise(() => {});
}

export async function unlinkProvider(provider: 'google' | 'apple'): Promise<void> {
  await api.post('/auth/unlink-account', { providerId: provider }, { noWorkspace: true });
}

/** Signals a profile handle change is possible (mock only until handles exist on the server). */
export const canEditHandle = () => isMockApi();
export const canEditEmail = () => isMockApi();
export const canDeleteAccount = () => isMockApi();

