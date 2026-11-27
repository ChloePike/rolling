/**
 * Eval runner: runs a case through the real harness loop with any
 * LlmProvider (scripted for CI, Hyperouter for the live run) and checks the
 * invariants.
 */
import type { LlmProvider } from '@rolling/core';
import type { SafetyGate } from '@rolling/core/safety';
import { planCutTo } from '@rolling/core/timeline';
import type { ThreadState } from '../src/context';
import { runTurn, type TurnResult } from '../src/loop';
import { testIds, type ScriptedReply, type ScriptedStep } from '../src/testkit';
import type { MemoryWorld } from '../src/testkit';
import { canonicalPrompt, type ShotCharacter, type ShotSpec } from '@rolling/core/prompting';
import { ALL_CASES, type EvalCase, type PlanCase } from './cases';
import { gradeTurn, type Grade } from './graders';
import { checkCase } from './invariants';
import { CANVAS_ID, evalPorts, evalWorld, MAYA, PROJECT_ID, SHOT_1 } from './world';

export * from './cases';
export * from './graders';
export * from './invariants';
export * from './world';

export interface CaseRun {
  id: string;
  kind: EvalCase['kind'];
  golden: boolean;
  pass: boolean;
  failures: string[];
  /** Offline graders (`./graders.ts`), one per aspect that applies to the case. */
  grades: Grade[];
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

export async function runCase(c: EvalCase, llm: LlmProvider, opts: { world?: MemoryWorld; llmId?: string; safety?: SafetyGate } = {}): Promise<CaseRun> {
  const world = opts.world ?? evalWorld({ account: c.account ?? {}, editor: c.surface === 'editor', ...(c.canvas ? { canvas: c.canvas } : {}) });
  const ports = { ...evalPorts(world), ...(opts.safety ? { safety: opts.safety } : {}) };
  const result = await runTurn({
    llm,
    ports,
    thread: threadFor(c),
    input: { text: c.brief, refs: c.refs ?? [], selection: c.selection ?? [], ...(c.settings ? { settings: c.settings } : {}) },
    turnId: `turn_${c.id}_${crypto.randomUUID().slice(0, 8)}`,
    newId: testIds(),
    ...(opts.llmId ? { llmId: opts.llmId } : {}),
  });
  const failures = checkCase(c, result, { models: ports.models, account: world.account, edl: world.timelines.get(CANVAS_ID)!.edl });
  const grades = await gradeTurn(c, result, { account: world.account, invariantFailures: failures });
  return { id: c.id, kind: c.kind, golden: !!c.golden, pass: failures.length === 0, failures, grades, result };
}

// ---------------------------------------------------------------- scripted oracle (CI)

function splitSeconds(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const out = Array.from({ length: n }, () => base);
  for (let i = 0; i < total - base * n; i++) out[i]! += 1;
  return out;
}

/** How the scripted agent writes shots: `fields` (the structured schema) or `prose` (one free-text prompt per shot, as before the schema). */
export type OracleStyle = 'fields' | 'prose';

const CAST: ShotCharacter[] = [
  MAYA,
  { name: 'Leo', look: 'man in his thirties, curly brown hair, short beard', wardrobe: 'olive overshirt and dark jeans' },
];
const PRODUCT: ShotCharacter = { name: 'The product', look: 'matte bottle with a white label and a silver cap' };
const LOOK = 'Natural commercial look, soft contrast, warm neutrals';

const SIZES = ['wide', 'medium', 'close_up', 'medium_close_up'] as const;
const MOVES = ['push_in', 'static', 'tracking', 'pan_right', 'pull_out'] as const;
const BEATS = [
  ['in a sunlit kitchen by the window', 'reaches for the bottle on the counter and turns it to the light'],
  ['at the kitchen counter', 'pours a glass and watches it fill'],
  ['by the open window', 'takes a first sip and smiles'],
  ['at the table', 'sets the glass down next to the bottle'],
  ['in the doorway', 'looks back at the table and leaves'],
];

/** The fields of shot `i` of a case, as a careful agent would fill them. */
function oracleShot(c: PlanCase, i: number, seconds: number, cast: ShotCharacter[], audio: boolean): Record<string, unknown> {
  const who = cast.length ? cast.map((x) => x.name).join(' and ') : 'A hand';
  const [where, does] = BEATS[i % BEATS.length]!;
  const speaker = cast.find((x) => x !== PRODUCT) ?? cast[0];
  const explicit = c.expect.mature ? ', explicit sex scene, both nude' : '';
  return {
    subject: `${who} ${where}${explicit}`,
    action: `${who} ${does}`,
    setting: 'A bright apartment in the morning',
    camera: { size: SIZES[i % SIZES.length], angle: 'eye_level', move: MOVES[i % MOVES.length] },
    lighting: 'Soft window light from the left, warm',
    ...(cast.length ? { cast: cast.map((x) => x.name) } : {}),
    ...(c.expect.dialogue && audio && speaker && i === 0 ? { dialogue: [{ speaker: speaker.name, line: seconds >= 5 ? 'This is the one.' : 'Yes.', tone: 'warm' }] } : {}),
  };
}

function shotSpecOf(fields: Record<string, unknown>, cast: ShotCharacter[]): ShotSpec {
  const { cast: _names, ...rest } = fields;
  return { ...(rest as unknown as ShotSpec), style: LOOK, ...(cast.length ? { characters: cast } : {}) };
}

function oraclePlan(c: PlanCase, broken: boolean, style: OracleStyle = 'fields'): unknown {
  const [min, max] = c.expect.shots;
  const target = c.expect.seconds ?? Math.round(((min + max) / 2) * 5);
  let n = Math.max(min, Math.min(max, Math.round(target / 5)));
  while (n > min && target / n < 2) n--;
  const seconds = splitSeconds(target, n);
  const cheap = c.expect.maxCredits !== undefined || c.expect.cheap === true;
  const short = seconds.some((s) => s < 4);
  const pick = c.expect.model ?? c.settings?.videoModel ?? null;
  const first = pick ?? (short ? 'lumina/berry-1.0' : cheap ? 'bytedance/seedance-2.0-mini' : 'bytedance/seedance-2.5');
  const second = short ? 'lumina/berry-1.0' : 'bytedance/seedance-2.0-mini';
  const cast = c.expect.recurring ? (c.expect.recurring === 1 ? [CAST[0]!] : CAST.slice(0, c.expect.recurring)) : [];
  const option = (title: string, m: string) => {
    const audio = !['minimax/minimax-h3'].includes(m);
    return {
      title,
      ratio: c.expect.ratio ?? c.settings?.ratio ?? '16:9',
      ...(c.expect.resolution ? { resolution: c.expect.resolution } : {}),
      ...(style === 'fields' ? { look: LOOK, ...(cast.length ? { characters: cast } : {}) } : {}),
      shots: seconds.map((s, i) => {
        const fields = oracleShot(c, i, s, cast, audio);
        const head = { title: `Shot ${i + 1}`, seconds: broken && i === 0 ? 1 : s, model: m };
        return style === 'fields' ? { ...head, ...fields } : { ...head, visual: canonicalPrompt(shotSpecOf(fields, cast)).slice(0, 600) };
      }),
    };
  };
  return { seconds: target, options: [option('Option A', first), option('Option B', second)] };
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
    case 'ed-01-warmer-shot':
      // The shot starts from its keyframe, so the light changes on the picture and on the clip.
      return { ...base, ops: ['node_key2', 'node_shot2'].map((nodeId) => ({ op: 'updateNode', nodeId, params: { shot: { lighting: 'Warm golden morning light from the left' } } })) };
    case 'ed-02-static-camera':
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot1', params: { shot: { camera: { move: 'static' } } } }] };
    case 'ed-03-new-action':
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { shot: { action: 'Maya pours the sparkling water into a glass' } } }] };
    case 'ed-04-add-end-card':
      return {
        ...base,
        ops: [
          {
            op: 'addNode',
            tempId: 't1',
            kind: 'video',
            title: 'Shot 3: By the river',
            params: {
              shot: { ...SHOT_1, subject: 'Maya standing by the riverside rock', action: 'Maya puts the bottle on the rock and looks at the river', camera: { size: 'medium', angle: 'eye_level', move: 'static' } },
              model: 'bytedance/seedance-2.5',
              mode: 't2v',
              seconds: 4,
              ratio: '9:16',
            },
          },
        ],
      };
    case 'ed-05-cheaper-model':
      return { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { model: 'bytedance/seedance-2.0-mini' } }] };
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
export function oracleSteps(c: EvalCase, world: MemoryWorld, broken = false, style: OracleStyle = 'fields'): ScriptedReply[] {
  const say = (text: string, name: string, args: unknown): ScriptedStep => ({ text, toolCalls: [{ name, args }] });
  switch (c.kind) {
    case 'plan': {
      // The scripted agent narrates its read like the recorded model does: the harness must not show it.
      const steps: ScriptedReply[] = [say('Checking models. ', 'models.capabilities', { kind: 'video' })];
      if (broken) steps.push(say('', 'propose.plan', oraclePlan(c, true, style)));
      steps.push(say('Two options; building nodes is free, running them costs the estimate.', 'propose.plan', oraclePlan(c, false, style)));
      return steps;
    }
    case 'text':
      switch (c.expect.behavior) {
        case 'smalltalk':
          return [{ text: 'I plan videos shot by shot and edit them with you. What is the video for, how long, and vertical or widescreen?' }];
        case 'clarify':
          return [{ text: c.id === 'cl-02-contradiction' ? 'Ten shots of five seconds make 50 seconds, not 6: which length do you want?' : 'What should the video be about?' }];
        case 'refuse':
          return [{ text: 'never reached' }];
        case 'mature_off':
          // The turn runs without tools (`loop.ts`): the agent says in a sentence that mature content is off.
          return [{ text: 'Mature content is off for this account, so I can’t plan this scene. You can turn it on in Settings.' }];
      }
      return [];
    case 'fields':
      return [say('Filled in from your text.', 'propose.fields', oracleFields(c))];
    case 'graphPatch':
      return [say('', 'canvas.get', { projectId: PROJECT_ID }), say('This changes the shot; running it again costs credits.', 'propose.graphPatch', oracleGraph(c))];
    case 'timeline':
      return [say('', 'timeline.get', { canvasId: CANVAS_ID }), say('Free edit, nothing is regenerated.', 'propose.timelinePatch', oracleTimeline(c, world))];
  }
}

export { ALL_CASES };
