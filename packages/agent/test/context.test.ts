import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildContext, CONTEXT_BUDGET, type ThreadState } from '../src/context';
import { layoutNewNodes, LAYOUT } from '../src/layout';
import { resolveAgentLlm, temperatureFor } from '../src/routing';
import { fallbackSummary, messagesToSummarize, summarizeThread, summaryDue } from '../src/summary';
import { ScriptedLlm } from '../src/testkit';
import { estimateTokens, truncateToTokens } from '../src/tokens';
import { toolDefinition, toolsFor } from '../src/tools';
import type { ThreadMessage } from '../src/types';
import { catalog, evalPorts, evalWorld, PRODUCT_PHOTO, PROJECT_ID, sampleGraph } from '../evals/world';
// @ts-expect-error plain JS build script
import { renderPrompts } from '../scripts/gen-prompts.mjs';

const msg = (i: number, size = 40): ThreadMessage => ({ id: `msg_${i}`, role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'word '.repeat(size)}`, createdAt: i });

function thread(over: Partial<ThreadState> = {}): ThreadState {
  return { threadId: 'thr_t', surface: 'canvas', skill: 'tv-ad', projectId: PROJECT_ID, canvasId: null, summary: '', messages: [], proposals: [], ...over };
}

describe('tokens', () => {
  it('estimates latin and CJK text and truncates to a budget', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('视频'.repeat(50))).toBe(100);
    const t = truncateToTokens('word '.repeat(1000), 50);
    expect(estimateTokens(t)).toBeLessThanOrEqual(50);
    expect(t).toContain('[truncated]');
  });
});

describe('buildContext', () => {
  const world = evalWorld();
  const ports = evalPorts(world);
  const tools = toolsFor('canvas').map(toolDefinition);

  it('has the system prompt, skill, account, workspace and the user message', async () => {
    const ctx = await buildContext({ thread: thread(), input: { text: 'make shot 2 warmer', refs: [PRODUCT_PHOTO.id], selection: ['node_shot2'] }, account: world.account, ports, tools });
    const system = ctx.messages[0]!.content as string;
    expect(system).toContain('# Reply');
    expect(system).toContain('# TV ad');
    expect(system).toContain('"plan":"plus"');
    expect(system).toContain('Canvas revision: 7');
    expect(system).toContain('Selected nodes:\n{"id":"node_shot2"');
    expect(system).toContain('node_shot1 video "Shot 1: Hero" model=bytedance/seedance-2.5');
    expect(system).toContain(`${PRODUCT_PHOTO.id} image "Ridgeline bottle.png"`);
    expect(ctx.messages.at(-1)).toEqual({ role: 'user', content: 'make shot 2 warmer' });
    expect(ctx.revision).toBe(7);
  });

  it('passes the prompt box settings (Home pills) to the model, and leaves them out when there are none', async () => {
    const home = thread({ surface: 'home', projectId: null, skill: null });
    const withSettings = await buildContext({
      thread: home,
      input: { text: 'an ad for a bottle', refs: [], selection: [], settings: { videoModel: null, ratio: '9:16', seconds: 15 } },
      account: world.account,
      ports,
      tools,
    });
    expect(withSettings.messages[0]!.content).toContain('# Prompt box settings\nThe user picked aspect ratio 9:16, total length 15 s, video model Auto (the default one) on the prompt box.');
    const without = await buildContext({ thread: home, input: { text: 'an ad', refs: [], selection: [] }, account: world.account, ports, tools });
    expect(without.messages[0]!.content).not.toContain('# Prompt box settings');
  });

  it('keeps the last 12 messages verbatim plus the summary', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const ctx = await buildContext({ thread: thread({ messages, summary: 'User wants a 15 s ad.' }), input: { text: 'next', refs: [], selection: [] }, account: world.account, ports, tools });
    expect(ctx.historyCount).toBe(12);
    expect(ctx.messages[1]!.content).toContain('message 18');
    expect(ctx.messages[0]!.content).toContain('# Earlier in this thread\nUser wants a 15 s ad.');
  });

  it('stays within the 24k budget with huge history and canvas', async () => {
    const big = sampleGraph();
    for (let i = 0; i < 400; i++) {
      big.nodes.push({ ...big.nodes[3]!, id: `node_x${i}`, title: `Shot ${i}`, params: { ...big.nodes[3]!.params, prompt: 'long prompt '.repeat(40) } });
    }
    const w = evalWorld({ graph: big });
    const messages = Array.from({ length: 30 }, (_, i) => msg(i, 1500));
    const ctx = await buildContext({ thread: thread({ messages }), input: { text: 'x', refs: [], selection: [] }, account: w.account, ports: evalPorts(w), tools });
    const total = ctx.messages.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(ctx.tokens).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(ctx.historyCount).toBeLessThan(12);
  });
});

describe('summary', () => {
  it('is due every 10 turns once history leaves the window', () => {
    expect(summaryDue(10, 20)).toBe(true);
    expect(summaryDue(10, 12)).toBe(false);
    expect(summaryDue(9, 30)).toBe(false);
    expect(messagesToSummarize(Array.from({ length: 20 }, (_, i) => msg(i)))).toHaveLength(8);
  });

  it('uses the LLM and falls back to a deterministic summary', async () => {
    const older = [msg(0), msg(1)];
    const ok = await summarizeThread({ llm: new ScriptedLlm([{ text: '- brief: ad' }]), model: 'm', previous: '', older, idempotencyKey: 'k' });
    expect(ok.summary).toBe('- brief: ad');
    const failed = await summarizeThread({ llm: new ScriptedLlm([{ throws: { code: 'x', message: 'x', retryable: false } }]), model: 'm', previous: 'old', older, idempotencyKey: 'k' });
    expect(failed.summary).toBe(fallbackSummary('old', older));
  });
});

describe('routing', () => {
  const chat = catalog.models.filter((m) => m.kind === 'chat');
  it('resolves public ids and falls back to the default', () => {
    expect(resolveAgentLlm(undefined, chat).publicId).toBe('deepseek-v4.1-flash');
    expect(resolveAgentLlm('gpt-6.1-sol', chat).gatewayId).toBe('openai/gpt-6.1-sol');
    expect(resolveAgentLlm('nope', chat)).toMatchObject({ publicId: 'deepseek-v4.1-flash', fellBack: true });
    expect(resolveAgentLlm('deepseek-v4.1-flash-1017', chat, { mature: true }).gatewayId).toBe('deepseek/deepseek-v4.1-flash-cyber');
    expect(resolveAgentLlm(undefined, []).gatewayId).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('uses 0.7 for writing and 0.3 for plans and edits', () => {
    expect(temperatureFor('home', 'Write a voiceover script for my ad')).toBe(0.7);
    expect(temperatureFor('home', '15-second vertical ad for a sparkling water')).toBe(0.3);
    expect(temperatureFor('canvas', 'make shot 2 warmer')).toBe(0.3);
    expect(temperatureFor('editor', 'write shorter captions')).toBe(0.3);
  });
});

describe('layout', () => {
  it('places new nodes right of their inputs and below what is in the column', () => {
    const ops = layoutNewNodes({ nodes: [], edges: [] }, [
      { op: 'addNode', tempId: 'a', kind: 'text', title: 'a', params: {} },
      { op: 'addNode', tempId: 'b', kind: 'image', title: 'b', params: {}, position: { x: 1, y: 1 } },
      { op: 'addNode', tempId: 'c', kind: 'image', title: 'c', params: {} },
      { op: 'connect', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'prompt' } },
      { op: 'connect', from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'prompt' } },
    ]);
    const pos = Object.fromEntries(ops.filter((o) => o.op === 'addNode').map((o) => [(o as { tempId: string }).tempId, (o as { position: { x: number; y: number } }).position]));
    expect(pos.a).toEqual({ x: LAYOUT.originX, y: LAYOUT.originY });
    expect(pos.b).toEqual({ x: LAYOUT.originX + LAYOUT.colWidth, y: LAYOUT.originY });
    expect(pos.c).toEqual({ x: LAYOUT.originX + LAYOUT.colWidth, y: LAYOUT.originY + LAYOUT.rowHeight });
  });

  it('stacks below a tall script by its height, and puts a text-to-video shot right of its script', () => {
    const visual = 'A clear glass water bottle stands on a mossy rock in a quiet forest stream, water beading on the glass, soft light.';
    const ops = layoutNewNodes({ nodes: [], edges: [] }, [
      { op: 'addNode', tempId: 'script', kind: 'script', title: 's', params: { rows: [{ visual }, { visual }] } },
      { op: 'addNode', tempId: 'note', kind: 'text', title: 'n', params: {} },
      { op: 'addNode', tempId: 'shot1', kind: 'video', title: 'v', params: {} },
    ]);
    const pos = Object.fromEntries(ops.filter((o) => o.op === 'addNode').map((o) => [(o as { tempId: string }).tempId, (o as { position: { x: number; y: number } }).position]));
    expect(pos.note!.x).toBe(pos.script!.x);
    expect(pos.note!.y - pos.script!.y).toBeGreaterThan(LAYOUT.rowHeight);
    expect(pos.shot1).toEqual({ x: LAYOUT.originX + LAYOUT.colWidth, y: LAYOUT.originY });
  });
});

describe('prompts', () => {
  it('src/prompts.generated.ts is up to date (run pnpm --filter @rolling/agent gen:prompts)', () => {
    expect(readFileSync(new URL('../src/prompts.generated.ts', import.meta.url), 'utf8')).toBe(renderPrompts());
  });

  it('every skill exists and the system prompt carries the section 6 rules', async () => {
    const { SKILL_PROMPTS, SYSTEM_PROMPT } = await import('../src/prompts.generated');
    expect(Object.keys(SKILL_PROMPTS).sort()).toEqual(['ai-comic', 'brand-kit', 'product-showcase', 'storyboard', 'tv-ad']);
    for (const rule of ['Never say something was generated', 'credit estimate', 'Prefer reuse', "Keep the user's words", 'one short question', "user's language", 'no emoji', 'Simple mode']) {
      expect(SYSTEM_PROMPT).toContain(rule);
    }
  });
});
