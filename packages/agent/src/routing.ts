/**
 * Agent LLM routing (D-009) and per-turn sampling settings (harness section 7).
 */
import { ChatModelUnavailableError, DEFAULT_CHAT_MODEL_ID, PUBLIC_CHAT_MODELS, resolveChatModel, type ListingModel } from '@rolling/core';
import type { Surface } from './types';

export const DEFAULT_AGENT_LLM = DEFAULT_CHAT_MODEL_ID; // 'deepseek-v4.1-flash'

export interface ResolvedLlm {
  /** Public id actually used (falls back to the default when the asked one is unavailable). */
  publicId: string;
  /** Gateway model id. Never sent to clients. */
  gatewayId: string;
  fellBack: boolean;
}

/**
 * Gateway model for the user's public LLM id. Unknown or unavailable ids fall
 * back to the default (DeepSeek V4.1 Flash); mature turns use the entry's
 * mature route when it has one (D-005).
 */
export function resolveAgentLlm(
  publicId: string | null | undefined,
  chatModels: readonly Pick<ListingModel, 'id' | 'price'>[],
  opts: { mature?: boolean } = {},
): ResolvedLlm {
  const wanted = publicId && PUBLIC_CHAT_MODELS.some((m) => m.id === publicId) ? publicId : DEFAULT_AGENT_LLM;
  try {
    return { publicId: wanted, gatewayId: resolveChatModel(wanted, chatModels, opts), fellBack: wanted !== publicId && !!publicId };
  } catch (err) {
    if (!(err instanceof ChatModelUnavailableError) || wanted === DEFAULT_AGENT_LLM) {
      // Nothing in the catalog (fresh environment): use the default gateway id directly.
      return { publicId: DEFAULT_AGENT_LLM, gatewayId: PUBLIC_CHAT_MODELS.find((m) => m.default)!.candidates[0]!, fellBack: wanted !== publicId };
    }
    return resolveAgentLlm(DEFAULT_AGENT_LLM, chatModels, opts);
  }
}

const WRITING = /\b(write|rewrite|script|story|dialogue|voice ?over|narration|lines?|copy|tagline|slogan|poem)\b|写|文案|台词|脚本|故事|セリフ|脚本|대본/i;
const EDITING = /\b(cut|trim|swap|move|lower|louder|quieter|shorter|longer|remove|delete|connect|change|make|set|replace|apply)\b/i;

/**
 * Temperature per harness section 7: 0.7 for script writing, 0.3 for planning
 * and patches. A turn counts as writing when the user asks for words and not
 * for an edit, or the skill is a writing one with no edit verb.
 */
export function temperatureFor(surface: Surface, text: string, skill?: string | null): number {
  if (surface === 'editor' || surface === 'tool') return 0.3;
  const writing = WRITING.test(text) || skill === 'storyboard' || skill === 'ai-comic';
  return writing && !EDITING.test(text) ? 0.7 : 0.3;
}

/** Gateway models known to accept `reasoning_effort: "none"`. */
export function supportsReasoningNone(gatewayId: string): boolean {
  return gatewayId.startsWith('deepseek/');
}
