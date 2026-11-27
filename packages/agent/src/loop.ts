/**
 * The turn loop (docs/harness.md section 2):
 *
 *   user message → build context → LLM with tools (streaming)
 *     ├─ read tools: run, append results, loop
 *     ├─ propose tool: validate; valid → store, stream, end the turn;
 *     │                invalid → error back to the model (max 2 retries), then text only
 *     └─ text: streamed
 *   ends when the model stops calling tools, after a proposal, after 8 tool calls, or on cancel.
 *
 * Modes (D-021, `./modes.ts`): Read offers and accepts read tools only; Edit is the
 * loop above; Auto applies valid graph/timeline patches and plans through `opts.auto`
 * (up to `AUTO_LIMITS`) and keeps going, and `run.start` starts runs within the turn's
 * budget (a run over it is surfaced for approval, not started).
 */
import { AgentCostMeter, tokenPrice, type ChatMessage, type ChatUsage, type LlmProvider, type ToolCall } from '@rolling/core';
import { SAFETY_BLOCKED_MESSAGE, type ReferenceSource, type SafetyReference } from '@rolling/core/safety';
import { explicitSignal } from '@rolling/core/safety/rules';
import { buildContext, type ThreadState, type TurnInput } from './context';
import type { AccountSnapshot, AgentPorts } from './ports';
import { AUTO_LIMITS, DEFAULT_AGENT_MODE, TurnBudget, type AgentMode } from './modes';
import { decodeJsonStrings, isProposeTool, runPropose } from './proposals';
import { resolveAgentLlm, supportsReasoningNone, temperatureFor } from './routing';
import { noopTelemetry, type AgentTelemetry } from './telemetry';
import { getTool, runReadTool, toolDefinition, toolsFor, type ToolContext } from './tools';
import { issueText, RunStartInput } from './tools/schemas';
import { truncateToTokens } from './tokens';
import type { AgentEvent, AutoChange, AutoRun, AutoTurnSummary, Proposal, ThreadMessage, TurnEndReason } from './types';

export const MAX_TOOL_CALLS = 8;
export const MAX_PROPOSAL_RETRIES = 2;
/** Max tokens of one tool result sent back to the model. */
export const MAX_TOOL_RESULT_TOKENS = 3_000;
/** A 60-second plan of two options is about 6k tokens of tool arguments; 4k cut such calls off mid-JSON. */
export const MAX_OUTPUT_TOKENS = 8_000;
/** Responses that came back cut off or empty and were asked for again, per turn. */
export const MAX_RESPONSE_REPAIRS = 2;

/**
 * What Auto mode (D-021) may do, wired by AgentSession: apply a validated proposal
 * through ProjectRoom as the user (agent attribution), quote runs and start a quoted
 * run (CreditAccount holds). The loop owns the turn budget; the agent never sees holds.
 */
export interface AutoPort {
  /** Credits this turn may start runs for (the user's Auto budget). */
  budget: number;
  apply(proposal: Proposal): Promise<{ ok: true; change: AutoChange; created?: { id: string; title: string; kind: string }[] } | { ok: false; error: string }>;
  quote(nodeIds: string[]): Promise<
    | { ok: true; quoteId: string | null; credits: number; available: number; nodeIds: string[]; blocked: string[] }
    | { ok: false; code: string; message: string }
  >;
  /**
   * `review` (D-024): the turn id, its budget and what is left after this run; the result review may retry a
   * bad output once per node within what the turn has left (`startRun` server options).
   */
  start(quoteId: string, review?: { budgetLeft: number; turnId: string; turnBudget: number }): Promise<{ ok: true; runId: string } | { ok: false; code: string; message: string }>;
}

/** Graph/timeline ops a proposal applies (a plan: its first option, which Auto builds). */
export function proposalOpCount(p: Proposal): number {
  switch (p.body.kind) {
    case 'graphPatch':
    case 'timelinePatch':
      return p.body.ops.length;
    case 'plan':
      return p.body.options[0]?.ops.length ?? 0;
    default:
      return 0;
  }
}

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
  /** D-021 mode; default Edit. Auto without `auto` runs as Edit. */
  mode?: AgentMode;
  auto?: AutoPort;
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
  /** The proposal left for the user, else (Auto) the last one applied. */
  proposal: Proposal | null;
  /** Every valid proposal of the turn, in order (Auto may apply several). */
  proposals: Proposal[];
  /** The mode the turn ran in. */
  mode: AgentMode;
  /** Auto turns: changes applied and runs asked for, against the budget. */
  auto: AutoTurnSummary | null;
  reason: TurnEndReason;
  error: { code: string; message: string } | null;
  /**
   * `costUsd`: sum of the gateway's `usage.cost` (null when none reported).
   * `chargedUsd`: what the turn costs the allowance (D-012): `usage.cost` per
   * response, else tokens × the gateway model's token price.
   */
  usage: { promptTokens: number; completionTokens: number; costUsd: number | null; chargedUsd: number };
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

function referenceSource(source: string): ReferenceSource {
  if (source === 'generated' || source === 'character' || source === 'public') return source;
  if (source === 'builtin') return 'public';
  return 'upload';
}

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
  const auto = (opts.mode ?? DEFAULT_AGENT_MODE) === 'auto' ? (opts.auto ?? null) : null;
  const mode: AgentMode = opts.mode === 'auto' && !auto ? 'edit' : (opts.mode ?? DEFAULT_AGENT_MODE);
  const budget = new TurnBudget(auto?.budget ?? 0);
  const tools = toolsFor(thread.surface, mode);
  // The tools offered this turn are the only ones that run: a Read turn refuses a propose call the model makes anyway.
  const allowed = new Set<string>(tools.map((t) => t.name));
  const defs = tools.map(toolDefinition);
  const ctx = await buildContext({ thread, input, account, ports: opts.ports, tools: defs, mode, ...(auto ? { budget: { total: budget.total, remaining: budget.remaining } } : {}) });
  const toolCtx: ToolContext = { ports: opts.ports, account, thread: { projectId: thread.projectId, canvasId: thread.canvasId, surface: thread.surface } };
  const temperature = temperatureFor(thread.surface, input.text, thread.skill);

  const messages: ChatMessage[] = [...ctx.messages];
  const usage = { promptTokens: 0, completionTokens: 0, costUsd: null as number | null, chargedUsd: 0 };
  const gatewayModel = opts.ports.models.chatModels().find((m) => m.id === llm.gatewayId);
  const price = gatewayModel ? tokenPrice(gatewayModel) : null;
  const meter = new AgentCostMeter();
  const trace: ToolTraceEntry[] = [];
  let text = '';
  let proposal: Proposal | null = null;
  const proposals: Proposal[] = [];
  let lastApplied: Proposal | null = null;
  let appliedCount = 0;
  let appliedOps = 0;
  let runCalls = 0;
  const autoSummary: AutoTurnSummary | null = auto ? { turnId, budget: budget.total, spent: 0, changes: [], runs: [] } : null;
  const emitAuto = () => {
    if (!autoSummary) return;
    autoSummary.spent = budget.spent;
    emit({ type: 'agent.auto', ...base, auto: { ...autoSummary, changes: [...autoSummary.changes], runs: [...autoSummary.runs] } });
  };
  /** Auto `run.start`: quote, then start within the budget or surface it for approval (never sees the holds). */
  const startRun = async (nodeIds: string[]): Promise<Record<string, unknown>> => {
    if (!auto || !autoSummary) return { status: 'refused', code: 'NOT_AUTO' };
    if (runCalls >= AUTO_LIMITS.maxRunsPerTurn) return { status: 'refused', code: 'RUN_LIMIT', note: `At most ${AUTO_LIMITS.maxRunsPerTurn} run.start calls per turn.` };
    runCalls++;
    const id = `${turnId}:run:${runCalls}`;
    const record = (r: Omit<AutoRun, 'id'>) => {
      autoSummary.runs.push({ id, ...r });
      emitAuto();
    };
    const q = await auto.quote(nodeIds);
    if (!q.ok) {
      record({ nodeIds, credits: 0, status: 'refused', code: q.code });
      return { status: 'refused', code: q.code, message: q.message };
    }
    if (q.blocked.length) {
      record({ nodeIds: q.nodeIds, credits: q.credits, status: 'refused', code: 'blocked' });
      return { status: 'refused', code: 'blocked', reasons: q.blocked, note: 'Some of these nodes cannot run; nothing was started.' };
    }
    const decision = q.quoteId ? budget.decide({ credits: q.credits, available: q.available }) : ({ action: 'refuse', code: 'NOTHING_TO_RUN' } as const);
    if (decision.action === 'refuse') {
      record({ nodeIds: q.nodeIds, credits: q.credits, status: 'refused', code: decision.code });
      return { status: 'refused', code: decision.code };
    }
    if (decision.action === 'approve') {
      record({ nodeIds: q.nodeIds, credits: q.credits, status: 'needs_approval' });
      return { status: 'needs_approval', credits: q.credits, budgetLeft: budget.remaining, note: "Not started: over this turn's budget. The user can approve it in the panel." };
    }
    const started = await auto.start(q.quoteId!, { budgetLeft: Math.max(0, budget.remaining - q.credits), turnId, turnBudget: budget.total });
    if (!started.ok) {
      record({ nodeIds: q.nodeIds, credits: q.credits, status: 'refused', code: started.code });
      return { status: 'refused', code: started.code, message: started.message };
    }
    budget.commit(q.credits);
    record({ nodeIds: q.nodeIds, credits: q.credits, status: 'started', runId: started.runId });
    return { status: 'started', runId: started.runId, credits: q.credits, budgetLeft: budget.remaining };
  };
  let reason: TurnEndReason = 'completed';
  let error: TurnResult['error'] = null;
  let toolCalls = 0;
  let llmCalls = 0;
  let retries = 0;
  let textOnly = false;
  let repairs = 0;
  /** After an empty response in a turn that already read something: the next call has to call a tool. */
  let forceTool = false;

  // D-005: the brief and its `@` references go through the safety gate first.
  let blocked = false;
  if (opts.ports.safety) {
    const references: SafetyReference[] = ctx.refs.map((r) => ({
      kind: r.kind,
      source: referenceSource(r.source),
      caption: [r.name, r.description].filter(Boolean).join(': '),
    }));
    try {
      const v = await opts.ports.safety.checkBrief({ text: input.text, references, mature: account.matureAllowed });
      blocked = v.verdict === 'block';
    } catch {
      // A gate failure on a mature turn fails closed.
      blocked = account.matureAllowed;
    }
  }

  const addUsage = (u: ChatUsage) => {
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    if (u.costUsd !== null) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
    meter.add('turn', u, price);
    usage.chargedUsd = meter.chargedUsd;
  };

  /** One streamed LLM call. Retries once when it fails before producing anything. */
  const call = async (): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string | null }> => {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Canceled();
      llmCalls++;
      let callText = '';
      const calls: ToolCall[] = [];
      let failure: { code: string; message: string; retryable: boolean } | null = null;
      let finishReason: string | null = null;
      // Text written ahead of a read tool is narration ("Checking the models"): it is never shown or stored. Text is
      // held until the call shows what it is: a read tool drops it, a propose tool or the end of the call shows it.
      let held = '';
      let narration = false;
      let shown = false;
      const show = (delta: string) => {
        if (!delta) return;
        if (!shown && text && !/\s$/.test(text)) {
          // Separate replies of consecutive calls in one turn.
          text += '\n\n';
          emit({ type: 'agent.delta', ...base, delta: '\n\n' });
        }
        shown = true;
        text += delta;
        emit({ type: 'agent.delta', ...base, delta });
      };
      const decide = (toolName: string) => {
        if (narration) return;
        if (getTool(toolName)?.kind === 'read') {
          narration = true;
          held = '';
        } else {
          show(held);
          held = '';
        }
      };
      try {
        for await (const ev of opts.llm.chat({
          model: llm.gatewayId,
          messages,
          tools: defs,
          toolChoice: textOnly ? 'none' : forceTool ? 'required' : 'auto',
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
            callText += ev.delta;
            if (textOnly) show(ev.delta);
            else held += ev.delta;
          } else if (ev.type === 'tool_call_delta') {
            if (ev.name) decide(ev.name);
          } else if (ev.type === 'tool_call') {
            decide(ev.call.name);
            calls.push(ev.call);
          } else if (ev.type === 'usage') {
            addUsage(ev.usage);
          } else if (ev.type === 'error') {
            failure = ev.error;
          } else if (ev.type === 'done') {
            finishReason = ev.finishReason;
          }
        }
      } catch (err) {
        if (err instanceof Canceled || opts.signal?.aborted) {
          // A stopped turn keeps what was written so far.
          if (!narration) show(held);
          throw new Canceled();
        }
        const e = err as { code?: string; message?: string; retryable?: boolean };
        failure = { code: e.code ?? 'llm_error', message: e.message ?? String(err), retryable: e.retryable ?? true };
      }
      if (!narration) show(held);
      held = '';
      if (!failure) return { text: narration ? '' : callText, toolCalls: calls, finishReason };
      if (attempt === 0 && failure.retryable && !callText && !calls.length) continue;
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
  };

  // D-005: adult content asked for by a caller without mature access. The gate lets the turn through so the reply
  // can say why in the user's language; nothing may be proposed (not a tamer version either), so it runs without tools.
  const matureOff = !blocked && !account.matureAllowed && explicitSignal(input.text).length > 0;
  if (matureOff) {
    textOnly = true;
    const system = messages[0];
    if (system?.role === 'system') {
      messages[0] = {
        ...system,
        content: `${system.content}\n\n# This turn\nThe brief asks for adult content and mature content is off for this account. Answer in one sentence, in the user's language: mature content is off for this account and can be turned on in Settings. Do not describe the scene and do not offer another version.`,
      };
    }
  }

  if (blocked) {
    reason = 'safety_blocked';
    text = SAFETY_BLOCKED_MESSAGE;
    emit({ type: 'agent.delta', ...base, delta: text });
  }

  try {
    for (; !blocked; ) {
      const res = await call();
      // A response cut off at the output limit carries no usable tool call, and now and then the model returns
      // nothing at all. Both would end the turn with an empty reply: ask once for a shorter or an actual answer.
      const cutOff = res.finishReason === 'length' && !res.toolCalls.length;
      const empty = !res.toolCalls.length && !res.text.trim() && !text.trim();
      if ((cutOff || empty) && !textOnly && repairs < MAX_RESPONSE_REPAIRS) {
        repairs++;
        retries++;
        // Seen live: after two read tools in one response the model sometimes answers with nothing, again and
        // again. It read in order to propose, so the next call must call a tool.
        forceTool = empty && !cutOff && toolCalls > 0;
        trace.push({ name: 'llm', ok: false, error: cutOff ? 'response cut off at the output limit' : 'empty response' });
        if (res.text) messages.push({ role: 'assistant', content: res.text });
        messages.push({
          role: 'user',
          content: cutOff
            ? '[system] Your last message was cut off at the output limit before the tool call was complete. Call the propose tool again with a shorter input: 2 options, and short texts in every field.'
            : '[system] Your last message was empty. Call the propose tool for the request above, or answer it in one or two sentences.',
        });
        continue;
      }
      forceTool = false;
      if (!res.toolCalls.length || textOnly) {
        if (textOnly && reason === 'completed' && !matureOff) reason = 'max_tool_calls';
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
        if (!tool || !allowed.has(tool.name)) {
          const known = !!tool && tool.surfaces.includes(thread.surface);
          trace.push({ name: tc.name, ok: false, error: known ? `not available in ${mode} mode` : 'unknown tool' });
          reply({ error: known ? `tool ${tc.name} is not available in ${mode} mode; nothing was changed` : `tool ${tc.name} is not available here` });
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
        if (tool.kind === 'run') {
          const parsed = RunStartInput.safeParse(decodeJsonStrings(args.value ?? {}));
          if (!parsed.success) {
            const error = `invalid input: ${issueText(parsed.error)}`;
            trace.push({ name: tool.name, ok: false, error });
            emit({ type: 'agent.tool', ...base, name: tool.name, status: 'error', error });
            reply({ error });
            continue;
          }
          const result = await startRun(parsed.data.nodeIds);
          const ok = result.status === 'started' || result.status === 'needs_approval';
          trace.push({ name: tool.name, ok, ...(ok ? {} : { error: String(result.code) }) });
          emit({ type: 'agent.tool', ...base, name: tool.name, status: ok ? 'ok' : 'error', ...(ok ? {} : { error: String(result.code) }) });
          reply(result);
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
          ...(input.settings ? { settings: input.settings } : {}),
        });
        if (result.ok) {
          const p = result.proposal;
          proposals.push(p);
          reason = 'proposal';
          trace.push({ name: tool.name, ok: true });
          emit({ type: 'agent.tool', ...base, name: tool.name, status: 'ok' });
          emit({ type: 'proposal.created', ...base, proposal: p });
          if (auto && autoSummary && p.kind !== 'fields') {
            const ops = proposalOpCount(p);
            const limit = appliedCount >= AUTO_LIMITS.maxAppliedPerTurn ? 'changes' : appliedOps + ops > AUTO_LIMITS.maxOpsPerTurn ? 'ops' : null;
            if (!limit) {
              const applied = await auto.apply(p);
              if (applied.ok) {
                appliedCount++;
                appliedOps += ops;
                p.status = 'applied';
                lastApplied = p;
                autoSummary.changes.push(applied.change);
                emitAuto();
                reply({ ok: true, applied: true, proposalId: p.id, revision: applied.change.revision, ...(applied.created?.length ? { nodes: applied.created } : {}), estimate: p.estimate.credits });
                // Auto keeps the turn going (a follow-up change or run.start).
                proposedThisResponse = false;
                continue;
              }
              proposal = p;
              reply({ ok: true, applied: false, proposalId: p.id, reason: applied.error, note: 'Not applied; it waits for the user to apply.' });
              continue;
            }
            proposal = p;
            reply({ ok: true, applied: false, proposalId: p.id, note: `Auto limit for this turn reached (${limit}); the user applies this one.` });
            continue;
          }
          proposal = p;
          reply({ ok: true, proposalId: p.id, estimate: p.estimate.credits });
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
      // Changes Auto already applied stay (each can be undone); an unapplied proposal is dropped.
      proposal = null;
    } else {
      reason = 'error';
      const e = err as { code?: string; message?: string };
      error = { code: e.code ?? 'llm_error', message: e.message ?? String(err) };
      emit({ type: 'agent.error', ...base, code: error.code, message: error.message });
    }
  }

  const shown = proposal ?? lastApplied;
  if (reason === 'proposal' && shown && !text.trim()) {
    text = shown.summary;
    emit({ type: 'agent.delta', ...base, delta: text });
  }

  const finished = now();
  const userMessage: ThreadMessage = { id: opts.newId('message'), role: 'user', content: input.text, createdAt: started };
  const assistantMessage: ThreadMessage = {
    id: opts.newId('message'),
    role: 'assistant',
    content: text,
    createdAt: finished,
    ...((proposal ?? lastApplied) ? { proposalId: (proposal ?? lastApplied)!.id } : {}),
  };
  if (autoSummary) autoSummary.spent = budget.spent;
  emit({ type: 'agent.done', ...base, messageId: assistantMessage.id, reason, proposalId: (proposal ?? lastApplied)?.id ?? null });
  const result: TurnResult = {
    turnId,
    text,
    proposal: proposal ?? lastApplied,
    proposals: reason === 'canceled' ? proposals.filter((p) => p.status === 'applied') : proposals,
    mode,
    auto: autoSummary,
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
    proposalKind: (proposal ?? lastApplied)?.kind ?? null,
  });
  return result;
}
