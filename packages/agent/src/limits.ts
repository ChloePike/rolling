/**
 * Agent usage limits (D-012). The old per-day turn counts and premium-LLM
 * weights are gone: each plan has a monthly allowance in USD of gateway cost
 * (`AGENT_ALLOWANCE_USD`), held and settled per turn in the CreditAccount DO.
 * This module keeps the estimate helper the API and the client share.
 */
import { defaultTurnEstimateUsd, PUBLIC_CHAT_MODELS, tokenPrice, type ListingModel } from '@rolling/core';
import { resolveAgentLlm } from './routing';

/**
 * Default per-turn estimate (no history yet) for each public LLM: the resolved
 * gateway model's token prices × 10k prompt / 1.2k completion tokens.
 * Public ids only; gateway ids never leave the server.
 */
export function defaultTurnEstimates(chatModels: readonly Pick<ListingModel, 'id' | 'price'>[], opts: { mature?: boolean } = {}): { id: string; name: string; fallbackUsd: number }[] {
  const out: { id: string; name: string; fallbackUsd: number }[] = [];
  const ids = new Set(chatModels.map((m) => m.id));
  for (const entry of PUBLIC_CHAT_MODELS) {
    if (!entry.candidates.some((c) => ids.has(c))) continue;
    const resolved = resolveAgentLlm(entry.id, chatModels, opts);
    if (resolved.publicId !== entry.id) continue;
    const model = chatModels.find((m) => m.id === resolved.gatewayId);
    out.push({ id: entry.id, name: entry.name, fallbackUsd: defaultTurnEstimateUsd(model ? tokenPrice(model) : null) });
  }
  return out;
}

/** Default estimate for one public LLM (the default LLM's when it is unknown). */
export function defaultTurnEstimate(publicId: string, chatModels: readonly Pick<ListingModel, 'id' | 'price'>[], opts: { mature?: boolean } = {}): { publicId: string; fallbackUsd: number } {
  const resolved = resolveAgentLlm(publicId, chatModels, opts);
  const model = chatModels.find((m) => m.id === resolved.gatewayId);
  return { publicId: resolved.publicId, fallbackUsd: defaultTurnEstimateUsd(model ? tokenPrice(model) : null) };
}
