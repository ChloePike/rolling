/**
 * Public agent LLMs (owner decision, D-009). Users pick from this fixed list;
 * each entry routes to a gateway model at request time:
 *
 * - `candidates`: interchangeable gateway variants; the cheapest one that is
 *   currently in the synced catalog wins (live token prices).
 * - `matureRoute`: gateway model used instead when the turn is mature (D-005),
 *   if it is available.
 *
 * Gateway ids never reach the client; the client only sees the public id.
 */
import type { ListingModel } from './types';

export interface PublicChatModel {
  /** Stable public id sent by clients. */
  id: string;
  name: string;
  /** Gateway ids; the cheapest available one is used. */
  candidates: readonly string[];
  /** Gateway id for mature turns (D-005). */
  matureRoute?: string;
  /** The default agent LLM. Exactly one. */
  default?: boolean;
}

export const PUBLIC_CHAT_MODELS: readonly PublicChatModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    candidates: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-us'],
    default: true,
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    candidates: ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017-us'],
    matureRoute: 'deepseek/deepseek-v4.1-flash-cyber',
  },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', candidates: ['anthropic/claude-sonnet-5.5'] },
  { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', candidates: ['anthropic/claude-haiku-5.5'] },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', candidates: ['anthropic/claude-opus-5.5'] },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', candidates: ['openai/gpt-6-astra'] },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', candidates: ['openai/gpt-6.1-sol'] },
  { id: 'grok-4.6', name: 'Grok 4.6', candidates: ['x-ai/grok-4.6'] },
  { id: 'glm-5.3', name: 'GLM 5.3', candidates: ['z-ai/glm-5.3'] },
];

export const DEFAULT_CHAT_MODEL_ID = PUBLIC_CHAT_MODELS.find((m) => m.default)!.id;

/** USD per token for prompt and completion, from the listing's price meters. */
export function tokenPrice(model: Pick<ListingModel, 'price'>): { prompt: number; completion: number } | null {
  const usd = (meter: string) => model.price.find((p) => p.meter === meter && Object.keys(p.conditions).length === 0)?.usd;
  const prompt = usd('prompt');
  const completion = usd('completion');
  return prompt === undefined || completion === undefined ? null : { prompt, completion };
}

/**
 * Cost weight for comparing variants: agent turns are input-heavy (context
 * ~24k tokens, replies ~1–2k), so prompt price counts ten times completion.
 */
function turnWeight(model: Pick<ListingModel, 'price'>): number {
  const p = tokenPrice(model);
  return p ? p.prompt * 10 + p.completion : Number.POSITIVE_INFINITY;
}

export class ChatModelUnavailableError extends Error {
  override readonly name = 'ChatModelUnavailableError';
  constructor(readonly publicId: string) {
    super(`No gateway model is available for ${publicId}.`);
  }
}

/** Public entries that have at least one available candidate. */
export function availableChatModels(available: readonly Pick<ListingModel, 'id'>[]): PublicChatModel[] {
  const ids = new Set(available.map((m) => m.id));
  return PUBLIC_CHAT_MODELS.filter((m) => m.candidates.some((c) => ids.has(c)));
}

/**
 * Gateway model for a public chat id. Mature turns use `matureRoute` when it is
 * available; otherwise the cheapest available candidate (ties keep list order).
 */
export function resolveChatModel(
  publicId: string,
  available: readonly Pick<ListingModel, 'id' | 'price'>[],
  opts: { mature?: boolean } = {},
): string {
  const entry = PUBLIC_CHAT_MODELS.find((m) => m.id === publicId);
  if (!entry) throw new ChatModelUnavailableError(publicId);
  const byId = new Map(available.map((m) => [m.id, m]));
  if (opts.mature && entry.matureRoute && byId.has(entry.matureRoute)) return entry.matureRoute;
  let best: { id: string; weight: number } | null = null;
  for (const id of entry.candidates) {
    const model = byId.get(id);
    if (!model) continue;
    const weight = turnWeight(model);
    if (!best || weight < best.weight) best = { id, weight };
  }
  if (!best) throw new ChatModelUnavailableError(publicId);
  return best.id;
}
