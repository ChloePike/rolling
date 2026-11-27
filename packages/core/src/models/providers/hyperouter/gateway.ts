import type { GatewayHealth, ModelGateway } from '../../gateway';
import type { CatalogModel, GenerationProvider, LlmProvider } from '../../types';
import { HyperouterLlmProvider } from './chat';
import { HyperouterClient, HyperouterError } from './client';
import { createHyperouterGenerationProvider } from './provider';
import { HYPEROUTER_PATHS } from './config';

/** Hyperouter as a `ModelGateway` (D-002, D-030). */
export class HyperouterGateway implements ModelGateway {
  readonly id = 'hyperouter';

  constructor(
    private readonly client: HyperouterClient,
    private readonly webhookSecret?: string,
  ) {}

  generation(model: CatalogModel): GenerationProvider {
    return createHyperouterGenerationProvider(model, this.client, this.webhookSecret);
  }

  llm(): LlmProvider {
    return new HyperouterLlmProvider(this.client);
  }

  /** `GET /v1/models`: the free listing the catalog sync also reads. */
  async health(timeoutMs = 5000): Promise<GatewayHealth> {
    const started = this.client.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.client.raw(HYPEROUTER_PATHS.models, { signal: ctrl.signal });
      await res.body?.cancel();
      return { ok: res.ok, status: res.status, latencyMs: this.client.now() - started, detail: res.ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { ok: false, status: aborted ? 408 : 0, latencyMs: this.client.now() - started, detail: aborted ? 'timeout' : err instanceof Error ? err.message.slice(0, 200) : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  errorStatus(err: unknown): number | null {
    if (err instanceof HyperouterError) return err.status;
    if (err instanceof Error && err.name === 'AbortError') return 408;
    return null;
  }
}
