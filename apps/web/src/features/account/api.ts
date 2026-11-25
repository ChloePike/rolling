import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_ORDER, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { topUpFor, topUpPresets, type TopUpOption } from '@/lib/topUp';
import { checkoutTopUp, getSession, mockOverrides, MockFlowError } from '@/lib/session';
import { invoicesMock, meMock, membersMock } from './mocks';
import type { Invoice, Me, Member, Prefs, Role } from './types';

/**
 * Account and billing client (`/api/me`, `/api/me/prefs`, `/api/billing/*`,
 * `/api/workspace/members`). Runs on mock data until those routes land; swap
 * the bodies for real requests and keep the hooks.
 *
 * Membership (plan, mature access) comes from `lib/session`, the one source
 * shared with the header, Home, tools and canvas. Its test seam
 * `window.__rollingMocks.me` (set before the app loads) is also merged over
 * the mock user here, e.g. `{ plan: null }` for a workspace without a plan.
 */
let me: Me = structuredClone(meMock);
let overridesApplied = false;

function current(): Me {
  if (!overridesApplied) me = { ...me, ...(mockOverrides() as Partial<Me>) };
  overridesApplied = true;
  // The plan always follows the session (checkout elsewhere updates it).
  me = { ...me, plan: getSession().plan };
  return me;
}

export async function fetchMe(): Promise<Me> {
  return structuredClone(current());
}

export async function patchPrefs(patch: Partial<Prefs>): Promise<Me> {
  const base = current();
  me = { ...base, prefs: { ...base.prefs, ...patch } };
  return structuredClone(me);
}

export async function patchAutoTopUp(enabled: boolean): Promise<Me> {
  const base = current();
  me = { ...base, autoTopUp: { ...base.autoTopUp, enabled } };
  return structuredClone(me);
}

let members: Member[] = structuredClone(membersMock);
let invoices: Invoice[] = structuredClone(invoicesMock);

/** Mock latency so pending states are visible; tests can set `window.__rollingMocks.delayMs`. */
function wait(): Promise<void> {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { delayMs?: number } }).__rollingMocks : undefined;
  const ms = typeof w?.delayMs === 'number' ? w.delayMs : 450;
  return new Promise((r) => setTimeout(r, ms));
}

/** API error with a code from docs/api.md (`NO_PLAN`, `VALIDATION`, ...). */
export class ApiError extends Error {
  constructor(
    readonly code: 'NO_PLAN' | 'VALIDATION' | 'NOT_FOUND' | 'CARD_DECLINED',
    message: string = code,
  ) {
    super(message);
  }
}

export async function fetchMembers(): Promise<Member[]> {
  return structuredClone(members);
}

export async function fetchInvoices(): Promise<Invoice[]> {
  return structuredClone(invoices);
}

export const HANDLE_RE = /^[a-z0-9_]{3,24}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `PATCH /api/me`: name, handle and email. */
export async function patchProfile(patch: Partial<Pick<Me['user'], 'name' | 'handle' | 'email'>>): Promise<Me> {
  await wait();
  if (patch.handle !== undefined && !HANDLE_RE.test(patch.handle)) throw new ApiError('VALIDATION', 'handle');
  if (patch.email !== undefined && !EMAIL_RE.test(patch.email)) throw new ApiError('VALIDATION', 'email');
  if (patch.name !== undefined && !patch.name.trim()) throw new ApiError('VALIDATION', 'name');
  const base = current();
  me = { ...base, user: { ...base.user, ...patch } };
  return structuredClone(me);
}

/** `POST /api/billing/topup` (members only, D-007): any amount, credits from `quoteTopUp`. */
export async function buyTopUp(amountUsd: number): Promise<{ credits: number; me: Me }> {
  // The balance lives in lib/session (one source with the header credits).
  let r;
  try {
    r = await checkoutTopUp(amountUsd);
  } catch (e) {
    if (e instanceof MockFlowError && e.code === 'NO_PLAN') throw new ApiError('NO_PLAN');
    throw e;
  }
  invoices = [{ id: `in_${Date.now()}`, kind: 'topUp', amountUsd, credits: r.credits }, ...invoices];
  return { credits: r.credits, me: structuredClone(current()) };
}

/** `POST /api/billing/cancel` or resume: the plan stays active until the period ends. */
export async function patchCancel(cancelAtPeriodEnd: boolean): Promise<Me> {
  await wait();
  me = { ...current(), cancelAtPeriodEnd };
  return structuredClone(me);
}

/** Stripe setup intent result (`POST /api/billing/payment-method`); the mock accepts any valid-looking card. */
export async function patchPaymentMethod(card: { number: string; expires: string }): Promise<Me> {
  await wait();
  const digits = card.number.replace(/\D/g, '');
  if (digits.length < 13 || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(card.expires)) throw new ApiError('VALIDATION', 'card');
  if (digits.endsWith('0002')) throw new ApiError('CARD_DECLINED');
  const brand = digits.startsWith('4') ? 'Visa' : digits.startsWith('5') ? 'Mastercard' : digits.startsWith('3') ? 'Amex' : 'Card';
  me = { ...current(), paymentMethod: { brand, last4: digits.slice(-4), expires: card.expires } };
  return structuredClone(me);
}

/** `POST /api/workspace/members` (invite by email). */
export async function inviteMember(input: { email: string; role: Role; monthlyCreditLimit: number | null }): Promise<Member[]> {
  await wait();
  if (!EMAIL_RE.test(input.email)) throw new ApiError('VALIDATION', 'email');
  const name = input.email.split('@')[0]!;
  members = [...members, { id: `mem_${Date.now()}`, name, email: input.email, role: input.role, monthlyCreditLimit: input.monthlyCreditLimit, invited: true }];
  return structuredClone(members);
}

/** `PATCH /api/workspace/members/:id`: role and monthly credit limit. */
export async function patchMember(id: string, patch: Partial<Pick<Member, 'role' | 'monthlyCreditLimit'>>): Promise<Member[]> {
  await wait();
  members = members.map((m) => (m.id === id ? { ...m, ...patch } : m));
  return structuredClone(members);
}

/** `DELETE /api/workspace/members/:id`. */
export async function removeMember(id: string): Promise<Member[]> {
  await wait();
  members = members.filter((m) => m.id !== id);
  return structuredClone(members);
}

/**
 * Invoice download (`GET /api/billing/invoices/:id.pdf` → a Stripe-hosted PDF).
 * The mock builds a small text receipt so the download is real.
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

/** `DELETE /api/me`: the mock signs out and forgets the session. */
export async function deleteAccount(): Promise<void> {
  await wait();
}

/** Top-up quotes live in lib/topUp (shared with the header and the paywall). */
export { formatUsd, topUpFor, type TopUpOption } from '@/lib/topUp';

/** Preset top-ups (`GET /api/billing/plans`) for a member of `plan`, or list amounts without a plan bonus. */
export async function fetchTopUps(plan: PlanId | null): Promise<TopUpOption[]> {
  return topUpPresets(plan);
}

/** Plans in display order with their config (D-006). */
export const planList = () => PLAN_ORDER.map((id) => PLANS[id]);

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: fetchMe, staleTime: Infinity });
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

export function useAutoTopUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchAutoTopUp,
    onMutate: (enabled) => {
      const prev = qc.getQueryData<Me>(meKey);
      if (prev) qc.setQueryData<Me>(meKey, { ...prev, autoTopUp: { ...prev.autoTopUp, enabled } });
    },
    onSuccess: (next) => qc.setQueryData(meKey, next),
  });
}

export const membersKey = ['workspace', 'members'] as const;
export const invoicesKey = ['billing', 'invoices'] as const;

export function useMembers() {
  return useQuery({ queryKey: membersKey, queryFn: fetchMembers, staleTime: Infinity });
}

export function useInvoices() {
  return useQuery({ queryKey: invoicesKey, queryFn: fetchInvoices, staleTime: Infinity });
}

/** Mutations that return the new `Me` write it into the cache. */
function useMeMutation<A>(fn: (a: A) => Promise<Me>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (next) => qc.setQueryData(meKey, next) });
}

export const usePatchProfile = () => useMeMutation(patchProfile);
export const useCancelPlan = () => useMeMutation(patchCancel);
export const usePaymentMethod = () => useMeMutation(patchPaymentMethod);

export function useBuyTopUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: buyTopUp,
    onSuccess: (r) => {
      qc.setQueryData(meKey, r.me);
      void qc.invalidateQueries({ queryKey: invoicesKey });
    },
  });
}

function useMembersMutation<A>(fn: (a: A) => Promise<Member[]>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (next) => qc.setQueryData(membersKey, next) });
}

export const useInviteMember = () => useMembersMutation(inviteMember);
export const usePatchMember = () => useMembersMutation((a: { id: string; patch: Partial<Pick<Member, 'role' | 'monthlyCreditLimit'>> }) => patchMember(a.id, a.patch));
export const useRemoveMember = () => useMembersMutation(removeMember);

export function useTopUps(plan: PlanId | null) {
  return useQuery({ queryKey: ['billing', 'topups', plan], queryFn: () => fetchTopUps(plan), staleTime: Infinity });
}
