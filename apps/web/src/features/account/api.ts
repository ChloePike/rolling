import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_ORDER, PLANS, quoteTopUp, TOP_UP, type PlanId } from '@rolling/core/pricing/config';
import { getSession, mockOverrides } from '@/lib/session';
import { invoicesMock, meMock, membersMock } from './mocks';
import type { Invoice, Me, Member, Prefs } from './types';

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

export async function fetchMembers(): Promise<Member[]> {
  return structuredClone(membersMock);
}

export async function fetchInvoices(): Promise<Invoice[]> {
  return structuredClone(invoicesMock);
}

/**
 * One top-up option (D-006: any amount from TOP_UP.minUsd; presets shown as
 * cards). Credits come from `quoteTopUp`, so tier and plan bonuses follow the
 * pricing config; the server re-quotes at checkout.
 */
export interface TopUpOption {
  id: string;
  amountUsd: number;
  credits: number;
  bonusCredits: number;
  /** Tier bonus plus the plan bonus (0..1). */
  bonusRate: number;
}

export function topUpFor(amountUsd: number, plan: PlanId | null): TopUpOption {
  const q = quoteTopUp(Math.round(amountUsd * 100), plan ?? PLAN_ORDER[0]!);
  const planBonus = plan ? q.planBonus : 0;
  const bonusRate = q.tierBonus + planBonus;
  const bonusCredits = Math.floor(q.baseCredits * (Math.round(bonusRate * 1e6) / 1e6));
  return { id: `topup_${amountUsd}`, amountUsd, credits: q.baseCredits + bonusCredits, bonusCredits, bonusRate };
}

/** Preset top-ups (`GET /api/billing/plans`) for a member of `plan`, or list amounts without a plan bonus. */
export async function fetchTopUps(plan: PlanId | null): Promise<TopUpOption[]> {
  return TOP_UP.presetsUsd.map((usd) => topUpFor(usd, plan));
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

export function useMembers() {
  return useQuery({ queryKey: ['workspace', 'members'], queryFn: fetchMembers, staleTime: Infinity });
}

export function useInvoices() {
  return useQuery({ queryKey: ['billing', 'invoices'], queryFn: fetchInvoices, staleTime: Infinity });
}

export function useTopUps(plan: PlanId | null) {
  return useQuery({ queryKey: ['billing', 'topups', plan], queryFn: () => fetchTopUps(plan), staleTime: Infinity });
}

/** USD through Intl; whole amounts without cents ($15), others with cents ($39.17). */
export function formatUsd(
  amount: number,
  formatNumber: (n: number, o: { style: 'currency'; currency: string; minimumFractionDigits: number; maximumFractionDigits: number }) => string,
): string {
  const whole = Number.isInteger(amount);
  return formatNumber(amount, { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}
