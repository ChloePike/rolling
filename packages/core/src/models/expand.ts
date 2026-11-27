/**
 * Gateway prompt expansion ("Enhance prompt", D-020). Hyperouter rewrites the
 * prompt with a chat model (the writer) before the render, on models whose
 * listing has `prompt_expand`, for creates only. This module picks the writer
 * and bounds what the rewrite can cost; the request fields are set by the
 * provider adapter (`./providers/hyperouter`).
 *
 * Writers (owner decision, D-020):
 * - non-mature runs: DeepSeek V4.1 Flash, the cheapest route of it in the catalog;
 * - mature runs (D-005): `x-ai/grok-4.7`, else `x-ai/grok-4.6`;
 * - none of them in the synced catalog: the gateway's default writer (`null`,
 *   priced at `x-ai/grok-4.6`).
 */
import { PROMPT_EXPANSION_DEFAULT_WRITER_PRICE, PROMPT_EXPANSION_TOKENS } from '../pricing/config';
import { resolveChatModel, tokenPrice, ChatModelUnavailableError } from './chat';
import type { GenerationMode, ListingModel } from './types';

/** The gateway's writer when `prompt_expand_model` is not sent. */
export const DEFAULT_EXPANSION_WRITER = 'x-ai/grok-4.6';
/** Public chat entry whose cheapest route writes non-mature rewrites. */
export const EXPANSION_WRITER_PUBLIC_ID = 'deepseek-v4.1-flash';
/** Mature writers, in order of preference. */
export const MATURE_EXPANSION_WRITERS: readonly string[] = ['x-ai/grok-4.7', 'x-ai/grok-4.6'];

/** Modes that create a new picture or clip from a prompt (the gateway refuses expansion on edits of a video, swaps and the like). */
export const PROMPT_EXPAND_MODES: ReadonlySet<GenerationMode> = new Set<GenerationMode>(['t2i', 'edit', 't2v', 'i2v', 'first_last_frame', 'refs']);

/** The model takes `prompt_expand` for this mode. */
export function takesPromptExpand(model: Pick<ListingModel, 'kind' | 'params'>, mode: GenerationMode): boolean {
  return model.kind !== 'chat' && model.params.promptExpand && PROMPT_EXPAND_MODES.has(mode);
}

/** The writer for a run: a gateway chat id, or null for the gateway's default. */
export function expansionWriter(chat: readonly Pick<ListingModel, 'id' | 'kind' | 'price'>[], opts: { mature: boolean }): string | null {
  const available = chat.filter((m) => m.kind === 'chat');
  if (opts.mature) return MATURE_EXPANSION_WRITERS.find((id) => available.some((m) => m.id === id)) ?? null;
  try {
    return resolveChatModel(EXPANSION_WRITER_PUBLIC_ID, available);
  } catch (err) {
    if (err instanceof ChatModelUnavailableError) return null;
    throw err;
  }
}

export interface ExpansionSize {
  /** Characters of the prompt sent. */
  promptChars: number;
  /** Input pictures sent with the request (the writer may read them). */
  pictures?: number;
}

/** Most a rewrite by `writer` (null = the gateway default) can cost, in USD. */
export function promptExpansionMaxUsd(
  chat: readonly Pick<ListingModel, 'id' | 'price'>[],
  writer: string | null,
  size: ExpansionSize,
): number {
  const id = writer ?? DEFAULT_EXPANSION_WRITER;
  const model = chat.find((m) => m.id === id);
  const price = (model && tokenPrice(model)) ?? PROMPT_EXPANSION_DEFAULT_WRITER_PRICE;
  const t = PROMPT_EXPANSION_TOKENS;
  const input = t.instructions + Math.max(0, size.promptChars) + Math.min(t.maxPictures, Math.max(0, size.pictures ?? 0)) * t.perPicture;
  return Math.round((input * price.prompt + t.output * price.completion) * 1e9) / 1e9;
}

/** What a spec carries when the user asked for expansion: the writer, its most, and the spoken-lines language. */
export interface PromptExpansion {
  writer: string | null;
  maxUsd: number;
  locale?: string;
}

/** Expansion plan for one run (writer by mature routing, cost bound by prompt size). */
export function planPromptExpansion(
  chat: readonly Pick<ListingModel, 'id' | 'kind' | 'price'>[],
  opts: { mature: boolean; locale?: string } & ExpansionSize,
): PromptExpansion {
  const writer = expansionWriter(chat, { mature: opts.mature });
  return {
    writer,
    maxUsd: promptExpansionMaxUsd(chat, writer, opts),
    ...(opts.locale && { locale: opts.locale }),
  };
}
