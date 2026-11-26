import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProviders } from '@/features/auth/api';
import { googleStartUrl, GooglePopupError, leaveTo, requestGoogleAccessToken, signInWithGoogleAccessToken, useGoogleTokenClient } from '@/features/auth/google';
import { useMemo } from 'react';
import { PLAN_ORDER, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { api } from '@/lib/api/client';
import { ApiError as HttpError, isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { AutoTopUpView, BillingSummary, InvoiceView, LedgerPage, MembersResponse, MeResponse, PaymentMethodView, ProfileUpdate, SeatsPreview } from '@/lib/api/types';
import { uploadToAssets } from '@/features/picker';
import { topUpFor, topUpPresets, type TopUpOption } from '@/lib/topUp';
import { checkoutTopUp, getSession, ME_KEY, meQuery, mockOverrides, MockFlowError, openBillingPortal, refetchMe, useSession } from '@/lib/session';
import { mockData } from '@/lib/api/mode';
import type { Invoice, Me, Member, Prefs, Role } from './types';

/**
 * Account and billing client.
 *
 * Real API (docs/api.md): `GET /api/me` (shared with lib/session), `GET
 * /api/billing`, `PATCH /api/billing/auto-topup`, `GET /api/billing/ledger`,
 * `GET /api/billing/invoices`, `POST /api/billing/portal`, `GET
 * /api/billing/seats/preview`, `GET /api/billing/payment-method`,
 * `/api/workspace/members|invites`, `PATCH /api/me/profile` (name, handle, bio,
 * avatar), account deletion (`POST /api/me/delete/send-code`, `POST
 * /api/me/delete`), data export (`POST|GET /api/account/export`), Better Auth `email-otp/request-email-change` /
 * `email-otp/change-email` / `list-accounts` / `link-social` / `unlink-account`.
 *
 * Mock mode (`VITE_API_MODE=mock`): in-memory data from `mocks.ts`. The test
 * seam `window.__rollingMocks.me` is merged over the mock user here, e.g.
 * `{ plan: null }`; `__rollingMocks.delayMs` sets the latency.
 */

// ---------------------------------------------------------------- errors

/** API error with a code from docs/api.md (`NO_PLAN`, `VALIDATION`, ...). Mock flows throw it; real calls throw `HttpError`. */
export class ApiError extends Error {
  constructor(
    readonly code: 'NO_PLAN' | 'VALIDATION' | 'NOT_FOUND' | 'CARD_DECLINED' | 'TEAM_REQUIRED' | 'SEATS_REQUIRED' | 'HANDLE_TAKEN' | 'INVALID_CODE' | 'AVATAR_REJECTED' | 'RATE_LIMITED',
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

// Seeded from the mock-mode adapter on first use (never read in real mode).
let me = undefined as unknown as Me;
let members: Member[] = [];
let invoices: Invoice[] = [];
let mockSeeded = false;

function seedMock() {
  if (mockSeeded) return;
  mockSeeded = true;
  const m = mockData().account;
  me = structuredClone(m.meMock);
  members = structuredClone(m.membersMock);
  invoices = structuredClone(m.invoicesMock);
}

function current(): Me {
  seedMock();
  if (!overridesApplied) me = { ...me, ...(mockOverrides() as Partial<Me>) };
  overridesApplied = true;
  // The plan always follows the session (checkout elsewhere updates it).
  me = { ...me, plan: getSession().plan };
  return me;
}

let overridesApplied = false;

/** Mock latency so pending states are visible; tests can set `window.__rollingMocks.delayMs`. */
function wait(): Promise<void> {
  seedMock();
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { delayMs?: number } }).__rollingMocks : undefined;
  const ms = typeof w?.delayMs === 'number' ? w.delayMs : 450;
  return new Promise((r) => setTimeout(r, ms));
}

/** Server rule (`@rolling/core/auth/profile`): 3–30 of a–z, 0–9, `_` and `.`. */
export const HANDLE_RE = /^[a-z0-9_.]{3,30}$/;
export const BIO_MAX = 160;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- real mapping

const toPeriod = (i: 'month' | 'year' | null | undefined) => (i === 'year' ? ('yearly' as const) : ('monthly' as const));

/** The Settings view model from `/api/me` and `/api/billing`. */
export function accountFromApi(m: MeResponse, b: BillingSummary | undefined, signIn: Me['user']['signIn'] = 'email', card: PaymentMethodView | null = null): Me {
  const auto: AutoTopUpView | null = b?.autoTopUp ?? null;
  return {
    user: {
      id: m.user.id,
      name: m.user.name || (m.user.email ?? '').split('@')[0] || '',
      handle: m.user.handle ?? '',
      email: m.user.email ?? '',
      signIn,
      bio: m.user.bio ?? null,
      image: m.user.image,
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
    // Read from `GET /api/billing/payment-method`; changes go through the Stripe portal.
    paymentMethod: card ? cardFromApi(card) : null,
    cancelAtPeriodEnd: b?.cancelAtPeriodEnd ?? m.plan?.cancelAtPeriodEnd ?? false,
    periodEnd: b?.periodEnd ?? m.plan?.currentPeriodEnd ?? null,
    periodStart: b?.periodStart ?? null,
    seats: b?.seats ?? null,
  };
}

export function cardFromApi(c: PaymentMethodView): Me['paymentMethod'] {
  const brand = c.wallet ? c.wallet.replace(/_/g, ' ') : (c.brand ?? c.type);
  const label = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
  const expires = c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : '';
  return { brand: label, last4: c.last4 ?? '', expires };
}

export function membersFromApi(r: MembersResponse): Member[] {
  return [
    ...r.members.map((m) => ({ id: m.userId, name: m.name || m.email.split('@')[0] || m.email, email: m.email, role: m.role, monthlyCreditLimit: m.monthlyCreditLimit, isYou: m.isYou, image: m.image })),
    ...r.invites.map((i) => ({ id: i.id, name: i.email.split('@')[0] || i.email, email: i.email, role: i.role, monthlyCreditLimit: i.monthlyCreditLimit ?? null, invited: true, expiresAt: i.expiresAt })),
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
  if (isMockApi()) {
    seedMock();
    return structuredClone(members);
  }
  return membersFromApi(await api.get<MembersResponse>('/workspace/members'));
}

export async function fetchInvoices(): Promise<Invoice[]> {
  if (isMockApi()) {
    seedMock();
    return structuredClone(invoices);
  }
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

/**
 * `PATCH /api/me/profile`: name, handle and bio. `HANDLE_TAKEN` (409) when the
 * handle belongs to someone else or is reserved. Email changes go through
 * `requestEmailChange` / `confirmEmailChange`.
 */
export async function patchProfile(patch: Partial<Pick<Me['user'], 'name' | 'handle'>> & { bio?: string | null }): Promise<Me> {
  if (patch.name !== undefined && !patch.name.trim()) throw new ApiError('VALIDATION', 'name');
  if (patch.handle !== undefined && !HANDLE_RE.test(patch.handle)) throw new ApiError('VALIDATION', 'handle');
  if (!isMockApi()) {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name.trim();
    if (patch.handle !== undefined) body.handle = patch.handle;
    if (patch.bio !== undefined) body.bio = patch.bio ?? '';
    if (Object.keys(body).length) await api.patch<ProfileUpdate>('/me/profile', body);
    await refetchMe();
    return structuredClone(current());
  }
  await wait();
  if (patch.handle === 'taken') throw new ApiError('HANDLE_TAKEN');
  const base = current();
  me = { ...base, user: { ...base.user, ...patch } };
  return structuredClone(me);
}

/**
 * New avatar: the file goes through the shared upload queue (direct to R2,
 * D-011), then `PATCH /api/me/profile { avatarAssetId }`; the server rates it
 * and refuses anything but safe images (`AVATAR_REJECTED`, D-005). Mock: an
 * object URL. Returns the new image URL.
 */
export async function uploadAvatar(file: File): Promise<string> {
  if (isMockApi()) {
    await wait();
    const url = URL.createObjectURL(file);
    const base = current();
    me = { ...base, user: { ...base.user, image: url } };
    return url;
  }
  // Into the user's Assets first (shared transfer queue, D-011), then referenced by asset id.
  const { items, refused } = uploadToAssets([file], { purpose: 'other', priority: 'high', quiet: true });
  if (refused.length || !items[0]) throw new ApiError('VALIDATION', 'avatar');
  const { assetId } = await items[0].done;
  const r = await api.patch<ProfileUpdate>('/me/profile', { avatarAssetId: assetId });
  await refetchMe();
  return r.profile.image ?? '';
}

/** Email change, step 1: a 6-digit code goes to the new address (Better Auth email OTP). */
export async function requestEmailChange(newEmail: string): Promise<void> {
  if (!EMAIL_RE.test(newEmail)) throw new ApiError('VALIDATION', 'email');
  if (isMockApi()) return wait();
  await api.post('/auth/email-otp/request-email-change', { newEmail }, { noWorkspace: true });
}

/** Email change, step 2: the code from the new inbox switches the account's email. Mock: `000000` is wrong. */
export async function confirmEmailChange(newEmail: string, otp: string): Promise<void> {
  if (isMockApi()) {
    await wait();
    if (otp === '000000') throw new ApiError('INVALID_CODE');
    const base = current();
    me = { ...base, user: { ...base.user, email: newEmail } };
    return;
  }
  await api.post('/auth/email-otp/change-email', { newEmail, otp }, { noWorkspace: true });
  await refetchMe();
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
  if (isMockApi()) seedMock();
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
    await api.post('/workspace/invites', {
      email: input.email,
      role: input.role === 'owner' ? 'editor' : input.role,
      ...(input.monthlyCreditLimit !== null ? { monthlyCreditLimit: input.monthlyCreditLimit } : {}),
    });
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

/**
 * Account deletion, step 1: the server checks the account can go (a Team you
 * own with other members needs a new owner first: `OWNER_OF_TEAM`) and emails a
 * code. Mock: always sends.
 */
export async function sendDeleteCode(): Promise<{ email: string }> {
  if (isMockApi()) {
    await wait();
    return { email: current().user.email };
  }
  return api.post<{ email: string }>('/me/delete/send-code', {}, { noWorkspace: true });
}

/** Account deletion, step 2: the emailed code deletes the account and ends the session. Mock: `000000` is wrong. */
export async function deleteAccount(code: string): Promise<void> {
  if (isMockApi()) {
    await wait();
    if (code === '000000') throw new ApiError('INVALID_CODE');
    return;
  }
  await api.post('/me/delete', { code }, { noWorkspace: true });
}

/** `GET|POST /api/account/export` (docs/api.md → Account). */
export interface DataExportView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  nextAvailableAt: number;
}

const DATA_EXPORT_COOLDOWN_MS = 24 * 3_600_000;
let mockExport: DataExportView | null = null;

/** Latest data export of the signed-in user (null when none). Mock: the one asked for in this page session. */
export async function fetchDataExport(): Promise<DataExportView | null> {
  if (isMockApi()) return mockExport;
  return (await api.get<{ export: DataExportView | null }>('/account/export', { noWorkspace: true })).export;
}

/**
 * Starts a data export: the server builds the bundle and emails a download
 * link (7 days). One per 24 hours: `RATE_LIMITED` with `nextAvailableAt`.
 * Mock: the second request in a page session is rate limited.
 */
export async function requestDataExport(): Promise<{ export: DataExportView; email: string }> {
  if (isMockApi()) {
    await wait();
    if (mockExport) throw new ApiError('RATE_LIMITED');
    const now = Date.now();
    mockExport = { id: 'dex_mock', status: 'queued', createdAt: now, finishedAt: null, expiresAt: null, nextAvailableAt: now + DATA_EXPORT_COOLDOWN_MS };
    return { export: mockExport, email: current().user.email };
  }
  return api.post<{ export: DataExportView; email: string }>('/account/export', {}, { noWorkspace: true });
}

export const dataExportKey = ['account', 'export'] as const;

export function useDataExport() {
  const { status } = useSession();
  return useQuery({ queryKey: dataExportKey, queryFn: fetchDataExport, enabled: isMockApi() || status === 'signedIn', staleTime: 30_000 });
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

/** `GET /api/billing/payment-method` (owners, real only): the Stripe default card. */
export function useCardOnFile() {
  const { workspace, status, role } = useSession();
  return useQuery({
    queryKey: ['billing', 'payment-method', workspace?.id ?? null],
    queryFn: async () => (await api.get<{ paymentMethod: PaymentMethodView | null }>('/billing/payment-method')).paymentMethod,
    enabled: !isMockApi() && status === 'signedIn' && role === 'owner',
    staleTime: 60_000,
    retry: false,
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
  const card = useCardOnFile();
  const data = useMemo(() => {
    if (isMockApi()) return mock.data;
    if (!real.data) return undefined;
    const ids = (accounts.data ?? []).map((a) => a.providerId);
    const signIn: Me['user']['signIn'] = ids.includes('google') ? 'google' : 'email';
    return accountFromApi(real.data, billing.data, signIn, card.data ?? null);
  }, [mock.data, real.data, billing.data, accounts.data, card.data]);
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

/** Loads Google Identity Services and prepares the token client, so "Connect" can open the popup in the click. */
export function usePrepareGoogleLink() {
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: fetchProviders, staleTime: 5 * 60_000, enabled: !isMockApi() });
  return useGoogleTokenClient(providers.data?.google || null);
}

/**
 * Links Google to this account (D-017, no client secret). Call it synchronously from the
 * click: the token client's popup returns an access token, `POST /api/auth/google/access-token`
 * with `intent: 'link'` links it. Resolves `closed` when the user closed the popup (quiet).
 * Without the token client, or when the popup is blocked, the window goes to the
 * redirect fallback (`/api/auth/google/start?intent=link`) and returns to Settings.
 */
export function linkProvider(_provider: 'google'): Promise<'linked' | 'closed'> {
  return requestGoogleAccessToken().then(
    async (token) => {
      await signInWithGoogleAccessToken(token, '/settings/account', 'link');
      return 'linked' as const;
    },
    (err: unknown) => {
      const type = err instanceof GooglePopupError ? err.type : 'unknown';
      if (type === 'popup_closed' || type === 'superseded') return 'closed' as const;
      if (type === 'popup_failed_to_open' || type === 'unavailable') {
        leaveTo(googleStartUrl('/settings/account', 'link'));
        return new Promise<never>(() => {});
      }
      throw err;
    },
  );
}

export async function unlinkProvider(provider: 'google'): Promise<void> {
  await api.post('/auth/unlink-account', { providerId: provider }, { noWorkspace: true });
}



