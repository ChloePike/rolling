import { agentAllowancePeriod, defaultTurnEstimateUsd, turnsLeft, type TokenPrice } from '@rolling/core/pricing/agent';
import { PUBLIC_CHAT_MODELS } from '@rolling/core/models/chat';
import { planAgentAllowanceUsd, type PlanId } from '@rolling/core/pricing/config';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { AllowanceView } from '@/lib/api/types';
import { useSession } from './store';
import { ALLOWANCE_KEY } from './real';

/**
 * Monthly agent allowance (D-012): USD of gateway cost per plan, shown as
 * "~N turns left" per agent LLM in the pickers.
 *
 * Real API: `GET /api/agent/allowance` (TanStack Query, per workspace) kept
 * live by the `agent.allowance` message on the user socket (lib/session
 * writes it into the same cache). DeepSeek public LLMs are unmetered (D-012
 * amendment): the server lists them `{ unlimited: true }` and the pickers show
 * no turn count for them (`turnsLeftFor` → null).
 *
 * Mock: computed from the same constants the API uses. Test seam:
 * `window.__rollingMocks.agentAllowance = { usedUsd }`.
 */
export interface AgentAllowanceModel {
  /** Public LLM id (never a gateway id). */
  id: string;
  name: string;
  /** Unmetered (DeepSeek): no estimate, no count. */
  unlimited: boolean;
  estTurnUsd: number | null;
  turnsLeft: number | null;
}

export interface AgentAllowance {
  plan: PlanId | null;
  allowanceUsd: number;
  usedUsd: number;
  /** Epoch ms of the next reset. */
  resetsAt: number;
  models: AgentAllowanceModel[];
}

export interface AgentAllowanceState extends AgentAllowance {
  /** Every metered model is out of turns (unmetered DeepSeek models still work). */
  exhausted: boolean;
  /** Turns left for a public LLM id; null when unknown or unmetered. */
  turnsLeftFor: (id: string | null | undefined) => number | null;
  isUnlimited: (id: string | null | undefined) => boolean;
  /** Real API: the first answer is still loading. */
  loading: boolean;
}

/** DeepSeek public LLMs (D-012 amendment); the server's `unlimited` flag is authoritative in real mode. */
const MOCK_UNMETERED = new Set(['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);

/** List token prices (USD per token) of each public LLM's cheapest route, from the gateway listing. */
const MOCK_PRICES: Record<string, TokenPrice> = {
  'deepseek-v4.1-flash': { prompt: 0.000000075, completion: 0.0000003 },
  'deepseek-v4.1-flash-1017': { prompt: 0.00000015, completion: 0.0000006 },
  'claude-sonnet-5.5': { prompt: 0.000002, completion: 0.00001 },
  'claude-haiku-5.5': { prompt: 0.0000001, completion: 0.0000005 },
  'claude-opus-5.5': { prompt: 0.000004, completion: 0.00002 },
  'gpt-6-astra': { prompt: 0.00001, completion: 0.00005 },
  'gpt-6.1-sol': { prompt: 0.000002, completion: 0.00001 },
  'grok-4.6': { prompt: 0.000002, completion: 0.000006 },
  'glm-5.3': { prompt: 0.0000014, completion: 0.0000044 },
};

function mockUsedUsd(): number {
  const seam = (globalThis as { __rollingMocks?: { agentAllowance?: { usedUsd?: number } } }).__rollingMocks?.agentAllowance;
  return typeof seam?.usedUsd === 'number' ? seam.usedUsd : 0;
}

export function mockAgentAllowance(plan: PlanId | null, now = Date.now(), seats = 1): AgentAllowance {
  // Team grows by $3 per extra seat (D-013).
  const allowanceUsd = plan ? planAgentAllowanceUsd(plan, seats) : 0;
  const usedUsd = mockUsedUsd();
  return {
    plan,
    allowanceUsd,
    usedUsd,
    resetsAt: agentAllowancePeriod(now, null).resetsAt,
    models: PUBLIC_CHAT_MODELS.map((m) => {
      if (MOCK_UNMETERED.has(m.id)) return { id: m.id, name: m.name, unlimited: true, estTurnUsd: null, turnsLeft: null };
      const est = defaultTurnEstimateUsd(MOCK_PRICES[m.id] ?? null);
      return { id: m.id, name: m.name, unlimited: false, estTurnUsd: est, turnsLeft: turnsLeft(allowanceUsd, usedUsd, est) };
    }),
  };
}

/** Normalizes the server view (older responses have no `unlimited` flag). */
export function fromAllowanceView(v: AllowanceView): AgentAllowance {
  return {
    plan: v.plan,
    allowanceUsd: v.allowanceUsd,
    usedUsd: v.usedUsd,
    resetsAt: v.resetsAt,
    models: v.models.map((m) =>
      m.unlimited
        ? { id: m.id, name: m.name, unlimited: true, estTurnUsd: null, turnsLeft: null }
        : { id: m.id, name: m.name, unlimited: false, estTurnUsd: m.estTurnUsd, turnsLeft: m.turnsLeft },
    ),
  };
}

export function withHelpers(a: AgentAllowance, loading = false): AgentAllowanceState {
  const byId = new Map(a.models.map((m) => [m.id, m]));
  const metered = a.models.filter((m) => !m.unlimited);
  return {
    ...a,
    loading,
    exhausted: !!a.plan && metered.length > 0 && metered.every((m) => m.turnsLeft === 0),
    turnsLeftFor: (id) => (id ? (byId.get(id)?.turnsLeft ?? null) : null),
    isUnlimited: (id) => !!id && byId.get(id)?.unlimited === true,
  };
}

/** `GET /api/agent/allowance`; non-members get null (NO_PLAN). */
async function fetchAllowance(): Promise<AllowanceView | null> {
  try {
    return await api.get<AllowanceView>('/agent/allowance');
  } catch (e) {
    if (isApiError(e, 'NO_PLAN') || isApiError(e, 'UNAUTHENTICATED')) return null;
    throw e;
  }
}

export function useAgentAllowance(): AgentAllowanceState {
  const { planId, seats, isMember, workspace } = useSession();
  const real = !isMockApi();
  const q = useQuery({
    queryKey: [...ALLOWANCE_KEY, workspace?.id ?? null],
    queryFn: fetchAllowance,
    enabled: real && isMember,
    staleTime: 60_000,
  });
  return useMemo(() => {
    if (!real) return withHelpers(mockAgentAllowance(planId, Date.now(), seats));
    if (q.data) return withHelpers(fromAllowanceView(q.data));
    return withHelpers({ plan: planId, allowanceUsd: 0, usedUsd: 0, resetsAt: agentAllowancePeriod(Date.now(), null).resetsAt, models: [] }, isMember && q.isPending);
  }, [real, planId, seats, isMember, q.data, q.isPending]);
}
