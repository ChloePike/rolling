import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../types';
import { buildChatBody, chatEventsFromStream, HyperouterLlmProvider } from '../chat';
import { HyperouterError } from '../client';
import { parseSse } from '../sse';
import { errorJson, mockFetch, streamOf } from './mock-fetch';

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('parseSse', () => {
  it('handles comments, CRLF, multi-line data and lines split across chunks', async () => {
    const events = [];
    for await (const ev of parseSse(streamOf([': processing\r\n\r\nda', 'ta: a\r', '\ndata: b\n', '\nevent: x\ndata: c\n\n', 'data: tail']))) {
      events.push(ev);
    }
    expect(events.map((e) => e.data)).toEqual(['a\nb', 'c', 'tail']);
    expect(events[1]!.event).toBe('x');
  });
});

describe('chatEventsFromStream', () => {
  it('assembles a tool call split across chunks, then reports usage', async () => {
    const body = [
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] }),
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: { content: 'check.' } }] }),
      chunk({
        id: 'cmpl_1',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'pricing.estimate', arguments: '' } }] },
          },
        ],
      }),
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"model":"see' } }] } }] }),
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'dance-2.5","sec' } }] } }] }),
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'onds":10}' } }] } }] }),
      chunk({ id: 'cmpl_1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      chunk({
        id: 'cmpl_1',
        provider: 'DeepSeek',
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 64 }, cost: 0.0000362 },
      }),
      'data: [DONE]\n\n',
    ].join('');
    // Re-split the whole body at awkward places (every 7 bytes).
    const pieces = body.match(/[\s\S]{1,7}/g)!;
    const events = await collect(chatEventsFromStream(streamOf(pieces)));

    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Let me check.');
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toEqual([
      { type: 'tool_call', call: { id: 'call_a', name: 'pricing.estimate', arguments: '{"model":"seedance-2.5","seconds":10}' } },
    ]);
    expect(JSON.parse((calls[0] as { call: { arguments: string } }).call.arguments)).toEqual({ model: 'seedance-2.5', seconds: 10 });
    expect(events.filter((e) => e.type === 'tool_call_delta').length).toBe(4);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      provider: 'DeepSeek',
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 64, costUsd: 0.0000362 },
    });
    expect(events.at(-1)).toEqual({ type: 'done', id: 'cmpl_1', finishReason: 'tool_calls' });
  });

  it('assembles parallel tool calls by index', async () => {
    const events = await collect(
      chatEventsFromStream(
        streamOf([
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{"y"' } }] } }] }),
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] } }] }),
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] } }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call)).toEqual([
      { id: 'c1', name: 'a', arguments: '{}' },
      { id: 'c2', name: 'b', arguments: '{"y":1}' },
    ]);
  });

  it('turns a mid-stream error into an error event and drops partial tool calls', async () => {
    const events = await collect(
      chatEventsFromStream(
        streamOf([
          chunk({ id: 'cmpl_2', choices: [{ index: 0, delta: { content: 'Hel' } }] }),
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{"a"' } }] } }] }),
          chunk({ error: { code: 'upstream_error', message: 'Provider failed mid-stream.', type: 'upstream_error' } }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      error: { code: 'upstream_error', message: 'Provider failed mid-stream.', retryable: true },
    });
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', id: 'cmpl_2' });
  });

  it('reports a truncated stream (no [DONE])', async () => {
    const events = await collect(chatEventsFromStream(streamOf([chunk({ choices: [{ index: 0, delta: { content: 'x' } }] })])));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ error: { code: 'stream_truncated', retryable: true } });
  });
});

describe('HyperouterLlmProvider', () => {
  it('posts a streaming request with tools and idempotency key', async () => {
    const { client, calls } = mockFetch([
      new Response(streamOf([chunk({ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]);
    const llm = new HyperouterLlmProvider(client);
    const events = await collect(
      llm.chat({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'pricing.estimate', description: 'Estimate credits', parameters: { type: 'object', properties: {} } }],
        temperature: 0.3,
        idempotencyKey: 'msg_01',
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(calls[0]!.headers['idempotency-key']).toBe('msg_01');
    expect(calls[0]!.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      stream: true,
      stream_options: { include_usage: true },
      moderation: 'auto',
      temperature: 0.3,
      tools: [{ type: 'function', function: { name: 'pricing__estimate' } }],
    });
  });

  it('sends dotted tool names wire-safe and maps them back', async () => {
    const { client, calls } = mockFetch([
      new Response(
        streamOf([
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'pricing__estimate', arguments: '{}' } }] } }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
        { status: 200 },
      ),
    ]);
    const events = await collect(
      new HyperouterLlmProvider(client).chat({
        messages: [{ role: 'user', content: 'cost?' }],
        tools: [{ name: 'pricing.estimate', description: 'd', parameters: { type: 'object' } }],
        toolChoice: { name: 'pricing.estimate' },
        idempotencyKey: 'msg_03',
      }),
    );
    expect(calls[0]!.body).toMatchObject({ tool_choice: { type: 'function', function: { name: 'pricing__estimate' } } });
    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      call: { id: 'c1', name: 'pricing.estimate', arguments: '{}' },
    });
    expect(events.find((e) => e.type === 'tool_call_delta')).toMatchObject({ name: 'pricing.estimate' });
  });

  it('throws HyperouterError for request-level failures', async () => {
    const { client } = mockFetch([
      errorJson(409, { code: 'idempotency_key_replayed', generation_id: 'gen_9' }, { 'x-should-retry': 'false' }),
    ]);
    const llm = new HyperouterLlmProvider(client);
    const err = await collect(llm.chat({ messages: [{ role: 'user', content: 'hi' }], idempotencyKey: 'msg_02' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HyperouterError);
    expect(err).toMatchObject({ code: 'idempotency_key_replayed', generationId: 'gen_9', retryable: false });
  });

  it('maps assistant tool calls and tool results to the wire format', () => {
    const body = buildChatBody({
      idempotencyKey: 'k',
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: '{"credits":16}' },
      ],
      toolChoice: { name: 'a' },
      responseFormat: { type: 'json_object' },
    });
    expect(body.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"credits":16}' },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'a' } });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});
