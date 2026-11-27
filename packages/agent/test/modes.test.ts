/**
 * Agent modes (D-021): the tool set per mode, Read refusing propose calls, Auto
 * applying patches and starting runs within the turn budget, and the budget math.
 */
import { describe, expect, it } from 'vitest';
import { autoBudgetCredits, AUTO_BUDGET, DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '@rolling/core/pricing/config';
import { runTurn, type RunTurnOptions } from '../src/loop';
import { AUTO_LIMITS, modeSection, TurnBudget } from '../src/modes';
import { memoryAuto, ScriptedLlm, testIds, type ScriptedReply } from '../src/testkit';
import { toolsFor } from '../src/tools';
import { SURFACES, type AgentEvent } from '../src/types';
import type { ThreadState } from '../src/context';
import { evalPorts, evalWorld, PROJECT_ID } from '../evals/world';

function canvasThread(over: Partial<ThreadState> = {}): ThreadState {
  return { threadId: 'thr_m', surface: 'canvas', skill: null, projectId: PROJECT_ID, canvasId: null, summary: '', messages: [], proposals: [], ...over };
}

async function turn(steps: ScriptedReply[], over: Partial<RunTurnOptions> & { world?: ReturnType<typeof evalWorld> } = {}) {
  const llm = new ScriptedLlm(steps);
  const events: AgentEvent[] = [];
  const world = over.world ?? evalWorld();
  const result = await runTurn({
    llm,
    ports: evalPorts(world),
    thread: canvasThread(),
    input: { text: 'make shot 2 warmer and run it', refs: [], selection: [] },
    turnId: 'turn_m',
    newId: testIds(),
    emit: (e) => events.push(e),
    ...over,
  });
  return { result, llm, events, world };
}

const warmer = (revision = 7) => ({ projectId: PROJECT_ID, baseRevision: revision, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { prompt: 'Close-up, a hand twists the cap, bubbles rising, warm golden light' } }], summary: 'Warmer shot 2' });

describe('tool set per mode', () => {
  it('Read has only read tools on every surface; Edit has no run tool; Auto adds run.start on Home and canvas', () => {
    for (const s of SURFACES) {
      expect(toolsFor(s, 'read').every((t) => t.kind === 'read')).toBe(true);
      expect(toolsFor(s, 'read').length).toBeGreaterThan(0);
      expect(toolsFor(s, 'edit').some((t) => t.kind === 'run')).toBe(false);
      expect(toolsFor(s, 'edit').map((t) => t.name)).toEqual(toolsFor(s).map((t) => t.name));
    }
    expect(toolsFor('canvas', 'auto').map((t) => t.name)).toContain('run.start');
    expect(toolsFor('home', 'auto').map((t) => t.name)).toContain('run.start');
    expect(toolsFor('tool', 'auto').map((t) => t.name)).not.toContain('run.start');
  });

  it('the context states the mode and, in Auto, the remaining budget', () => {
    expect(modeSection('read')).toMatch(/read only/i);
    expect(modeSection('auto', { total: 300, remaining: 120 })).toContain('120 of 300 credits');
  });
});

describe('budget math', () => {
  it('defaults to the confirm threshold and clamps the user choice', () => {
    expect(autoBudgetCredits(null, DEFAULT_CONFIRM_THRESHOLD_CREDITS)).toBe(300);
    expect(autoBudgetCredits(500, 300)).toBe(500);
    expect(autoBudgetCredits(-5, 300)).toBe(0);
    expect(autoBudgetCredits(10 ** 9, 300)).toBe(AUTO_BUDGET.max);
  });

  it('starts within the budget, asks for approval over it, refuses over the balance or the member limit', () => {
    const b = new TurnBudget(300);
    expect(b.decide({ credits: 200, available: 1000 })).toEqual({ action: 'start' });
    b.commit(200);
    expect(b.spent).toBe(200);
    expect(b.remaining).toBe(100);
    expect(b.decide({ credits: 100, available: 1000 })).toEqual({ action: 'start' });
    expect(b.decide({ credits: 101, available: 1000 })).toEqual({ action: 'approve', reason: 'over_budget' });
    expect(b.decide({ credits: 50, available: 40 })).toEqual({ action: 'refuse', code: 'INSUFFICIENT_CREDITS' });
    expect(b.decide({ credits: 50, available: 1000, memberLeft: 20 })).toEqual({ action: 'refuse', code: 'MEMBER_LIMIT_REACHED' });
    expect(b.decide({ credits: 0, available: 1000 })).toEqual({ action: 'refuse', code: 'NOTHING_TO_RUN' });
    b.commit(500);
    expect(b.remaining).toBe(0);
  });
});

describe('Read mode', () => {
  it('offers no propose tools and refuses a propose call the model makes anyway', async () => {
    const { result, llm, world } = await turn(
      [{ toolCalls: [{ name: 'propose.graphPatch', args: warmer() }] }, { text: 'Shot 2 would get warmer light; switch to Edit to change it.' }],
      { mode: 'read' },
    );
    const offered = llm.requests[0]!.tools!.map((t) => t.name);
    expect(offered.some((n) => n.startsWith('propose.') || n === 'run.start')).toBe(false);
    expect(llm.requests[0]!.messages[0]!.content).toContain('# Mode: Read');
    expect(result.proposal).toBeNull();
    expect(result.proposals).toHaveLength(0);
    expect(result.trace[0]).toMatchObject({ name: 'propose.graphPatch', ok: false, error: 'not available in read mode' });
    const reply = JSON.parse(llm.requests[1]!.messages.at(-1)!.content as string);
    expect(reply.error).toMatch(/not available in read mode/);
    // Nothing changed.
    expect(world.graphs.get(PROJECT_ID)!.state.revision).toBe(7);
  });
});

describe('Auto mode', () => {
  it('applies a graph patch, starts a run within the budget and surfaces one over it', async () => {
    const world = evalWorld();
    const auto = memoryAuto(world, { budget: 300, credits: { node_shot2: 200, node_shot1: 150 } });
    const { result, events } = await turn(
      [
        { toolCalls: [{ name: 'propose.graphPatch', args: warmer() }] },
        { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] },
        { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot1'] } }] },
        { text: 'Shot 2 is warmer and running. Shot 1 needs your approval.' },
      ],
      { mode: 'auto', auto, world },
    );
    expect(auto.applied).toHaveLength(1);
    expect(world.graphs.get(PROJECT_ID)!.state.revision).toBe(8);
    expect(result.proposal?.status).toBe('applied');
    expect(result.auto).toMatchObject({ budget: 300, spent: 200 });
    expect(result.auto!.changes).toHaveLength(1);
    expect(result.auto!.runs.map((r) => [r.status, r.credits])).toEqual([
      ['started', 200],
      ['needs_approval', 150],
    ]);
    // Only the run within the budget was started.
    expect(auto.started).toEqual(['qt_1']);
    expect(events.filter((e) => e.type === 'agent.auto').length).toBeGreaterThanOrEqual(3);
    expect(result.text).toContain('Shot 2 is warmer');
  });

  it('enforces the budget across several run.start calls in a turn', async () => {
    const world = evalWorld();
    const auto = memoryAuto(world, { budget: 250, credits: { a: 100, b: 100, c: 100 } });
    const { result } = await turn(
      [
        { toolCalls: [{ name: 'run.start', args: { nodeIds: ['a'] } }] },
        { toolCalls: [{ name: 'run.start', args: { nodeIds: ['b'] } }] },
        { toolCalls: [{ name: 'run.start', args: { nodeIds: ['c'] } }] },
        { text: 'Two runs started; the third waits for you.' },
      ],
      { mode: 'auto', auto, world },
    );
    expect(result.auto!.runs.map((r) => r.status)).toEqual(['started', 'started', 'needs_approval']);
    expect(result.auto!.spent).toBe(200);
    expect(auto.started).toHaveLength(2);
  });

  it('refuses a run the member limit or the balance does not allow (D-013, D-006)', async () => {
    const world = evalWorld();
    const limited = memoryAuto(world, { budget: 300, credits: { a: 100 }, startError: { code: 'MEMBER_LIMIT_REACHED', message: 'Monthly credit limit for this member is used.' } });
    const r1 = await turn([{ toolCalls: [{ name: 'run.start', args: { nodeIds: ['a'] } }] }, { text: 'Your monthly limit is used.' }], { mode: 'auto', auto: limited, world });
    expect(r1.result.auto!.runs[0]).toMatchObject({ status: 'refused', code: 'MEMBER_LIMIT_REACHED' });
    expect(r1.result.auto!.spent).toBe(0);

    const poor = evalWorld({ account: { balance: { plan: 50, purchased: 0, held: 0 } } });
    const broke = memoryAuto(poor, { budget: 300, credits: { a: 100 } });
    const r2 = await turn([{ toolCalls: [{ name: 'run.start', args: { nodeIds: ['a'] } }] }, { text: 'Not enough credits.' }], { mode: 'auto', auto: broke, world: poor });
    expect(r2.result.auto!.runs[0]).toMatchObject({ status: 'refused', code: 'INSUFFICIENT_CREDITS' });
    expect(broke.started).toHaveLength(0);
  });

  it('keeps proposals beyond the per-turn limit for the user', async () => {
    const world = evalWorld();
    const auto = memoryAuto(world, { budget: 0 });
    const patch = (rev: number, seconds: number) => ({ projectId: PROJECT_ID, baseRevision: rev, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { seconds } }], summary: `Shot 2 to ${seconds} s` });
    const steps: ScriptedReply[] = [];
    for (let i = 0; i <= AUTO_LIMITS.maxAppliedPerTurn; i++) steps.push({ toolCalls: [{ name: 'propose.graphPatch', args: patch(7 + i, 6 + i) }] });
    steps.push({ text: 'never reached' });
    const { result } = await turn(steps, { mode: 'auto', auto, world });
    expect(auto.applied).toHaveLength(AUTO_LIMITS.maxAppliedPerTurn);
    expect(result.proposal?.status).toBe('proposed');
    expect(result.proposals).toHaveLength(AUTO_LIMITS.maxAppliedPerTurn + 1);
  });

  it('runs as Edit when no Auto port is wired, and Edit offers no run.start', async () => {
    const { result, llm } = await turn([{ toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] }, { text: 'Run it from the canvas.' }], { mode: 'auto' });
    expect(result.mode).toBe('edit');
    expect(llm.requests[0]!.tools!.map((t) => t.name)).not.toContain('run.start');
    expect(result.trace[0]).toMatchObject({ ok: false, error: 'not available in edit mode' });
  });
});
