import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { AllowanceView } from '@/lib/api/types';

/**
 * D-039: before Home makes a project for an agent brief, the server says whether this
 * workspace may use the agent at all (`GET /api/agent/allowance` answers `NO_PLAN`
 * without a plan or an active trial, D-007), and for a trial (D-022) whether the
 * picked agent model and the trial's agent allowance allow a turn. The upgrade
 * modal then opens on Home, before any navigation, and the brief is kept.
 */
export type AgentGate = 'ok' | 'join' | 'trial-agent';

/** The decision for an allowance view (`null` = NO_PLAN). Pure; unit tested. */
export function gateFromAllowance(view: (AllowanceView & { trial?: boolean }) | null, llm: string | null): AgentGate {
  if (!view) return 'join';
  if (!view.trial) return 'ok';
  // A trial plans with its one model only, within its own allowance (the server enforces the same).
  if (llm && !view.models.some((m) => m.id === llm)) return 'trial-agent';
  if (view.usedUsd >= view.allowanceUsd) return 'trial-agent';
  return 'ok';
}

/** Asks the server. Anything but `NO_PLAN` lets the brief through: the canvas panel handles a later refusal. */
export async function agentGate(llm: string | null): Promise<AgentGate> {
  try {
    return gateFromAllowance(await api.get<AllowanceView & { trial?: boolean }>('/agent/allowance'), llm);
  } catch (e) {
    if (isApiError(e, 'NO_PLAN')) return 'join';
    return 'ok';
  }
}
