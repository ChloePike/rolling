/**
 * Thread summary (harness section 4): messages older than the verbatim window
 * are folded into the thread's `summary`, refreshed every 10 turns.
 */
import { responseCostUsd, type LlmProvider, type TokenPrice } from '@rolling/core';
import { SUMMARY_EVERY_TURNS, VERBATIM_MESSAGES } from './context';
import { truncateToTokens } from './tokens';
import type { ThreadMessage } from './types';

export const SUMMARY_MAX_TOKENS = 600;

/** Due after every 10th turn once there are messages outside the verbatim window. */
export function summaryDue(turnCount: number, messageCount: number): boolean {
  return turnCount > 0 && turnCount % SUMMARY_EVERY_TURNS === 0 && messageCount > VERBATIM_MESSAGES;
}

/** Messages the summary covers: everything before the verbatim window. */
export function messagesToSummarize(messages: readonly ThreadMessage[]): ThreadMessage[] {
  return messages.slice(0, Math.max(0, messages.length - VERBATIM_MESSAGES));
}

/** Used when the LLM call fails: the previous summary plus the first line of each message. */
export function fallbackSummary(previous: string, older: readonly ThreadMessage[]): string {
  const lines = older.map((m) => `- ${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`);
  return truncateToTokens([previous, ...lines].filter(Boolean).join('\n'), SUMMARY_MAX_TOKENS);
}

export async function summarizeThread(args: {
  llm: LlmProvider;
  model: string;
  previous: string;
  older: readonly ThreadMessage[];
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Token price of `model`, for the cost fallback when the gateway reports none (D-012). */
  price?: TokenPrice | null;
}): Promise<{ summary: string; tokensIn: number; tokensOut: number; costUsd: number }> {
  const transcript = args.older.map((m) => `${m.role}: ${m.content}`).join('\n');
  let out = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  try {
    for await (const ev of args.llm.chat({
      model: args.model,
      messages: [
        {
          role: 'system',
          content:
            'Summarize this conversation between a user and a video planning assistant in at most 12 short bullet points. Keep: the brief, decisions, chosen options, models, lengths, ratios, budgets, proposals applied or discarded, open questions. Same language as the conversation. No commentary.',
        },
        { role: 'user', content: truncateToTokens(`${args.previous ? `Earlier summary:\n${args.previous}\n\n` : ''}${transcript}`, 12_000) },
      ],
      temperature: 0.3,
      maxTokens: SUMMARY_MAX_TOKENS,
      idempotencyKey: args.idempotencyKey,
      ...(args.signal ? { signal: args.signal } : {}),
    })) {
      if (ev.type === 'text') out += ev.delta;
      else if (ev.type === 'usage') {
        tokensIn += ev.usage.promptTokens;
        tokensOut += ev.usage.completionTokens;
        costUsd += responseCostUsd(ev.usage, args.price ?? null);
      } else if (ev.type === 'error') throw new Error(ev.error.message);
    }
  } catch {
    return { summary: fallbackSummary(args.previous, args.older), tokensIn, tokensOut, costUsd };
  }
  return { summary: out.trim() ? truncateToTokens(out.trim(), SUMMARY_MAX_TOKENS) : fallbackSummary(args.previous, args.older), tokensIn, tokensOut, costUsd };
}
