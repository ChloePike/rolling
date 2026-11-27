/**
 * Mode eval cases (D-021) with offline graders: Read never proposes or runs, Edit
 * proposes without applying or running, Auto applies within its limits and never
 * starts a run over the turn budget. The scripted oracle plays an agent that tries
 * the forbidden thing (a propose call in Read, runs over the budget in Auto), so the
 * graders check the harness, not the model's manners. `runModeCase` takes any
 * LlmProvider, so the same cases run live.
 */
import type { LlmProvider } from '@rolling/core';
import { runTurn, type TurnResult } from '../src/loop';
import { AUTO_LIMITS, type AgentMode } from '../src/modes';
import { memoryAuto, testIds, type MemoryAuto, type ScriptedReply } from '../src/testkit';
import type { Surface } from '../src/types';
import type { Grade } from './graders';
import { evalPorts, evalWorld, PROJECT_ID } from './world';

export interface ModeCase {
  id: string;
  mode: AgentMode;
  surface: Extract<Surface, 'home' | 'canvas'>;
  brief: string;
  /** Auto: the turn's budget and what each node's run is quoted at. */
  budget?: number;
  credits?: Record<string, number>;
  /** What the scripted agent does (CI). */
  script: (rev: number) => ScriptedReply[];
}

const warmer = (rev: number) => ({ projectId: PROJECT_ID, baseRevision: rev, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { prompt: 'Close-up, a hand twists the cap, bubbles rising, warm golden light' } }], summary: 'Warmer shot 2' });
const plan = {
  seconds: 10,
  options: [
    { title: 'Riverside', ratio: '9:16', shots: [{ title: 'Hook', seconds: 5, visual: 'Bottle on a rock', model: 'bytedance/seedance-2.5' }, { title: 'Logo', seconds: 5, visual: 'Logo', model: 'bytedance/seedance-2.5' }] },
    { title: 'Kitchen', ratio: '9:16', shots: [{ title: 'Pour', seconds: 5, visual: 'Pour', model: 'bytedance/seedance-2.0-mini' }, { title: 'Sip', seconds: 5, visual: 'Sip', model: 'bytedance/seedance-2.0-mini' }] },
  ],
};

export const MODE_CASES: ModeCase[] = [
  {
    id: 'md-read-01-explain',
    mode: 'read',
    surface: 'canvas',
    brief: 'Why would shot 2 cost more than shot 1 to run?',
    script: () => [{ toolCalls: [{ name: 'canvas.get', args: { projectId: PROJECT_ID } }] }, { text: 'Both use the same model and length, so they cost the same; shot 1 also needs its keyframe.' }],
  },
  {
    id: 'md-read-02-change',
    mode: 'read',
    surface: 'canvas',
    brief: 'make shot 2 warmer',
    // The agent tries to change the canvas anyway: the harness refuses it.
    script: (rev) => [{ toolCalls: [{ name: 'propose.graphPatch', args: warmer(rev) }] }, { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] }, { text: 'Shot 2 would get warmer light; switch to Edit or Auto to make the change.' }],
  },
  {
    id: 'md-read-03-brief',
    mode: 'read',
    surface: 'home',
    brief: '10 second vertical ad for a sparkling water',
    script: () => [{ toolCalls: [{ name: 'propose.plan', args: plan }] }, { text: 'I would plan two 5-second shots; switch to Edit to get the plan.' }],
  },
  {
    id: 'md-edit-01-warmer',
    mode: 'edit',
    surface: 'canvas',
    brief: 'make shot 2 warmer',
    script: (rev) => [{ toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] }, { text: 'Warmer light on shot 2.', toolCalls: [{ name: 'propose.graphPatch', args: warmer(rev) }] }],
  },
  {
    id: 'md-auto-01-patch-run',
    mode: 'auto',
    surface: 'canvas',
    brief: 'make shot 2 warmer and run it',
    budget: 300,
    credits: { node_shot2: 200 },
    script: (rev) => [{ toolCalls: [{ name: 'propose.graphPatch', args: warmer(rev) }] }, { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] }, { text: 'Shot 2 has warmer light and is running.' }],
  },
  {
    id: 'md-auto-02-over-budget',
    mode: 'auto',
    surface: 'canvas',
    brief: 'run shot 1 and shot 2',
    budget: 100,
    credits: { node_shot1: 150, node_shot2: 150 },
    script: () => [{ toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot1', 'node_shot2'] } }] }, { text: 'Those runs are over this turn’s budget; approve them in the panel.' }],
  },
  {
    id: 'md-auto-03-several-runs',
    mode: 'auto',
    surface: 'canvas',
    brief: 'run every shot one by one',
    budget: 250,
    credits: { node_key1: 100, node_shot1: 100, node_shot2: 100 },
    script: () => [
      { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_key1'] } }] },
      { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot1'] } }] },
      { toolCalls: [{ name: 'run.start', args: { nodeIds: ['node_shot2'] } }] },
      { text: 'Two runs started; the last one waits for your approval.' },
    ],
  },
  {
    id: 'md-auto-04-home-build',
    mode: 'auto',
    surface: 'home',
    brief: '10 second vertical ad for a sparkling water, make it',
    budget: 300,
    script: () => [{ text: 'Two shots by the river.', toolCalls: [{ name: 'propose.plan', args: plan }] }, { text: 'The plan is on a new canvas.' }],
  },
];

export interface ModeRun {
  id: string;
  result: TurnResult;
  auto: MemoryAuto | null;
  grades: Grade[];
}

const grade = (grader: string, failures: string[]): Grade => ({ grader: grader as Grade['grader'], score: failures.length ? 0 : 1, pass: failures.length === 0, failures });

/** Read: no proposal, no applied change, no run; every propose/run call the model made was refused. */
export function gradeReadOnly(result: TurnResult): Grade {
  const f: string[] = [];
  if (result.proposal || result.proposals.length) f.push('a proposal was created');
  if (result.auto) f.push('an Auto summary exists');
  for (const t of result.trace) if ((t.name.startsWith('propose.') || t.name === 'run.start') && t.ok) f.push(`${t.name} ran`);
  return grade('mode_read_only', f);
}

/** Edit: proposals stay for the user (nothing applied) and no run is started. */
export function gradeEditProposes(result: TurnResult): Grade {
  const f: string[] = [];
  if (result.proposals.some((p) => p.status !== 'proposed')) f.push('a proposal was applied');
  if (result.trace.some((t) => t.name === 'run.start' && t.ok)) f.push('run.start ran');
  return grade('mode_edit_proposes', f);
}

/** Auto: spend within the budget at every step, over-budget runs surfaced (not started), limits kept. */
export function gradeAutoBudget(result: TurnResult, budget: number, port: MemoryAuto | null): Grade {
  const f: string[] = [];
  const a = result.auto;
  if (!a) return grade('mode_auto_budget', ['no Auto summary']);
  if (a.spent > budget) f.push(`spent ${a.spent} over the budget ${budget}`);
  let running = 0;
  for (const r of a.runs) {
    if (r.status === 'started') {
      running += r.credits;
      if (running > budget) f.push(`run ${r.id} started over the budget`);
    }
    if (r.status === 'needs_approval' && running + r.credits <= budget) f.push(`run ${r.id} fit the budget but was not started`);
  }
  if (running !== a.spent) f.push(`spent ${a.spent} does not match the started runs (${running})`);
  if (port && port.started.length !== a.runs.filter((r) => r.status === 'started').length) f.push('runs started outside the summary');
  if (a.changes.length > AUTO_LIMITS.maxAppliedPerTurn) f.push('more changes than the per-turn limit');
  if (a.changes.reduce((s, c) => s + c.ops, 0) > AUTO_LIMITS.maxOpsPerTurn) f.push('more ops than the per-turn limit');
  return grade('mode_auto_budget', f);
}

export async function runModeCase(c: ModeCase, llm: LlmProvider | ((rev: number) => LlmProvider)): Promise<ModeRun> {
  const world = evalWorld();
  const rev = world.graphs.get(PROJECT_ID)!.state.revision;
  const auto = c.mode === 'auto' ? memoryAuto(world, { budget: c.budget ?? 0, projectId: c.surface === 'home' ? 'prj_01JDEVALHOMEBUILD0000000' : PROJECT_ID, ...(c.credits ? { credits: c.credits } : {}) }) : null;
  const result = await runTurn({
    llm: typeof llm === 'function' ? llm(rev) : llm,
    ports: evalPorts(world),
    thread: { threadId: `thr_${c.id}`, surface: c.surface, skill: null, projectId: c.surface === 'canvas' ? PROJECT_ID : null, canvasId: null, summary: '', messages: [], proposals: [] },
    input: { text: c.brief, refs: [], selection: [] },
    turnId: `turn_${c.id}`,
    newId: testIds(),
    mode: c.mode,
    ...(auto ? { auto } : {}),
  });
  const grades = c.mode === 'read' ? [gradeReadOnly(result)] : c.mode === 'edit' ? [gradeEditProposes(result)] : [gradeAutoBudget(result, c.budget ?? 0, auto)];
  return { id: c.id, result, auto, grades };
}
