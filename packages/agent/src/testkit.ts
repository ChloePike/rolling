/**
 * In-memory ports and a scripted LLM for tests, evals and DO tests.
 * Not used in production paths.
 */
import type { Catalog, ChatEvent, ChatRequest, LlmProvider } from '@rolling/core';
import { catalogModelsPort } from './modelsPort';

export { catalogModelsPort };
import type { GraphState } from '@rolling/core/graph';
import type { PlanId } from '@rolling/core/pricing/config';
import type { Edl } from '@rolling/core/timeline';
import type { AccountSnapshot, AgentPorts, AssetItem, NamedItem, TemplateItem } from './ports';

export function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    plan: 'plus' as PlanId,
    balance: { plan: 800, purchased: 2000, held: 0 },
    confirmThreshold: 300,
    creationMode: 'simple',
    language: 'en',
    matureAllowed: false,
    ...overrides,
  };
}

export interface MemoryWorld {
  graphs: Map<string, { state: GraphState; assets: Record<string, string> }>;
  timelines: Map<string, { revision: number; edl: Edl }>;
  assets: AssetItem[];
  characters: NamedItem[];
  voices: NamedItem[];
  templates: TemplateItem[];
  account: AccountSnapshot;
}

export function memoryWorld(partial: Partial<MemoryWorld> = {}): MemoryWorld {
  return {
    graphs: new Map(),
    timelines: new Map(),
    assets: [],
    characters: [],
    voices: [],
    templates: [],
    account: account(),
    ...partial,
  };
}

export function memoryPorts(world: MemoryWorld, catalog: Catalog): AgentPorts {
  const words = (q: string) => q.toLowerCase().split(/\W+/).filter(Boolean);
  return {
    canvas: { getGraph: async (id) => world.graphs.get(id) ?? null },
    assets: {
      search: async ({ query, kind, scope, limit }) =>
        world.assets
          .filter((a) => (!kind || a.kind === kind) && (scope === 'all' || a.source === scope))
          .filter((a) => !query || words(query).some((w) => `${a.name} ${a.description ?? ''}`.toLowerCase().includes(w)))
          .slice(0, limit),
      resolve: async (ids) => world.assets.filter((a) => ids.includes(a.id)),
      characters: async () => world.characters,
      voices: async () => world.voices,
    },
    models: catalogModelsPort(catalog),
    account: { get: async () => world.account },
    templates: { search: async (q, limit) => world.templates.filter((t) => !q || words(q).some((w) => t.name.toLowerCase().includes(w))).slice(0, limit) },
    timeline: { get: async (id) => world.timelines.get(id) ?? null },
  };
}

// ---------------------------------------------------------------- scripted LLM

export interface ScriptedStep {
  text?: string;
  toolCalls?: { name: string; args: unknown; id?: string }[];
  /** Mid-stream error event (after the text). */
  error?: { code: string; message: string; retryable: boolean };
  /** Thrown before the stream starts. */
  throws?: { code: string; message: string; retryable: boolean };
  /** Wait before finishing (cancel tests); honors the request signal. */
  delayMs?: number;
  /** `costUsd` is the gateway's `usage.cost` (default null: not reported). */
  usage?: { promptTokens: number; completionTokens: number; costUsd?: number | null };
}

export type ScriptedReply = ScriptedStep | ((req: ChatRequest, callIndex: number) => ScriptedStep);

/** An LLM that answers each call with the next scripted step. Records requests. */
export class ScriptedLlm implements LlmProvider {
  readonly id = 'scripted';
  readonly requests: ChatRequest[] = [];
  constructor(private readonly steps: ScriptedReply[]) {}

  chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const index = this.requests.length;
    this.requests.push({ ...req, messages: [...req.messages] });
    const reply = this.steps[index] ?? { text: '' };
    const step = typeof reply === 'function' ? reply(req, index) : reply;
    return (async function* (): AsyncGenerator<ChatEvent> {
      if (step.throws) throw Object.assign(new Error(step.throws.message), step.throws);
      if (step.text) {
        // Stream in small pieces like a real provider.
        for (let i = 0; i < step.text.length; i += 16) yield { type: 'text', delta: step.text.slice(i, i + 16) };
      }
      if (step.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, step.delayMs);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (step.error) {
        yield { type: 'error', error: step.error };
        yield { type: 'done', id: null, finishReason: null };
        return;
      }
      for (const [i, c] of (step.toolCalls ?? []).entries()) {
        yield { type: 'tool_call', call: { id: c.id ?? `call_${index}_${i}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } };
      }
      const u = step.usage ?? { promptTokens: 1000, completionTokens: 100 };
      yield { type: 'usage', usage: { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.promptTokens + u.completionTokens, cachedTokens: 0, costUsd: u.costUsd ?? null } };
      yield { type: 'done', id: `cmpl_${index}`, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop' };
    })();
  }
}

/** Sequential ids for tests: `prop_test1`, `msg_test2`, ... */
export function testIds() {
  let n = 0;
  return (kind: 'proposal' | 'message') => `${kind === 'proposal' ? 'prop' : 'msg'}_test${++n}`;
}
