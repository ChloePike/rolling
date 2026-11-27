/**
 * Model gateway access for the generation pipeline (D-002). Provider-specific
 * code stays in `@rolling/core/models/providers/hyperouter`; this file only
 * builds clients from Worker config.
 */
import {
  hyperouter,
  type CatalogModel,
  type GenerationProvider,
  type ModelGateway,
} from "@rolling/core";
import { countsAsOutage } from "@rolling/core/ops/breaker";
import { recordGatewayFailure, recordGatewaySuccess } from "../ops/breaker";
import { llmClassifier, type Classify } from "@rolling/core/generation";
import { newId } from "@rolling/core/ids";
import { loadCatalog } from "../models/catalog";

let fetchOverride: typeof fetch | null = null;

/** Tests: route every gateway call (and output downloads) through a fake fetch. */
export function setGatewayFetchForTests(fn: typeof fetch | null): void {
  fetchOverride = fn;
}

/** Fetch used for gateway calls and output downloads. */
export function gatewayFetch(): typeof fetch {
  return fetchOverride ?? ((input, init) => fetch(input, init));
}

export function gatewayConfigured(env: Env): boolean {
  return !!env.HYPEROUTER_API_KEY || fetchOverride !== null;
}

export function hyperouterClient(env: Env): hyperouter.HyperouterClient {
  const apiKey = env.HYPEROUTER_API_KEY ?? (fetchOverride ? "sk-hr-test" : undefined);
  if (!apiKey) throw new Error("HYPEROUTER_API_KEY is not set.");
  // The var carries `/v1`; client paths include it.
  const baseUrl = (env.HYPEROUTER_BASE_URL || hyperouter.HYPEROUTER_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  return new hyperouter.HyperouterClient({ apiKey, baseUrl, fetch: gatewayFetch() });
}

/** The model gateway (D-002: Hyperouter only). A second gateway would be chosen here (D-030). */
export function modelGateway(env: Env): ModelGateway {
  return new hyperouter.HyperouterGateway(hyperouterClient(env), env.HYPEROUTER_WEBHOOK_SECRET);
}

/**
 * Generation provider of the gateway, reporting to the circuit breaker (D-030): 5xx, timeouts and
 * network errors on submit and status count toward opening it; answers close a half-open breaker.
 * Fail-fast while open happens in `submitJob` (before the provider is called).
 */
export function generationProvider(env: Env, model: CatalogModel): GenerationProvider {
  const gateway = modelGateway(env);
  const inner = gateway.generation(model);
  const observe = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      await recordGatewaySuccess(env, gateway.id);
      return out;
    } catch (err) {
      const status = gateway.errorStatus(err);
      if (status !== null && countsAsOutage(status)) await recordGatewayFailure(env, `${status}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`, gateway.id);
      throw err;
    }
  };
  const wrapped: GenerationProvider = {
    id: inner.id,
    kind: inner.kind,
    capabilities: inner.capabilities,
    submit: (req, key) => observe(() => inner.submit(req, key)),
    status: (externalId) => observe(() => inner.status(externalId)),
  };
  if (inner.verifyWebhook) wrapped.verifyWebhook = (req) => inner.verifyWebhook!(req);
  return wrapped;
}

/**
 * The Auto classifier (D-009): DeepSeek V4.1 Flash over the core chat adapter.
 * Members only (it is free to them, D-007); null when the gateway is not configured.
 */
export async function autoClassifier(env: Env, isMember: boolean): Promise<Classify | null> {
  if (!isMember || !gatewayConfigured(env)) return null;
  const chat = (await loadCatalog(env, "chat")).models;
  const llm = new hyperouter.HyperouterLlmProvider(hyperouterClient(env));
  return llmClassifier(llm, chat, () => `auto_${newId("event")}`);
}
