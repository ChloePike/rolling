import { agentAllowancePeriod, defaultTurnEstimateUsd, turnsLeft, type TokenPrice } from '@rolling/core/pricing/agent';
import { PUBLIC_CHAT_MODELS } from '@rolling/core/models/chat';
import { planAgentAllowanceUsd, type PlanId } from '@rolling/core/pricing/config';
import { useMemo } from 'react';
import { useSession } from './index';

/**
 * Monthly agent allowance (D-012): USD of gateway cost per plan, shown as
 * "~N turns left" per agent LLM in the pickers.
 *
 * Mock until wiring: computed from the same constants the API uses
 * (`planAgentAllowanceUsd`, default turn = 10k prompt + 1.2k completion
 * tokens at list price). The real source is `GET /api/agent/allowance` plus
 * the `agent.allowance` message on the user socket; both carry this shape.
 *
 * Test seam: `window.__rollingMocks.agentAllowance = { usedUsd }`.
 */
export interface AgentAllowanceModel {
  /** Public LLM id (never a gateway id). */
  id: string;
  name: string;
  estTurnUsd: number;
  turnsLeft: number;
}

export interface AgentAllowance {
  plan: PlanId | null;
  allowanceUsd: number;
  usedUsd: number;
  /** Epoch ms of the next reset. */
  resetsAt: number;
  models: AgentAllowanceModel[];
}

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
      const est = defaultTurnEstimateUsd(MOCK_PRICES[m.id] ?? null);
      return { id: m.id, name: m.name, estTurnUsd: est, turnsLeft: turnsLeft(allowanceUsd, usedUsd, est) };
    }),
  };
}

export function useAgentAllowance(): AgentAllowance & { exhausted: boolean; turnsLeftFor: (id: string | null | undefined) => number | null } {
  const { planId, seats } = useSession();
  return useMemo(() => {
    const a = mockAgentAllowance(planId, Date.now(), seats);
    const byId = new Map(a.models.map((m) => [m.id, m]));
    // Exhausted: not even the cheapest model fits one more turn.
    const exhausted = !!planId && a.models.every((m) => m.turnsLeft === 0);
    return { ...a, exhausted, turnsLeftFor: (id) => (id ? (byId.get(id)?.turnsLeft ?? null) : null) };
  }, [planId, seats]);
}
