/**
 * The turn loop (docs/harness.md section 2):
 *
 *   user message → build context → LLM with tools (streaming)
 *     ├─ read tools: run, append results, loop
 *     ├─ propose tool: validate; valid → store, stream, end the turn;
 *     │                invalid → error back to the model (max 2 retries), then text only
 *     └─ text: streamed
 *   ends when the model stops calling tools, after a proposal, after 8 tool calls, or on cancel.
 */
import type { ChatMessage, ChatUsage, LlmProvider, ToolCall } from '@rolling/core';
import { buildContext, type ThreadState, type TurnInput } from './context';
import type { AccountSnapshot, AgentPorts } from './ports';
import { isProposeTool, runPropose } from './proposals';
import { resolveAgentLlm, supportsReasoningNone, temperatureFor } from './routing';
import { noopTelemetry, type AgentTelemetry } from './telemetry';
import { getTool, runReadTool, toolDefinition, toolsFor, type ToolContext } from './tools';
import { truncateToTokens } from './tokens';
import type { AgentEvent, Proposal, ThreadMessage, TurnEndReason } from './types';

export const MAX_TOOL_CALLS = 8;
export const MAX_PROPOSAL_RETRIES = 2;
/** Max tokens of one tool result sent back to the model. */
export const MAX_TOOL_RESULT_TOKENS = 3_000;
const MAX_OUTPUT_TOKENS = 4_000;

export interface RunTurnOptions {
  llm: LlmProvider;
  ports: AgentPorts;
  thread: ThreadState;
  input: TurnInput;
  turnId: string;
  /** Public LLM id chosen by the user (D-009); default DeepSeek V4.1 Flash. */
  llmId?: string | null;
  /** Account snapshot; read from `ports.account` when absent. */
  account?: AccountSnapshot;
  newId: (kind: 'proposal' | 'message') => string;
  now?: () => number;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
  telemetry?: AgentTelemetry;
  workspaceId?: string;
  maxToolCalls?: number;
  maxProposalRetries?: number;
}

export interface ToolTraceEntry {
  name: string;
  ok: boolean;
  error?: string;
  /** Raw arguments of a failed propose call (first 4000 chars), for evals and logs. */
  args?: string;
}

export interface TurnResult {
  turnId: string;
  text: string;
  proposal: Proposal | null;
  reason: TurnEndReason;
  error: { code: string; message: string } | null;
  usage: { promptTokens: number; completionTokens: number; costUsd: number | null };
  contextTokens: number;
  toolCalls: number;
  llmCalls: number;
  retries: number;
  latencyMs: number;
  llm: { publicId: string; gatewayId: string };
  userMessage: ThreadMessage;
  assistantMessage: ThreadMessage;
  trace: ToolTraceEntry[];
}

class Canceled extends Error {}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'arguments are not valid JSON' };
  }
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const emit = opts.emit ?? (() => {});
  const telemetry = opts.telemetry ?? noopTelemetry;
  const maxToolCalls = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxRetries = opts.maxProposalRetries ?? MAX_PROPOSAL_RETRIES;
  const { thread, input, turnId } = opts;
  const base = { threadId: thread.threadId, turnId };

  const account = opts.account ?? (await opts.ports.account.get());
  const llm = resolveAgentLlm(opts.llmId, opts.ports.models.chatModels(), { mature: account.matureAllowed });
  const tools = toolsFor(thread.surface);
  const defs = tools.map(toolDefinition);
  const ctx = await buildContext({ thread, input, account, ports: opts.ports, tools: defs });
  const toolCtx: ToolContext = { ports: opts.ports, account, thread: { projectId: thread.projectId, canvasId: thread.canvasId, surface: thread.surface } };
  const temperature = temperatureFor(thread.surface, input.text, thread.skill);

  const messages: ChatMessage[] = [...ctx.messages];
  const usage = { promptTokens: 0, completionTokens: 0, costUsd: null as number | null };
  const trace: ToolTraceEntry[] = [];
  let text = '';
  let proposal: Proposal | null = null;
  let reason: TurnEndReason = 'completed';
  let error: TurnResult['error'] = null;
  let toolCalls = 0;
  let llmCalls = 0;
  let retries = 0;
  let textOnly = false;

  const addUsage = (u: ChatUsage) => {
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    if (u.costUsd !== null) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
  };

  /** One streamed LLM call. Retries once when it fails before producing anything. */
  const call = async (): Promise<{ text: string; toolCalls: ToolCall[] }> => {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Canceled();
      llmCalls++;
      let callText = '';
      const calls: ToolCall[] = [];
      let failure: { code: string; message: string; retryable: boolean } | null = null;
      try {
        for await (const ev of opts.llm.chat({
          model: llm.gatewayId,
          messages,
          tools: defs,
          toolChoice: textOnly ? 'none' : 'auto',
          parallelToolCalls: false,
          temperature,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(supportsReasoningNone(llm.gatewayId) ? { reasoningEffort: 'none' as const } : {}),
          mature: account.matureAllowed,
          idempotencyKey: `${turnId}:${llmCalls}`,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })) {
          if (opts.signal?.aborted) throw new Canceled();
          if (ev.type === 'text') {
            if (!callText && text && !/\s$/.test(text)) {
              // Separate replies of consecutive calls in one turn.
              text += '\n\n';
              emit({ type: 'agent.delta', ...base, delta: '\n\n' });
            }
            callText += ev.delta;
            text += ev.delta;
            emit({ type: 'agent.delta', ...base, delta: ev.delta });
          } else if (ev.type === 'tool_call') {
            calls.push(ev.call);
          } else if (ev.type === 'usage') {
            addUsage(ev.usage);
          } else if (ev.type === 'error') {
            failure = ev.error;
          }
        }
      } catch (err) {
        if (err instanceof Canceled || opts.signal?.aborted) throw new Canceled();
        const e = err as { code?: string; message?: string; retryable?: boolean };
        failure = { code: e.code ?? 'llm_error', message: e.message ?? String(err), retryable: e.retryable ?? true };
      }
      if (!failure) return { text: callText, toolCalls: calls };
      if (attempt === 0 && failure.retryable && !callText && !calls.length) continue;
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
  };

  try {
    for (;;) {
      const res = await call();
      if (!res.toolCalls.length || textOnly) {
        if (textOnly && reason === 'completed') reason = 'max_tool_calls';
        break;
      }
      messages.push({ role: 'assistant', content: res.text || null, toolCalls: res.toolCalls });
      let proposedThisResponse = false;
      for (const tc of res.toolCalls) {
        if (opts.signal?.aborted) throw new Canceled();
        const reply = (value: unknown) =>
          messages.push({ role: 'tool', toolCallId: tc.id, content: truncateToTokens(JSON.stringify(value), MAX_TOOL_RESULT_TOKENS) });
        if (proposal || proposedThisResponse) {
          reply({ error: 'one proposal per turn; this call was skipped' });
          continue;
        }
        if (toolCalls >= maxToolCalls) {
          reply({ error: `tool call limit (${maxToolCalls}) reached for this turn; answer in text` });
          continue;
        }
        toolCalls++;
        const tool = getTool(tc.name);
        if (!tool || !tool.surfaces.includes(thread.surface)) {
          trace.push({ name: tc.name, ok: false, error: 'unknown tool' });
          reply({ error: `tool ${tc.name} is not available here` });
          continue;
        }
        emit({ type: 'agent.tool', ...base, name: tool.name, status: 'started' });
        const args = parseArgs(tc.arguments);
        if (!args.ok) {
          trace.push({ name: tool.name, ok: false, error: args.error });
          emit({ type: 'agent.tool', ...base, name: tool.name, status: 'error', error: args.error });
          if (tool.kind === 'propose') retries++;
          reply({ error: args.error });
          if (tool.kind === 'propose' && retries > maxRetries) textOnly = true;
          continue;
        }
        if (tool.kind === 'read') {
          const result = await runReadTool(tool, args.value, toolCtx);
          const err = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : undefined;
          trace.push({ name: tool.name, ok: !err, ...(err ? { error: err } : {}) });
          emit({ type: 'agent.tool', ...base, name: tool.name, status: err ? 'error' : 'ok', ...(err ? { error: err } : {}) });
          reply(result);
          continue;
        }
        // Propose tool.
        proposedThisResponse = true;
        if (!isProposeTool(tool.name)) continue;
        const result = await runPropose(tool.name, args.value, {
          ...toolCtx,
          newId: () => opts.newId('proposal'),
          now,
          refs: ctx.refs,
          userText: input.text,
        });
        if (result.ok) {
          proposal = result.proposal;
          reason = 'proposal';
          trace.push({ name: tool.name, ok: true });
          emit({ type: 'agent.tool', ...base, name: tool.name, status: 'ok' });
          emit({ type: 'proposal.created', ...base, proposal });
          reply({ ok: true, proposalId: proposal.id, estimate: proposal.estimate.credits });
          continue;
        }
        retries++;
        trace.push({ name: tool.name, ok: false, error: result.error, args: tc.arguments.slice(0, 4000) });
        emit({ type: 'agent.tool', ...base, name: tool.name, status: 'error', error: result.error });
        if (retries > maxRetries) {
          textOnly = true;
          reason = 'invalid_proposal';
          reply({ error: result.error, instruction: 'Do not call propose tools again this turn. Explain the problem to the user in one or two sentences.' });
        } else {
          reply({ error: result.error, instruction: 'Fix the input and call the propose tool again.' });
          proposedThisResponse = false;
        }
      }
      if (proposal) break;
      if (toolCalls >= maxToolCalls && !textOnly) {
        textOnly = true;
        reason = 'max_tool_calls';
      }
    }
  } catch (err) {
    if (err instanceof Canceled || opts.signal?.aborted) {
      reason = 'canceled';
      proposal = null;
    } else {
      reason = 'error';
      const e = err as { code?: string; message?: string };
      error = { code: e.code ?? 'llm_error', message: e.message ?? String(err) };
      emit({ type: 'agent.error', ...base, code: error.code, message: error.message });
    }
  }

  if (reason === 'proposal' && proposal && !text.trim()) {
    text = proposal.summary;
    emit({ type: 'agent.delta', ...base, delta: text });
  }

  const finished = now();
  const userMessage: ThreadMessage = { id: opts.newId('message'), role: 'user', content: input.text, createdAt: started };
  const assistantMessage: ThreadMessage = {
    id: opts.newId('message'),
    role: 'assistant',
    content: text,
    createdAt: finished,
    ...(proposal ? { proposalId: proposal.id } : {}),
  };
  emit({ type: 'agent.done', ...base, messageId: assistantMessage.id, reason, proposalId: proposal?.id ?? null });
  const result: TurnResult = {
    turnId,
    text,
    proposal,
    reason,
    error,
    usage,
    contextTokens: ctx.tokens,
    toolCalls,
    llmCalls,
    retries,
    latencyMs: finished - started,
    llm: { publicId: llm.publicId, gatewayId: llm.gatewayId },
    userMessage,
    assistantMessage,
    trace,
  };
  telemetry.turn({
    threadId: thread.threadId,
    turnId,
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    surface: thread.surface,
    skill: thread.skill,
    llm: llm.publicId,
    tokensIn: usage.promptTokens,
    tokensOut: usage.completionTokens,
    contextTokens: ctx.tokens,
    costUsd: usage.costUsd,
    toolCalls,
    llmCalls,
    retries,
    latencyMs: result.latencyMs,
    reason,
    proposalKind: proposal?.kind ?? null,
  });
  return result;
}
