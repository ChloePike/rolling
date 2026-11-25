/**
 * Agent allowance (D-012) on the API side: the period from the subscription,
 * the CreditAccount agent ledger, and the client view
 * (`GET /api/agent/allowance`, WS `agent.allowance`). Public LLM ids only.
 * DeepSeek public LLMs are unmetered (D-012 amendment) and listed as `{ unlimited: true }`.
 */
import { defaultTurnEstimates } from "@rolling/agent";
import { agentAllowancePeriod, isUnmeteredAgentLlm, planAgentAllowanceUsd, turnsLeft, type ListingModel, type PlanId } from "@rolling/core";
import type { AgentPeriodInput } from "@rolling/core/credits";
import { creditAccount } from "../billing/credits";
import { latestSubscription } from "../billing/stripe";
import { loadCatalog } from "../models/catalog";

export type AllowanceModelView =
  | { id: string; name: string; unlimited: false; estTurnUsd: number; turnsLeft: number }
  /** DeepSeek public LLMs do not draw on the allowance (D-012 amendment); a per-user abuse limit applies. */
  | { id: string; name: string; unlimited: true };

export interface AllowanceView {
  plan: PlanId | null;
  allowanceUsd: number;
  /** Settled cost this period plus turns in flight. */
  usedUsd: number;
  resetsAt: number;
  models: AllowanceModelView[];
}

/** Allowance (plan, Team by seats) and period for a workspace (`current_period_start` monthly slices, else the UTC calendar month). */
export async function allowancePeriod(env: Env, workspaceId: string, plan: PlanId | null, now = Date.now()): Promise<AgentPeriodInput> {
  const sub = await latestSubscription(env, workspaceId).catch(() => null);
  const { start, resetsAt } = agentAllowancePeriod(now, sub?.current_period_start ?? null);
  return { allowanceUsd: plan ? planAgentAllowanceUsd(plan, sub?.seats ?? 1) : 0, periodStart: start, resetsAt };
}

export async function chatModelsOf(env: Env): Promise<ListingModel[]> {
  return (await loadCatalog(env, null)).models.filter((m) => m.kind === "chat");
}

export async function allowanceView(env: Env, input: { workspaceId: string; plan: PlanId | null; mature: boolean; chatModels?: readonly Pick<ListingModel, "id" | "price">[]; period?: AgentPeriodInput }): Promise<AllowanceView> {
  const period = input.period ?? (await allowancePeriod(env, input.workspaceId, input.plan));
  const chat = input.chatModels ?? (await chatModelsOf(env));
  const all = defaultTurnEstimates(chat, { mature: input.mature });
  const defaults = all.filter((d) => !isUnmeteredAgentLlm(d.id));
  const stub = creditAccount(env, input.workspaceId) as unknown as {
    agentUsage(i: AgentPeriodInput & { models: { id: string; fallbackUsd: number }[] }): Promise<{ usedUsd: number; heldUsd: number; estimates: Record<string, number> }>;
  };
  const usage = await stub.agentUsage({ ...period, models: defaults.map((d) => ({ id: d.id, fallbackUsd: d.fallbackUsd })) });
  const used = round6(usage.usedUsd + usage.heldUsd);
  return {
    plan: input.plan,
    allowanceUsd: period.allowanceUsd,
    usedUsd: used,
    resetsAt: period.resetsAt,
    models: all.map((d): AllowanceModelView => {
      if (isUnmeteredAgentLlm(d.id)) return { id: d.id, name: d.name, unlimited: true };
      const est = usage.estimates[d.id] ?? d.fallbackUsd;
      return { id: d.id, name: d.name, unlimited: false, estTurnUsd: round6(est), turnsLeft: turnsLeft(period.allowanceUsd, used, est) };
    }),
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
