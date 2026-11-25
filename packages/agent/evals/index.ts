/**
 * Eval runner: runs a case through the real harness loop with any
 * LlmProvider (scripted for CI, Hyperouter for the live run) and checks the
 * invariants.
 */
import type { LlmProvider } from '@rolling/core';
import { planCutTo } from '@rolling/core/timeline';
import type { ThreadState } from '../src/context';
import { runTurn, type TurnResult } from '../src/loop';
import { testIds, type ScriptedReply, type ScriptedStep } from '../src/testkit';
import type { MemoryWorld } from '../src/testkit';
import { ALL_CASES, type EvalCase, type PlanCase } from './cases';
import { checkCase } from './invariants';
import { CANVAS_ID, evalPorts, evalWorld, PROJECT_ID } from './world';

export * from './cases';
export * from './invariants';
export * from './world';

export interface CaseRun {
  id: string;
  kind: EvalCase['kind'];
  golden: boolean;
  pass: boolean;
  failures: string[];
  result: TurnResult;
}

export function threadFor(c: EvalCase): ThreadState {
  return {
    threadId: `thr_eval_${c.id}`,
    surface: c.surface,
    skill: c.skill ?? null,
    projectId: c.surface === 'canvas' || c.surface === 'editor' ? PROJECT_ID : null,
    canvasId: c.surface === 'editor' ? CANVAS_ID : null,
    summary: '',
    messages: [],
    proposals: [],
    tool: c.kind === 'fields' ? c.expect.tool : null,
  };
}

export async function runCase(c: EvalCase, llm: LlmProvider, opts: { world?: MemoryWorld; llmId?: string } = {}): Promise<CaseRun> {
  const world = opts.world ?? evalWorld({ account: c.account ?? {}, editor: c.surface === 'editor' });
  const ports = evalPorts(world);
  const result = await runTurn({
    llm,
    ports,
    thread: threadFor(c),
    input: { text: c.brief, refs: c.refs ?? [], selection: c.selection ?? [] },
    turnId: `turn_${c.id}_${crypto.randomUUID().slice(0, 8)}`,
    newId: testIds(),
    ...(opts.llmId ? { llmId: opts.llmId } : {}),
  });
  const failures = checkCase(c, result, { models: ports.models, account: world.account, edl: world.timelines.get(CANVAS_ID)!.edl });
  return { id: c.id, kind: c.kind, golden: !!c.golden, pass: failures.length === 0, failures, result };
}

// ---------------------------------------------------------------- scripted oracle (CI)

function splitSeconds(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const out = Array.from({ length: n }, () => base);
  for (let i = 0; i < total - base * n; i++) out[i]! += 1;
  return out;
}

function oraclePlan(c: PlanCase, broken: boolean): unknown {
  const [min, max] = c.expect.shots;
  const target = c.expect.seconds ?? Math.round(((min + max) / 2) * 5);
  let n = Math.max(min, Math.min(max, Math.round(target / 5)));
  while (n > min && target / n < 2) n--;
  const seconds = splitSeconds(target, n);
  const cheap = c.expect.maxCredits !== undefined;
  const model = seconds.some((s) => s < 4) ? 'lumina/berry-1.0' : cheap ? 'bytedance/seedance-2.0-mini' : 'bytedance/seedance-2.5';
  const option = (title: string, m: string) => ({
    title,
    ratio: c.expect.ratio ?? '16:9',
    shots: seconds.map((s, i) => ({ title: `Shot ${i + 1}`, seconds: broken && i === 0 ? 1 : s, visual: `Shot ${i + 1} of: ${c.brief.slice(0, 80)}`, model: m })),
  });
  return { seconds: target, options: [option('Option A', model), option('Option B', seconds.some((s) => s < 4) ? 'lumina/berry-1.0' : 'bytedance/seedance-2.0-mini')] };
}

function oracleFields(c: Extract<EvalCase, { kind: 'fields' }>): unknown {
  const quote = /"([^"]+)"/.exec(c.brief)?.[1] ?? c.brief;
  switch (c.expect.tool) {
    case 'avatar':
      return { tool: 'avatar', fields: { script: quote, look: 'friendly presenter' } };
    case 'character':
      return { tool: 'character', fields: { name: c.brief.split(/[ ,]/)[0] ?? 'Character', look: c.brief } };
    case 'quick':
      return { tool: 'quick', fields: { kind: 'video', prompt: c.brief, model: 'bytedance/seedance-2.5', seconds: 5, ratio: '9:16' } };
    case 'remix':
      return { tool: 'remix', fields: { prompt: c.brief } };
  }
}

function oracleGraph(c: Extract<EvalCase, { kind: 'graphPatch' }>): unknown {
  const base = { projectId: PROJECT_ID, baseRevision: 7, summary: c.brief };
  switch (c.id) {
    case 'cv-01-warmer':
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { prompt: 'Close-up, a hand twists the cap, bubbles rising, warm golden morning light' } }] };
    case 'cv-02-longer':
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot1', params: { seconds: 8 } }] };
    case 'cv-03-add-logo':
      return {
        ...base,
        ops: [
          { op: 'addNode', tempId: 't1', kind: 'video', title: 'Shot 3: Logo', params: { prompt: 'Bottle centered, logo', model: 'bytedance/seedance-2.5', mode: 'i2v', seconds: 4, ratio: '9:16' } },
          { op: 'connect', from: { node: 'node_key1', port: 'out' }, to: { node: 't1', port: 'frame' } },
        ],
      };
    default:
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot1', params: { resolution: '720p', prompt: 'Very slow push-in on the bottle on a riverside rock, dawn light' } }] };
  }
}

function oracleTimeline(c: Extract<EvalCase, { kind: 'timeline' }>, world: MemoryWorld): unknown {
  const { edl, revision } = world.timelines.get(CANVAS_ID)!;
  const base = { canvasId: CANVAS_ID, baseRevision: revision, summary: c.brief };
  switch (c.edit) {
    case 'cutTo':
      return { ...base, ops: planCutTo(edl, c.expect.duration!)!.ops };
    case 'swap':
      return { ...base, ops: [{ op: 'move', clipId: 'v3', start: 5 }, { op: 'move', clipId: 'v2', start: 10 }] };
    case 'lowerMusic':
      return { ...base, ops: [{ op: 'setGain', clipId: 'm1', gainDb: -20 }] };
    case 'shorterCaptions':
      return { ...base, ops: ['c1', 'c2', 'c3'].map((id, i) => ({ op: 'setCaption', clipId: id, text: ['First sip.', 'Pop it open.', 'Find your ridge.'][i] })) };
    case 'removeShot':
      return {
        ...base,
        ops: [
          { op: 'remove', clipId: 'v2', ripple: true },
          { op: 'remove', clipId: 'c2', ripple: false },
          { op: 'move', clipId: 'c3', start: 5.5 },
          { op: 'trim', clipId: 'a1', out: 9 },
          { op: 'trim', clipId: 'm1', out: 10 },
        ],
      };
    default:
      return { ...base, ops: [] };
  }
}

/**
 * Scripted LLM replies that behave like a correct agent for a case: one
 * read tool, then the propose call. With `broken`, the first proposal is
 * invalid so the retry path runs.
 */
export function oracleSteps(c: EvalCase, world: MemoryWorld, broken = false): ScriptedReply[] {
  const say = (text: string, name: string, args: unknown): ScriptedStep => ({ text, toolCalls: [{ name, args }] });
  switch (c.kind) {
    case 'plan': {
      const steps: ScriptedReply[] = [say('Checking models. ', 'models.capabilities', { kind: 'video' })];
      if (broken) steps.push(say('', 'propose.plan', oraclePlan(c, true)));
      steps.push(say('Two options; building nodes is free, running them costs the estimate.', 'propose.plan', oraclePlan(c, false)));
      return steps;
    }
    case 'fields':
      return [say('Filled in from your text.', 'propose.fields', oracleFields(c))];
    case 'graphPatch':
      return [say('', 'canvas.get', { projectId: PROJECT_ID }), say('This changes the shot; running it again costs credits.', 'propose.graphPatch', oracleGraph(c))];
    case 'timeline':
      return [say('', 'timeline.get', { canvasId: CANVAS_ID }), say('Free edit, nothing is regenerated.', 'propose.timelinePatch', oracleTimeline(c, world))];
  }
}

export { ALL_CASES };
