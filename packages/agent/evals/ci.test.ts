/**
 * Deterministic eval runner (CI): every golden case runs through the real
 * harness loop with a scripted LLM, plus the harness paths (retry, invalid
 * proposal, max tool calls, cancel). Invariants must pass for all.
 */
import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/loop';
import { ScriptedLlm, testIds } from '../src/testkit';
import { ALL_CASES, BRIEFS, oracleSteps, runCase, threadFor, TIMELINE_CASES, type EvalCase } from './index';
import { evalPorts, evalWorld } from './world';

describe('eval set', () => {
  it('has 40 golden briefs and the section 8 timeline cases', () => {
    expect(BRIEFS).toHaveLength(40);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    expect(TIMELINE_CASES.map((c) => c.brief)).toEqual(expect.arrayContaining(['cut to 10s', 'swap shot 2 and 3', 'lower the music', 'make captions shorter']));
    expect(ALL_CASES.filter((c) => c.golden).map((c) => c.id)).toEqual(['tv-01-sparkling-water', 'cv-01-warmer', 'tl-01-cut-10']);
  });
});

describe('scripted eval run', () => {
  it.each(ALL_CASES.map((c, i) => [c.id, c, i] as const))('%s passes its invariants', async (_id, c: EvalCase, i) => {
    const world = evalWorld({ account: c.account ?? {} });
    const broken = c.kind === 'plan' && i % 5 === 0;
    const run = await runCase(c, new ScriptedLlm(oracleSteps(c, world, broken)), { world });
    expect(run.failures).toEqual([]);
    expect(run.result.retries).toBe(broken ? 1 : 0);
  });
});

describe('invariant checks catch bad output', () => {
  it('fails a plan with the wrong length and a timeline cut that misses the target', async () => {
    const plan = BRIEFS[0]!;
    const world = evalWorld();
    const wrong = new ScriptedLlm([
      {
        toolCalls: [
          {
            name: 'propose.plan',
            args: { seconds: 10, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', shots: [{ title: 'a', seconds: 10, visual: 'v', model: 'bytedance/seedance-2.5' }] })) },
          },
        ],
      },
    ]);
    const run = await runCase(plan, wrong, { world });
    expect(run.pass).toBe(false);
    expect(run.failures.join('\n')).toMatch(/10s, want 15s/);
    expect(run.failures.join('\n')).toMatch(/ratio 16:9, want 9:16/);

    const cut = TIMELINE_CASES[0]!;
    const half = new ScriptedLlm([{ toolCalls: [{ name: 'propose.timelinePatch', args: { canvasId: 'cnv_01JDEVALPROJECT000000000', baseRevision: 3, ops: [{ op: 'trim', clipId: 'v3', out: 3 }], summary: 'x' } }] }]);
    const r2 = await runCase(cut, half, { world: evalWorld() });
    expect(r2.failures.join('\n')).toMatch(/duration 15, want 10/);
  });

  it('fails a reply with emoji or a false claim', async () => {
    const c = BRIEFS.find((b) => b.kind === 'fields')!;
    const world = evalWorld();
    const steps = oracleSteps(c, world);
    (steps[0] as { text: string }).text = 'I have generated it 🎉';
    const run = await runCase(c, new ScriptedLlm(steps), { world });
    expect(run.failures).toEqual(expect.arrayContaining(['reply contains emoji', 'reply claims something was done']));
  });
});

describe('harness paths', () => {
  const c = BRIEFS[0]!;
  const base = () => {
    const world = evalWorld();
    return { world, ports: evalPorts(world), thread: threadFor(c), input: { text: c.brief, refs: c.refs ?? [], selection: [] }, newId: testIds() };
  };

  it('invalid proposal three times ends with an explanation and no proposal', async () => {
    const b = base();
    const bad = { toolCalls: [{ name: 'propose.plan', args: { options: [] } }] };
    const r = await runTurn({ ...b, turnId: 't', llm: new ScriptedLlm([bad, bad, bad, { text: 'That plan does not fit the models.' }]) });
    expect(r).toMatchObject({ reason: 'invalid_proposal', proposal: null, retries: 3 });
  });

  it('max tool calls ends the turn', async () => {
    const b = base();
    const read = { toolCalls: [{ name: 'models.capabilities', args: { kind: 'video' } }] };
    const r = await runTurn({ ...b, turnId: 't', llm: new ScriptedLlm([read, read, read, read, read, read, read, read, { text: 'Stopping here.' }]) });
    expect(r).toMatchObject({ reason: 'max_tool_calls', toolCalls: 8, proposal: null });
  });

  it('cancel creates no proposal', async () => {
    const b = base();
    const controller = new AbortController();
    const steps = oracleSteps(c, b.world);
    const slow = { ...(steps[0] as object), delayMs: 1_000 };
    const p = runTurn({ ...b, turnId: 't', signal: controller.signal, llm: new ScriptedLlm([slow, ...steps.slice(1)]) });
    setTimeout(() => controller.abort(), 20);
    const r = await p;
    expect(r).toMatchObject({ reason: 'canceled', proposal: null });
  });
});
