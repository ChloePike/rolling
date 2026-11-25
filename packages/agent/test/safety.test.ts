import { describe, expect, it } from 'vitest';
import { createSafetyGate, SAFETY_BLOCKED_MESSAGE, type SafetyGate } from '@rolling/core/safety';
import type { ChatEvent, ChatRequest, LlmProvider } from '@rolling/core';
import { runTurn, type RunTurnOptions } from '../src/loop';
import { proposalPrompts } from '../src/proposals';
import { ScriptedLlm, testIds, type ScriptedReply } from '../src/testkit';
import type { ThreadState } from '../src/context';
import { evalPorts, evalWorld } from '../evals/world';

// Category descriptions only; nothing explicit.
function thread(): ThreadState {
  return { threadId: 'thr_s', surface: 'home', skill: 'tv-ad', projectId: null, canvasId: null, summary: '', messages: [], proposals: [] };
}

/** Classifier fake: every text check says "safe". */
const safeLlm: LlmProvider = {
  id: 'safe',
  async *chat(_req: ChatRequest): AsyncIterable<ChatEvent> {
    yield {
      type: 'text',
      delta: JSON.stringify({ sexualLevel: 'none', apparentMinor: false, minorSexualized: false, realPerson: false, realPersonNames: [], realPersonSexualOrIntimate: false, nonConsensualSexual: false, extremeViolence: false, violentExtremism: false, selfHarm: false }),
    };
  },
};

function gate(): { gate: SafetyGate; seen: string[] } {
  const seen: string[] = [];
  return { gate: createSafetyGate({ llm: safeLlm, chatModels: [], newKey: () => 'k' }, (v, what) => void seen.push(`${what}:${v.verdict}`)), seen };
}

const plan = (visual: string) => ({
  seconds: 10,
  options: [
    { title: 'One', ratio: '9:16', shots: [{ title: 'A', seconds: 5, visual: 'A bottle on a rock', model: 'bytedance/seedance-2.5' }, { title: 'B', seconds: 5, visual, model: 'bytedance/seedance-2.5' }] },
    { title: 'Two', ratio: '9:16', shots: [{ title: 'C', seconds: 10, visual: 'A bottle on a table', model: 'bytedance/seedance-2.5' }] },
  ],
});

async function turn(text: string, steps: ScriptedReply[], g: SafetyGate, over: Partial<RunTurnOptions> = {}) {
  const llm = new ScriptedLlm(steps);
  const world = evalWorld();
  const ports = { ...evalPorts(world), safety: g };
  const result = await runTurn({ llm, ports, thread: thread(), input: { text, refs: [], selection: [] }, turnId: 't1', newId: testIds(), ...over });
  return { result, llm };
}

describe('agent safety gate (D-005)', () => {
  it('ends the turn with the neutral message when the brief hits a hard limit, without calling the agent LLM', async () => {
    const { gate: g, seen } = gate();
    const { result, llm } = await turn('a video of a nude schoolgirl', [{ text: 'never' }], g);
    expect(result.reason).toBe('safety_blocked');
    expect(result.text).toBe(SAFETY_BLOCKED_MESSAGE);
    expect(result.proposal).toBeNull();
    expect(llm.requests).toHaveLength(0);
    expect(seen).toEqual(['brief:block']);
  });

  it('lets a benign brief through', async () => {
    const { gate: g } = gate();
    const { result } = await turn('a 10-second ad with kids playing football', [{ text: 'Sure.', toolCalls: [{ name: 'propose.plan', args: plan('Kids cheering in a park') }] }], g);
    expect(result.reason).toBe('proposal');
  });

  it('rejects a proposal whose shot prompt hits a hard limit so the model rewrites it', async () => {
    const { gate: g } = gate();
    const { result, llm } = await turn(
      'a 10-second ad',
      [
        { text: '', toolCalls: [{ name: 'propose.plan', args: plan('a lewd teen pose') }] },
        { text: '', toolCalls: [{ name: 'propose.plan', args: plan('Sunset over the sea') }] },
      ],
      g,
    );
    expect(result.reason).toBe('proposal');
    expect(result.retries).toBe(1);
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool')!;
    const err = JSON.parse((toolMsg as { content: string }).content).error as string;
    expect(err).toContain(SAFETY_BLOCKED_MESSAGE);
    expect(err).not.toMatch(/MINOR|minor/);
  });

  it('gives explicit prompts on a non-mature turn the mature-content reason', async () => {
    const { gate: g } = gate();
    const { llm } = await turn('a 10-second ad', [{ text: '', toolCalls: [{ name: 'propose.plan', args: plan('an nsfw scene') }] }, { text: 'ok' }], g);
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool')!;
    expect(JSON.parse((toolMsg as { content: string }).content).error).toContain('Turn on mature content in Settings');
  });

  it('collects prompts from plan shots, node params and fields', () => {
    expect(proposalPrompts({ options: [{ shots: [{ visual: 'a' }], ops: [{ op: 'addNode', params: { prompt: 'b', negativePrompt: 'c' } }] }], fields: { prompt: 'a' } })).toEqual({ prompts: ['a', 'b'], negative: ['c'] });
  });
});
