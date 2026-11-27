import type { ChatEvent, ChatMessage, ChatRequest, ChatUsage, LlmProvider, ToolCall } from '../../types';
import { errorFromResponse, HyperouterClient, isRetryable } from './client';
import { HYPEROUTER_MODEL_IDS, HYPEROUTER_PATHS, type HyperouterConfig } from './config';
import { parseSse } from './sse';

/**
 * D-005: whether the agent chat model may be sent `moderation: "low"` for mature
 * threads. Not confirmed with the provider, so mature threads use `auto`.
 */
const CHAT_MODEL_MATURE = false;

interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  id?: string;
  provider?: string;
  choices?: {
    index?: number;
    delta?: { role?: string; content?: string | null; reasoning_content?: string | null; tool_calls?: WireToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    cost?: number | null;
  } | null;
  error?: { code?: string | null; message?: string | null; type?: string | null };
}

/**
 * Function names on the wire must match `^[a-zA-Z0-9_-]{1,64}$`: the spike showed
 * DeepSeek providers refuse `pricing.estimate` with 400 invalid_body. Our tool
 * names keep their dots; dots travel as `__` and are mapped back on the way in.
 */
const WIRE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function toWireToolName(name: string): string {
  const wire = name.replace(/\./g, '__');
  if (!WIRE_TOOL_NAME_RE.test(wire)) throw new TypeError(`Tool name cannot be sent to the model: ${name}`);
  return wire;
}

/** Map of wire name → our name for the request's tools. */
export function toolNameMap(req: Pick<ChatRequest, 'tools'>): Map<string, string> {
  return new Map((req.tools ?? []).map((t) => [toWireToolName(t.name), t.name]));
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      return {
        role: 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? p : { type: 'image_url', image_url: { url: p.imageUrl } })),
      };
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: toWireToolName(c.name), arguments: c.arguments },
        }));
      }
      return out;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Builds the `/v1/chat/completions` streaming body. */
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model ?? HYPEROUTER_MODEL_IDS.chat.agent,
    messages: req.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
    moderation: req.mature && CHAT_MODEL_MATURE ? 'low' : 'auto',
  };
  if (req.fallbackModels?.length) body.models = req.fallbackModels.slice(0, 5);
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: toWireToolName(t.name), description: t.description, parameters: t.parameters },
    }));
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice =
      typeof req.toolChoice === 'string'
        ? req.toolChoice
        : { type: 'function', function: { name: toWireToolName(req.toolChoice.name) } };
  }
  if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens;
  if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
  if (req.responseFormat) {
    body.response_format =
      req.responseFormat.type === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: true } };
  }
  // Model-specific fields (e.g. `crop_heads` for `lumina/face-detect`); never overrides a mapped field.
  for (const [k, v] of Object.entries(req.extra ?? {})) if (!(k in body)) body[k] = v;
  return body;
}

function toUsage(u: NonNullable<WireChunk['usage']>): ChatUsage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: typeof u.cost === 'number' ? u.cost : null,
  };
}

/**
 * Turns an OpenAI-format chat completion SSE stream into ChatEvents. Tool-call
 * fragments are assembled by `index` and emitted as complete `tool_call`
 * events when the choice finishes (or at `[DONE]`). A mid-stream
 * `data: {"error": ...}` becomes an `error` event; partial tool calls are dropped.
 */
export async function* chatEventsFromStream(
  stream: ReadableStream<Uint8Array>,
  /** Wire tool name → our tool name (see `toolNameMap`). */
  toolNames: Map<string, string> = new Map(),
): AsyncGenerator<ChatEvent> {
  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  let completionId: string | null = null;
  let finishReason: string | null = null;
  let failed = false;
  let sawDone = false;

  function* flushToolCalls(): Generator<ChatEvent> {
    const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    pending.clear();
    for (const [index, c] of ordered) {
      const call: ToolCall = { id: c.id || `call_${index}`, name: toolNames.get(c.name) ?? c.name, arguments: c.arguments };
      yield { type: 'tool_call', call };
    }
  }

  for await (const ev of parseSse(stream)) {
    if (ev.data === '[DONE]') {
      sawDone = true;
      break;
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(ev.data) as WireChunk;
    } catch {
      continue; // Ignore non-JSON lines.
    }
    if (chunk.error) {
      failed = true;
      pending.clear();
      const code = chunk.error.code ?? 'upstream_error';
      yield {
        type: 'error',
        error: { code, message: chunk.error.message ?? 'The stream failed.', retryable: isRetryable(503, code, null) },
      };
      continue;
    }
    if (chunk.id) completionId = chunk.id;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.reasoning_content) yield { type: 'reasoning', delta: delta.reasoning_content };
      if (delta?.content) yield { type: 'text', delta: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const entry = pending.get(index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        const argumentsDelta = tc.function?.arguments ?? '';
        entry.arguments += argumentsDelta;
        pending.set(index, entry);
        yield {
          type: 'tool_call_delta',
          index,
          ...(tc.id ? { id: tc.id } : {}),
          ...(tc.function?.name ? { name: toolNames.get(tc.function.name) ?? tc.function.name } : {}),
          argumentsDelta,
        };
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        yield* flushToolCalls();
      }
    }
    if (chunk.usage) {
      yield { type: 'usage', usage: toUsage(chunk.usage), ...(chunk.provider ? { provider: chunk.provider } : {}) };
    }
  }

  if (!failed) {
    if (!sawDone) {
      pending.clear();
      yield {
        type: 'error',
        error: { code: 'stream_truncated', message: 'The stream ended before [DONE].', retryable: true },
      };
    } else {
      yield* flushToolCalls();
    }
  }
  yield { type: 'done', id: completionId, finishReason };
}

/**
 * Streams a chat completion. Request-level failures (HTTP status before the
 * stream starts) throw HyperouterError; failures inside the stream arrive as
 * `error` events followed by `done`.
 */
export async function* streamChat(client: HyperouterClient, req: ChatRequest): AsyncGenerator<ChatEvent> {
  const body = buildChatBody(req);
  const res = await client.raw(HYPEROUTER_PATHS.chatCompletions, {
    method: 'POST',
    body,
    idempotencyKey: req.idempotencyKey,
    headers: { accept: 'text/event-stream' },
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) throw await errorFromResponse(res, client.now());
  if (!res.body) throw new Error('Chat response has no body.');
  yield* chatEventsFromStream(res.body, toolNameMap(req));
}

export class HyperouterLlmProvider implements LlmProvider {
  readonly id = 'hyperouter';
  private readonly client: HyperouterClient;

  constructor(configOrClient: HyperouterConfig | HyperouterClient) {
    this.client = configOrClient instanceof HyperouterClient ? configOrClient : new HyperouterClient(configOrClient);
  }

  chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    return streamChat(this.client, req);
  }
}
