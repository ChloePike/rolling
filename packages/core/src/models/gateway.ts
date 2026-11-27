/**
 * The model gateway seam (D-030). Hyperouter is the only gateway (D-002);
 * this interface is what a second one would implement so routing, the
 * circuit breaker and the status probe stay gateway-agnostic. Implementations
 * live in `providers/<gateway>/gateway.ts`; nothing outside them knows a
 * gateway's URLs, headers or error shapes.
 */
import type { CatalogModel, GenerationProvider, LlmProvider } from './types';

export interface GatewayHealth {
  ok: boolean;
  /** HTTP status of the probe (0 for network failures). */
  status: number;
  latencyMs: number;
  detail: string | null;
}

export interface ModelGateway {
  /** Stable id, also the breaker key (`hyperouter`). */
  readonly id: string;
  generation(model: CatalogModel): GenerationProvider;
  llm(): LlmProvider;
  /** A free probe: lists models, never creates a job or spends. */
  health(timeoutMs?: number): Promise<GatewayHealth>;
  /**
   * The HTTP status behind a gateway error (0 for network failures), or null
   * when the error did not come from this gateway. The breaker counts 0, 408 and 5xx.
   */
  errorStatus(err: unknown): number | null;
}
