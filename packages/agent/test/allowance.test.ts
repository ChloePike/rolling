/**
 * D-012: what a turn costs the agent allowance. Every LLM response of the turn
 * is charged (`usage.cost`, else tokens × the gateway model's token price);
 * classifier calls (safety gate, Auto) are not.
 */
import { describe, expect, it } from 'vitest';
import { tokenPrice } from '@rolling/core';
import { runTurn } from '../src/loop';
import { defaultTurnEstimate, defaultTurnEstimates } from '../src/limits';
import { ScriptedLlm, testIds, type ScriptedReply } from '../src/testkit';
import type { ThreadState } from '../src/context';
import type { AgentPorts } from '../src/ports';
import { evalPorts, evalWorld } from '../evals/world';

const thread: ThreadState = { threadId: 'thr_a', surface: 'home', skill: null, projectId: null, canvasId: null, summary: '', messages: [], proposals: [] };

async function turn(steps: ScriptedReply[], opts: { llmId?: string; ports?: (p: AgentPorts) => AgentPorts } = {}) {
  const base = evalPorts(evalWorld());
  const ports = opts.ports ? opts.ports(base) : base;
  const llm = new ScriptedLlm(steps);
  const result = await runTurn({ llm, ports, thread, input: { text: 'ideas for a coffee ad', refs: [], selection: [] }, turnId: 'turn_a', newId: testIds(), llmId: opts.llmId ?? null });
  return { result, ports };
}

describe('turn cost (D-012)', () => {
  it('sums usage.cost over every LLM call of the turn', async () => {
    const { result } = await turn([
      { toolCalls: [{ name: 'models.capabilities', args: { kind: 'video' } }], usage: { promptTokens: 9000, completionTokens: 50, costUsd: 0.0012 } },
      { text: 'Two ideas.', usage: { promptTokens: 9500, completionTokens: 400, costUsd: 0.0021 } },
    ]);
    expect(result.llmCalls).toBe(2);
    expect(result.usage.costUsd).toBeCloseTo(0.0033, 12);
    expect(result.usage.chargedUsd).toBeCloseTo(0.0033, 12);
  });

  it('falls back to tokens × the resolved gateway model price when cost is missing', async () => {
    const { result, ports } = await turn([{ text: 'Sure.', usage: { promptTokens: 10_000, completionTokens: 1_000 } }], { llmId: 'claude-opus-5.5' });
    const price = tokenPrice(ports.models.chatModels().find((m) => m.id === result.llm.gatewayId)!)!;
    expect(result.llm.gatewayId).toBe('anthropic/claude-opus-5.5');
    expect(result.usage.costUsd).toBeNull();
    expect(result.usage.chargedUsd).toBeCloseTo(10_000 * price.prompt + 1_000 * price.completion, 12);
  });

  it('charges retried calls that reported usage, mixing cost and the fallback', async () => {
    const { result } = await turn([
      { throws: { code: 'upstream', message: 'busy', retryable: true } },
      { toolCalls: [{ name: 'propose.plan', args: { bad: true } }], usage: { promptTokens: 1000, completionTokens: 10, costUsd: 0.01 } },
      { text: 'Fixed.', usage: { promptTokens: 1000, completionTokens: 10 } },
    ]);
    expect(result.llmCalls).toBe(3);
    expect(result.usage.chargedUsd).toBeGreaterThan(0.01);
  });

  it('does not charge the safety classifier', async () => {
    const classifier = new ScriptedLlm([{ text: '{"verdict":"allow"}', usage: { promptTokens: 500, completionTokens: 10, costUsd: 0.5 } }]);
    const { result } = await turn([{ text: 'Ok.', usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.001 } }], {
      ports: (p) => ({
        ...p,
        safety: {
          async checkBrief() {
            for await (const _ of classifier.chat({ model: 'deepseek/deepseek-v4.1-flash', messages: [], idempotencyKey: 'k' })) void _;
            return { verdict: 'allow', reasons: [], checks: [] };
          },
          async checkProposal() {
            return { verdict: 'allow', reasons: [], checks: [] };
          },
        } as unknown as NonNullable<AgentPorts['safety']>,
      }),
    });
    expect(classifier.requests).toHaveLength(1);
    expect(result.usage.chargedUsd).toBeCloseTo(0.001, 12);
  });

  it('lists default estimates per public LLM (10k in / 1.2k out), public ids only', () => {
    const chat = evalPorts(evalWorld()).models.chatModels();
    const list = defaultTurnEstimates(chat);
    expect(list.every((m) => !m.id.includes('/'))).toBe(true);
    const opus = list.find((m) => m.id === 'claude-opus-5.5')!;
    expect(opus.fallbackUsd).toBeCloseTo(0.064, 9);
    expect(list.find((m) => m.id === 'deepseek-v4.1-flash')!.fallbackUsd).toBeCloseTo(0.00111, 9);
    expect(defaultTurnEstimate('nope', chat).publicId).toBe('deepseek-v4.1-flash');
  });
});
