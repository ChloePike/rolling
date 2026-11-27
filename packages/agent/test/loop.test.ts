import { describe, expect, it } from 'vitest';
import { runTurn, type RunTurnOptions } from '../src/loop';
import { MemoryTelemetry } from '../src/telemetry';
import { ScriptedLlm, testIds, type ScriptedReply } from '../src/testkit';
import type { AgentEvent } from '../src/types';
import type { ThreadState } from '../src/context';
import { evalPorts, evalWorld, PROJECT_ID, PRODUCT_PHOTO } from '../evals/world';

function thread(over: Partial<ThreadState> = {}): ThreadState {
  return { threadId: 'thr_t', surface: 'home', skill: 'tv-ad', projectId: null, canvasId: null, summary: '', messages: [], proposals: [], ...over };
}

const plan = {
  seconds: 15,
  options: [
    { title: 'Riverside', ratio: '9:16', shots: [{ title: 'Hook', seconds: 7, visual: 'Bottle on a rock', model: 'bytedance/seedance-2.5' }, { title: 'Logo', seconds: 8, visual: 'Logo', model: 'bytedance/seedance-2.5' }] },
    { title: 'Kitchen', ratio: '9:16', shots: [{ title: 'Pour', seconds: 15, visual: 'Pour', model: 'bytedance/seedance-2.0-mini' }] },
  ],
};

async function turn(steps: ScriptedReply[], over: Partial<RunTurnOptions> = {}) {
  const llm = new ScriptedLlm(steps);
  const events: AgentEvent[] = [];
  const telemetry = new MemoryTelemetry();
  const world = evalWorld();
  const result = await runTurn({
    llm,
    ports: evalPorts(world),
    thread: thread(),
    input: { text: '15-second vertical ad for a sparkling water', refs: [PRODUCT_PHOTO.id], selection: [] },
    turnId: 'turn_1',
    newId: testIds(),
    emit: (e) => events.push(e),
    telemetry,
    ...over,
  });
  return { result, llm, events, telemetry };
}

describe('runTurn', () => {
  it('runs read tools, then stores one proposal and ends the turn', async () => {
    const { result, llm, events, telemetry } = await turn([
      { text: 'Checking models. ', toolCalls: [{ name: 'models.capabilities', args: { kind: 'video' } }] },
      { text: 'Here are two options.', toolCalls: [{ name: 'propose.plan', args: plan }] },
      { text: 'never reached' },
    ]);
    expect(result.reason).toBe('proposal');
    expect(result.proposal?.kind).toBe('plan');
    expect(result.toolCalls).toBe(2);
    expect(result.llmCalls).toBe(2);
    expect(llm.requests).toHaveLength(2);
    // Text written ahead of a read tool is narration: never shown, stored or sent back to the model.
    expect(result.text).toBe('Here are two options.');
    expect(events.filter((e) => e.type === 'agent.delta').map((e) => (e as { delta: string }).delta).join('')).toBe('Here are two options.');
    expect(llm.requests[1]!.messages.find((m) => m.role === 'assistant')).toMatchObject({ content: null });
    expect(result.assistantMessage.proposalId).toBe(result.proposal!.id);
    // Second request carries the read tool result.
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg && JSON.parse(toolMsg.content).models.length).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent.delta', 'agent.tool', 'proposal.created', 'agent.done']));
    expect(events.at(-1)).toMatchObject({ type: 'agent.done', reason: 'proposal' });
    expect(telemetry.turns[0]).toMatchObject({ reason: 'proposal', proposalKind: 'plan', toolCalls: 2, tokensIn: 2000 });
  });

  it('sends DeepSeek with temperature 0.3, reasoning none and dotted tool names', async () => {
    const { llm } = await turn([{ text: 'Hi.' }]);
    const req = llm.requests[0]!;
    expect(req.model).toMatch(/^deepseek\/deepseek-v4\.1-flash(-us)?$/);
    expect(req.temperature).toBe(0.3);
    expect(req.reasoningEffort).toBe('none');
    expect(req.tools?.map((t) => t.name)).toContain('propose.plan');
    expect(req.tools?.map((t) => t.name)).not.toContain('propose.graphPatch');
  });

  it('returns validation errors to the model and accepts a fixed retry', async () => {
    const bad = { seconds: 15, options: [{ title: 'A', ratio: '16:9', shots: [{ title: 'x', seconds: 3, visual: 'v', model: 'bytedance/seedance-2.5' }] }, plan.options[1]] };
    const { result, llm } = await turn([{ toolCalls: [{ name: 'propose.plan', args: bad }] }, { toolCalls: [{ name: 'propose.plan', args: plan }] }]);
    expect(result.reason).toBe('proposal');
    expect(result.retries).toBe(1);
    const err = llm.requests[1]!.messages.at(-1)!;
    expect(err.role).toBe('tool');
    expect((err as { content: string }).content).toContain('from 4 to 15');
  });

  it('after 2 retries it stops proposing and explains in text', async () => {
    const bad = { options: [{ title: 'A', ratio: '16:9', shots: [{ title: 'x', seconds: 99, visual: 'v', model: 'nope' }] }] };
    const { result, llm } = await turn([
      { toolCalls: [{ name: 'propose.plan', args: bad }] },
      { toolCalls: [{ name: 'propose.plan', args: bad }] },
      { toolCalls: [{ name: 'propose.plan', args: bad }] },
      { text: 'I could not build a valid plan.' },
    ]);
    expect(result.reason).toBe('invalid_proposal');
    expect(result.proposal).toBeNull();
    expect(result.retries).toBe(3);
    expect(llm.requests[3]!.toolChoice).toBe('none');
    expect(result.text).toBe('I could not build a valid plan.');
  });

  it('caps tool calls at 8 and finishes with a text-only call', async () => {
    const read = { toolCalls: [{ name: 'account.get', args: {} }] };
    const { result, llm } = await turn([read, read, read, read, read, read, read, read, { text: 'Done reading.' }]);
    expect(result.toolCalls).toBe(8);
    expect(result.reason).toBe('max_tool_calls');
    expect(llm.requests.at(-1)!.toolChoice).toBe('none');
    expect(result.text).toBe('Done reading.');
  });

  it('allows one proposal per turn', async () => {
    const { result, llm } = await turn([
      { toolCalls: [{ name: 'propose.plan', args: plan }, { name: 'propose.plan', args: plan }] },
    ]);
    expect(result.reason).toBe('proposal');
    expect(llm.requests).toHaveLength(1);
    expect(result.trace.filter((t) => t.name === 'propose.plan')).toHaveLength(1);
  });

  it('cancel keeps partial text and creates no proposal', async () => {
    const controller = new AbortController();
    const p = turn([{ text: 'Partial answer', delayMs: 2_000, toolCalls: [{ name: 'propose.plan', args: plan }] }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const { result, events } = await p;
    expect(result.reason).toBe('canceled');
    expect(result.proposal).toBeNull();
    expect(result.text).toBe('Partial answer');
    expect(events.some((e) => e.type === 'proposal.created')).toBe(false);
  });

  it('retries a call that fails before streaming, then reports errors', async () => {
    const ok = await turn([{ throws: { code: 'upstream_error', message: 'boom', retryable: true } }, { text: 'Recovered.' }]);
    expect(ok.result.reason).toBe('completed');
    expect(ok.result.text).toBe('Recovered.');
    const failed = await turn([{ error: { code: 'upstream_error', message: 'boom', retryable: true } }, { error: { code: 'upstream_error', message: 'boom', retryable: true } }]);
    expect(failed.result.reason).toBe('error');
    expect(failed.events.some((e) => e.type === 'agent.error')).toBe(true);
  });

  it('answers unknown tools and bad JSON with errors instead of crashing', async () => {
    const { result, llm } = await turn([
      { toolCalls: [{ name: 'runs.start', args: {} }, { name: 'account.get', args: '{nope' }] },
      { text: 'ok' },
    ]);
    expect(result.reason).toBe('completed');
    const tools = llm.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
    expect(tools[0]).toContain('not available');
    expect(tools[1]).toContain('not valid JSON');
  });

  it('only offers project tools on the canvas and uses the user LLM choice', async () => {
    const world = evalWorld();
    const { llm } = await turn([{ text: 'ok' }], { ports: evalPorts(world), thread: thread({ surface: 'canvas', projectId: PROJECT_ID }), llmId: 'claude-haiku-5.5' });
    const req = llm.requests[0]!;
    expect(req.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(['canvas.get', 'propose.graphPatch']));
    expect(req.model).toBe('anthropic/claude-haiku-5.5');
    expect(req.reasoningEffort).toBeUndefined();
  });
});

describe('responses that are cut off or empty', () => {
  it('asks once for a shorter call when the output limit cut the tool call off', async () => {
    const cut = (): ScriptedReply => () => ({ text: '' });
    const llm = new ScriptedLlm([cut(), { text: 'Two options.', toolCalls: [{ name: 'propose.plan', args: plan }] }]);
    // The scripted LLM reports `stop`; a cut-off response reports `length` with no tool call.
    const original = llm.chat.bind(llm);
    let n = 0;
    llm.chat = (req) => {
      const first = n++ === 0;
      const inner = original(req);
      return (async function* () {
        for await (const ev of inner) yield first && ev.type === 'done' ? { ...ev, finishReason: 'length' } : ev;
      })();
    };
    const result = await runTurn({ llm, ports: evalPorts(evalWorld()), thread: thread(), input: { text: 'A 15 second ad', refs: [], selection: [] }, turnId: 't', newId: testIds() });
    expect(result.reason).toBe('proposal');
    expect(result.trace[0]).toMatchObject({ name: 'llm', ok: false, error: 'response cut off at the output limit' });
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/cut off at the output limit/);
    expect(llm.requests[0]!.maxTokens).toBe(8000);
  });

  it('asks again after an empty response, twice at most, then ends the turn', async () => {
    const { result, llm } = await turn([{ text: '' }, { text: '' }, { text: '' }, { text: 'never reached' }]);
    expect(llm.requests).toHaveLength(3);
    expect(result.reason).toBe('completed');
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/Your last message was empty/);
  });

  it('D-005: adult content with mature content off runs without tools and proposes nothing', async () => {
    const { result, llm } = await turn([{ text: 'Mature content is off for this account; it can be turned on in Settings.', toolCalls: [{ name: 'propose.plan', args: plan }] }], {
      input: { text: 'A 10 second explicit sex scene between two fictional adults.', refs: [], selection: [] },
    });
    expect(llm.requests[0]!.toolChoice).toBe('none');
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/# This turn\nThe brief asks for adult content and mature content is off/);
    expect(result).toMatchObject({ reason: 'completed', proposal: null, text: 'Mature content is off for this account; it can be turned on in Settings.' });
  });
});
