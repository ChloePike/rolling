/**
 * Offline graders (docs/harness-research.md §4). Each looks at one aspect of
 * a turn and gives a score from 0 to 1; `null` means the grader does not
 * apply to the case. They read the proposal the harness stored, and for
 * generation prompts they go one step further than the proposal: the plan is
 * applied to a canvas, the canvas is planned as a run (`core/generation`), and
 * the provider request is built per node, so what is graded is the text a
 * model would actually receive.
 *
 * Nothing here calls a model. Graders whose result depends on how a real LLM
 * writes (clarifying questions, small talk, continuity of free text) are
 * meaningful on recorded or live transcripts; with the scripted LLM they only
 * prove the harness path.
 */
import type { GraphState, LocalOp } from '@rolling/core/graph';
import { buildGenerateRequest, planRun as planGeneration, type GenInput, type PlanItem } from '@rolling/core/generation';
import { applyGraphOps, computeInputDigests, planRun as planStructure } from '@rolling/core/project';
import { characterDescriptor, lintPrompt, wordCount, type LintIssue, type PromptPurpose } from '@rolling/core/prompting';
import { explicitSignal } from '@rolling/core/safety/rules';
import type { ToolTraceEntry } from '../src/loop';
import type { AccountSnapshot } from '../src/ports';
import type { PlanBody, PlanOptionOut, Proposal } from '../src/types';
import type { EvalCase, PlanCase } from './cases';
import { catalog, graphForCanvas } from './world';

export interface Grade {
  grader: GraderId;
  /** 0 to 1. */
  score: number;
  pass: boolean;
  failures: string[];
}

export const GRADER_IDS = [
  'structure',
  'shots_structured',
  'continuity',
  'duration_math',
  'pills',
  'prompt_format',
  'cost_sanity',
  'reply_text',
  'no_narration',
  'mature_routing',
] as const;
export type GraderId = (typeof GRADER_IDS)[number];

/** What a grader reads: a live `TurnResult`, or one run of a recorded results file. */
export interface GradedTurn {
  text: string;
  reason: string;
  proposal: Proposal | null;
  trace: ToolTraceEntry[];
  toolCalls?: number;
}

export interface GradeContext {
  account: AccountSnapshot;
  /** Failures of the case's invariants (`checkCase`), when they were run. */
  invariantFailures?: string[];
}

// ---------------------------------------------------------------- what would be sent

export interface SentPrompt {
  ref: string;
  title: string;
  kind: 'image' | 'video';
  model: string;
  purpose: PromptPurpose;
  prompt: string;
  negativePrompt?: string;
  composed: boolean;
  mature: boolean;
  chain?: string;
  issues: LintIssue[];
}

export interface SentRun {
  prompts: SentPrompt[];
  /** Nodes the run would not start, with the reason. */
  blocked: string[];
  items: PlanItem[];
}

/**
 * The provider requests a canvas would make on "Run all": structural plan,
 * generation plan (models, mature routing, chains), then one request per item.
 */
export async function sentRun(state: GraphState, account: Pick<AccountSnapshot, 'plan' | 'matureAllowed'>, opts: { strict?: boolean } = {}): Promise<SentRun> {
  const digests = computeInputDigests(state, new Map());
  const structural = planStructure(state, new Map(), digests, 'all', []);
  const plan = await planGeneration({ graph: state, structural, catalog, ctx: { plan: account.plan, matureAllowed: account.matureAllowed } });
  const prompts: SentPrompt[] = [];
  const blocked: string[] = [];
  for (const item of plan.items) {
    if (item.action === 'blocked') {
      blocked.push(`${item.title}: ${item.reason ?? item.code ?? 'blocked'}`);
      continue;
    }
    if (item.action !== 'run' || !item.spec) continue;
    const model = catalog.get(item.spec.modelId);
    if (!model) {
      blocked.push(`${item.title}: model ${item.spec.modelId} is not in the catalog`);
      continue;
    }
    const resolved = (item.spec.inputs as GenInput[])
      .filter((i) => i.media !== 'text')
      .map((input, i) => ({ input, url: `https://media.eval.test/${item.ref}/${i}`, origin: 'generated' as const }));
    const req = buildGenerateRequest(item.spec, model, resolved);
    const purpose: PromptPurpose = item.spec.kind === 'image' ? 'still' : req.firstFrameUrl ? 'animate' : 'video';
    prompts.push({
      ref: item.ref,
      title: item.title,
      kind: item.spec.kind,
      model: model.id,
      purpose,
      prompt: req.prompt,
      ...(req.negativePrompt !== undefined && { negativePrompt: req.negativePrompt }),
      composed: (req as { promptComposed?: boolean }).promptComposed === true,
      mature: item.spec.mature,
      ...(item.spec.chain && { chain: item.spec.chain.step }),
      // Word targets apply to prompts written for the model; a prompt someone typed is only checked for hard problems.
      issues: lintPrompt(req.prompt, model, { purpose, strict: opts.strict || (req as { promptComposed?: boolean }).promptComposed === true }),
    });
  }
  return { prompts, blocked, items: plan.items };
}

const EMPTY: GraphState = { revision: 0, nodes: [], edges: [], groups: [] };

function applied(base: GraphState, ops: readonly LocalOp[]): GraphState | null {
  const res = applyGraphOps(base, ops as LocalOp[], { actor: 'agent' });
  return res.ok ? res.state : null;
}

/** The canvases a proposal would leave behind: one per plan option, or the patched canvas. */
export function canvasesOf(c: EvalCase, proposal: Proposal | null): { label: string; state: GraphState; option?: PlanOptionOut; only?: Set<string> }[] {
  if (!proposal) return [];
  if (proposal.body.kind === 'plan') {
    return (proposal.body as PlanBody).options.flatMap((option, i) => {
      const state = applied(EMPTY, option.ops);
      return state ? [{ label: `option ${i}`, state, option }] : [];
    });
  }
  if (proposal.body.kind === 'graphPatch') {
    const base = graphForCanvas(c.canvas);
    const state = applied(base, proposal.body.ops);
    if (!state) return [];
    // Only the nodes the patch adds or changes are the proposal's work; the rest of the canvas is the user's.
    const before = new Map(base.nodes.map((n) => [n.id, JSON.stringify(n.params)]));
    const only = new Set(state.nodes.filter((n) => before.get(n.id) !== JSON.stringify(n.params)).map((n) => n.id));
    return [{ label: 'canvas', state, only }];
  }
  return [];
}

// ---------------------------------------------------------------- graders

const grade = (grader: GraderId, failures: string[], score?: number): Grade => {
  const s = score ?? (failures.length ? 0 : 1);
  return { grader, score: Math.max(0, Math.min(1, s)), pass: failures.length === 0, failures };
};

function planOf(turn: GradedTurn): PlanBody | null {
  return turn.proposal?.body.kind === 'plan' ? (turn.proposal.body as PlanBody) : null;
}

/** Every planned shot is made of fields, and its nodes carry the shot the prompt was written from. */
function shotsStructured(c: EvalCase, turn: GradedTurn): Grade | null {
  const plan = planOf(turn);
  if (!plan) return null;
  const failures: string[] = [];
  let total = 0;
  let ok = 0;
  plan.options.forEach((o, i) => {
    for (const s of o.shots) {
      total++;
      const nodes = o.ops.filter((op) => op.op === 'addNode' && (op.tempId === `shot${s.n}` || op.tempId === `key${s.n}`));
      if (s.shot && nodes.every((op) => op.op === 'addNode' && typeof op.params.shot === 'object')) ok++;
      else failures.push(`option ${i} shot ${s.n}: free-text prompt, no shot fields`);
    }
  });
  return grade('shots_structured', failures.slice(0, 6), total ? ok / total : 0);
}

const STOP = new Set('a an the of in on at to and with for from by is are as its it this that her his their into over under near then while'.split(' '));

/** A phrase of `n` words that is in every text (free-text plans: "same description words every time"). */
export function sharedPhrase(texts: readonly string[], n = 4): string | null {
  if (texts.length < 2) return null;
  const grams = (t: string) => {
    const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n);
      if (g.filter((w) => !STOP.has(w)).length >= 3) out.add(g.join(' '));
    }
    return out;
  };
  const [first, ...rest] = texts.map(grams);
  for (const g of first!) if (rest.every((r) => r.has(g))) return g;
  return null;
}

/**
 * Recurring characters keep one look: declared once, the same descriptor in
 * every prompt that draws them (keyframes and text-to-video clips), and the
 * keyframes of their shots drawn from one shared reference picture.
 * Free-text plans get half credit when the shots at least share a phrase.
 */
async function continuity(c: EvalCase, turn: GradedTurn, ctx: GradeContext): Promise<Grade | null> {
  if (c.kind !== 'plan' || !c.expect.recurring) return null;
  const plan = planOf(turn);
  if (!plan) return grade('continuity', ['no plan']);
  const failures: string[] = [];
  let score = 0;
  for (const [i, o] of plan.options.entries()) {
    const chars = o.characters ?? [];
    if (chars.length < c.expect.recurring) {
      const phrase = o.shots.length > 1 ? sharedPhrase(o.shots.map((s) => s.visual)) : null;
      failures.push(`option ${i}: ${chars.length} declared character(s), the story needs ${c.expect.recurring}${phrase ? ` (shots share "${phrase}")` : ''}`);
      if (phrase) score += 0.5;
      continue;
    }
    const state = applied(EMPTY, o.ops);
    const run = state ? await sentRun(state, ctx.account) : null;
    let ok = true;
    for (const ch of chars) {
      const descriptor = characterDescriptor(ch);
      const shots = o.shots.filter((s) => s.shot?.characters?.some((x) => x.name === ch.name));
      if (shots.length === 0) {
        failures.push(`option ${i}: ${ch.name} is declared but in no shot`);
        ok = false;
        continue;
      }
      for (const s of shots) {
        // The descriptor must reach the model that draws the character: the keyframe, or the clip itself without one.
        const drawn = run?.prompts.find((p) => p.ref.endsWith(s.mode === 'i2v' ? `key${s.n}` : `shot${s.n}`) || p.title.startsWith(s.mode === 'i2v' ? `Keyframe ${s.n}:` : `Shot ${s.n}:`));
        if (!drawn || !drawn.prompt.includes(descriptor)) {
          failures.push(`option ${i} shot ${s.n}: ${ch.name}'s description is not in the prompt that draws the shot`);
          ok = false;
        }
      }
      const keyed = shots.filter((s) => s.mode === 'i2v');
      if (keyed.length >= 2) {
        const refsOf = (n: number) => o.ops.filter((op) => op.op === 'connect' && op.to.node === `key${n}` && op.to.port === 'refs').map((op) => (op.op === 'connect' ? op.from.node : ''));
        const shared = refsOf(keyed[0]!.n).filter((r) => keyed.every((s) => refsOf(s.n).includes(r)));
        if (shared.length === 0) {
          failures.push(`option ${i}: ${ch.name}'s keyframes share no reference picture`);
          ok = false;
        }
      }
    }
    if (ok) score += 1;
  }
  return grade('continuity', failures.slice(0, 6), plan.options.length ? score / plan.options.length : 0);
}

/** Lengths: whole seconds, the total within 10%, speech and lines that fit their shot. */
function durationMath(c: EvalCase, turn: GradedTurn): Grade | null {
  const plan = planOf(turn);
  if (!plan || c.kind !== 'plan') return null;
  const failures: string[] = [];
  const target = c.expect.seconds ?? plan.seconds;
  plan.options.forEach((o, i) => {
    const sum = o.shots.reduce((s, x) => s + x.seconds, 0);
    if (Math.abs(sum - target) > target * 0.1 + 1e-9) failures.push(`option ${i}: ${sum}s, want ${target}s within 10%`);
    if (Math.abs(sum - o.seconds) > 1e-6) failures.push(`option ${i}: stored length ${o.seconds}s is not the sum of its shots (${sum}s)`);
    for (const s of o.shots) {
      if (!Number.isInteger(s.seconds)) failures.push(`option ${i} shot ${s.n}: ${s.seconds}s is not a whole second`);
      const range = catalog.get(s.model)?.seconds;
      if (range && (s.seconds < range.min || s.seconds > range.max)) failures.push(`option ${i} shot ${s.n}: ${s.seconds}s outside ${range.min}-${range.max}s of ${s.model}`);
      const spoken = (s.shot?.dialogue ?? []).reduce((n, d) => n + wordCount(d.line), 0);
      if (spoken > Math.ceil(s.seconds * 3)) failures.push(`option ${i} shot ${s.n}: ${spoken} spoken words in ${s.seconds}s`);
      if (s.line && wordCount(s.line) > Math.ceil(s.seconds * 4)) failures.push(`option ${i} shot ${s.n}: line of ${wordCount(s.line)} words in ${s.seconds}s`);
    }
  });
  return grade('duration_math', failures.slice(0, 6));
}

/** The prompt box's pills hold unless the brief itself asks for something else (the case's expectation says which). */
function pills(c: EvalCase, turn: GradedTurn): Grade | null {
  if (c.kind !== 'plan' || !c.settings) return null;
  const plan = planOf(turn);
  if (!plan) return grade('pills', ['no plan']);
  const failures: string[] = [];
  const e = c.expect;
  plan.options.forEach((o, i) => {
    if (e.ratio && o.ratio !== e.ratio) failures.push(`option ${i}: ratio ${o.ratio}, want ${e.ratio}`);
    if (e.seconds && Math.abs(o.seconds - e.seconds) > e.seconds * 0.1 + 1e-9) failures.push(`option ${i}: ${o.seconds}s, want ${e.seconds}s`);
    if (e.resolution) for (const s of o.shots) if (s.resolution !== e.resolution) failures.push(`option ${i} shot ${s.n}: ${s.resolution}, want ${e.resolution}`);
  });
  if (e.model && !plan.options.some((o) => o.shots.every((s) => s.model === e.model))) failures.push(`no option uses ${e.model} for every shot`);
  return grade('pills', failures.slice(0, 6));
}

/** Every prompt a run would send fits its model's format: length, language, required parts, no filler or markup. */
async function promptFormat(c: EvalCase, turn: GradedTurn, ctx: GradeContext): Promise<Grade | null> {
  const canvases = canvasesOf(c, turn.proposal);
  if (canvases.length === 0) return null;
  const failures: string[] = [];
  let total = 0;
  let clean = 0;
  for (const cv of canvases) {
    // A plan's prompts are all the agent's writing; on a patched canvas free text follows the user's own wording.
    const run = await sentRun(cv.state, ctx.account, { strict: cv.option !== undefined });
    for (const b of run.blocked) failures.push(`${cv.label}: would not run (${b})`);
    total += run.blocked.length;
    for (const p of run.prompts) {
      if (cv.only && !cv.only.has(p.ref)) continue;
      total++;
      if (p.issues.length === 0) clean++;
      else failures.push(`${cv.label} ${p.title} [${p.model}, ${p.purpose}]: ${p.issues.map((x) => `${x.code} (${x.detail})`).join('; ')}`);
    }
  }
  if (total === 0) return null;
  return grade('prompt_format', failures.slice(0, 8), clean / total);
}

/** Estimates add up, nothing paid is orphaned or unpriced, and one option fits the balance (or the budget the brief names). */
function costSanity(c: EvalCase, turn: GradedTurn, ctx: GradeContext): Grade | null {
  const plan = planOf(turn);
  if (!plan || c.kind !== 'plan') return null;
  const failures: string[] = [];
  const available = ctx.account.balance.plan + ctx.account.balance.purchased - ctx.account.balance.held;
  plan.options.forEach((o, i) => {
    const sum = o.estimate.items.reduce((s, x) => s + x.credits, 0);
    if (sum !== o.estimate.credits) failures.push(`option ${i}: estimate ${o.estimate.credits} is not the sum of its lines (${sum})`);
    const paid = o.ops.filter((op) => op.op === 'addNode' && (op.kind === 'image' || op.kind === 'video'));
    for (const op of paid) {
      if (op.op !== 'addNode') continue;
      if (!o.estimate.items.some((x) => x.ref === op.tempId)) failures.push(`option ${i}: ${op.tempId} is not in the estimate`);
      if (op.kind === 'image' && !o.ops.some((x) => x.op === 'connect' && x.from.node === op.tempId)) failures.push(`option ${i}: picture ${op.tempId} feeds nothing but would cost credits`);
    }
    for (const s of o.shots) if (s.mode === 't2v' && paid.some((op) => op.op === 'addNode' && op.tempId === `key${s.n}`)) failures.push(`option ${i} shot ${s.n}: keyframe for a text-to-video shot`);
    if (o.estimate.needsConfirm !== o.estimate.credits > ctx.account.confirmThreshold) failures.push(`option ${i}: confirm flag does not match the threshold`);
  });
  const cheapest = Math.min(...plan.options.map((o) => o.estimate.credits));
  const hint = c.expect.maxCredits ?? available;
  if (cheapest > hint) failures.push(`cheapest option ${cheapest} credits is above ${hint}`);
  return grade('cost_sanity', failures.slice(0, 6));
}

const EMOJI = /\p{Extended_Pictographic}/u;
const CLAIMS = /\b(i have|i've|has been|have been|was) (generated|charged|applied|created|built|made)\b/i;
const HYPE = /\b(amazing|magic(?:al)?|stunning|epic)\b/i;
const CREDIT_NUMBER = /\d[\d,.]*\s*(?:credits?|クレジット|积分|點數|点数|크레딧)/i;

/** The reply: short, no emoji, no hype, no false claims, and no credit numbers next to a plan (the card shows them). */
function replyText(c: EvalCase, turn: GradedTurn): Grade | null {
  const failures: string[] = [];
  const t = turn.text;
  if (EMOJI.test(t)) failures.push('emoji');
  if (/!/.test(t)) failures.push('exclamation mark');
  if (HYPE.test(t)) failures.push(`hype word "${HYPE.exec(t)?.[0]}"`);
  if (CLAIMS.test(t)) failures.push('claims something was done');
  if (turn.proposal?.kind === 'plan' && CREDIT_NUMBER.test(t)) failures.push(`credit number in the reply ("${CREDIT_NUMBER.exec(t)?.[0]}")`);
  if (turn.proposal && t.length > 600) failures.push(`${t.length} characters next to a proposal`);
  return grade('reply_text', failures);
}

/**
 * Tool-call narration: the reply never says what the assistant is about to
 * read or do ("I'll check the models", "Let me look at the canvas", "Checking
 * models"). English, Chinese, Japanese, German and Spanish forms.
 */
export const NARRATION: readonly RegExp[] = [
  /\b(?:i['’]ll|i will|i am going to|i['’]m going to|let me|let['’]s|first,? i(?:['’]ll| will)?|now i(?:['’]ll| will)?)\s+(?:quickly\s+|first\s+|just\s+|now\s+)?(?:check|look|read|fetch|pull|get|see|review|inspect|load|grab|find|search|examine|start by|begin by|take a look)\b/i,
  /\b(?:checking|looking up|looking at|reading|fetching|loading|reviewing|inspecting|pulling up|searching)\s+(?:the\s+|your\s+|available\s+|video\s+|image\s+)*(?:models?|canvas|timeline|script|assets?|account|balance|capabilities|pricing|templates?|characters?|voices?|nodes?)\b/i,
  /\b(?:before (?:planning|proposing|i plan|i propose))\b/i,
  /(?:我先|让我|讓我|我来|我來|先)(?:查看|查一下|看看|看一下|检查|檢查|读取|讀取|获取|獲取|确认|確認)/,
  /(?:まず|最初に).{0,12}(?:確認|チェック|調べ|見て)/,
  /\b(?:ich (?:prüfe|schaue|sehe|überprüfe)|lass mich|zuerst (?:prüfe|schaue))\b/i,
  /\b(?:voy a (?:revisar|comprobar|consultar|mirar)|déjame (?:revisar|comprobar|ver)|primero (?:reviso|compruebo))\b/i,
];

function noNarration(_c: EvalCase, turn: GradedTurn): Grade | null {
  const hit = NARRATION.map((re) => re.exec(turn.text)?.[0]).find(Boolean);
  return grade('no_narration', hit ? [`reply narrates a tool call: "${hit}"`] : []);
}

/**
 * D-005 routing of a mature-allowed member's explicit fictional scene: a plan
 * is proposed, and every run with explicit text goes out as a mature run on a
 * model that takes one (a text-only clip as keyframe then animation). Nothing
 * would be blocked.
 */
async function matureRouting(c: EvalCase, turn: GradedTurn, ctx: GradeContext): Promise<Grade | null> {
  if (c.kind !== 'plan' || !c.expect.mature) return null;
  const canvases = canvasesOf(c, turn.proposal);
  if (canvases.length === 0) return grade('mature_routing', ['no plan for content this member may make']);
  const failures: string[] = [];
  for (const cv of canvases) {
    const run = await sentRun(cv.state, ctx.account);
    for (const b of run.blocked) failures.push(`${cv.label}: blocked (${b})`);
    const explicit = run.items.filter((i) => i.action === 'run' && i.spec && explicitSignal(i.spec.prompt).length > 0);
    if (explicit.length === 0) failures.push(`${cv.label}: no run carries the scene the brief asked for`);
    for (const i of explicit) {
      const model = catalog.get(i.spec!.modelId);
      if (!i.spec!.mature) failures.push(`${cv.label} ${i.title}: explicit prompt on a run that is not mature`);
      else if (!model || model.matureRouting === 'never') failures.push(`${cv.label} ${i.title}: mature run on ${i.spec!.modelId}, which takes none`);
    }
  }
  return grade('mature_routing', failures.slice(0, 6));
}

/** Runs every grader that applies to the case. */
export async function gradeTurn(c: EvalCase, turn: GradedTurn, ctx: GradeContext): Promise<Grade[]> {
  const out: (Grade | null)[] = [
    ctx.invariantFailures ? grade('structure', ctx.invariantFailures.slice(0, 8)) : null,
    shotsStructured(c, turn),
    await continuity(c, turn, ctx),
    durationMath(c, turn),
    pills(c, turn),
    await promptFormat(c, turn, ctx),
    costSanity(c, turn, ctx),
    replyText(c, turn),
    noNarration(c, turn),
    await matureRouting(c, turn, ctx),
  ];
  return out.filter((g): g is Grade => g !== null);
}

export interface Scorecard {
  cases: number;
  /** Per grader: cases it applied to, cases that passed, mean score. */
  graders: Record<string, { cases: number; passed: number; score: number }>;
  /** Mean of the grader means. */
  overall: number;
}

export function scorecard(runs: readonly { grades: Grade[] }[]): Scorecard {
  const graders: Scorecard['graders'] = {};
  for (const id of GRADER_IDS) {
    const all = runs.flatMap((r) => r.grades.filter((g) => g.grader === id));
    if (all.length === 0) continue;
    graders[id] = { cases: all.length, passed: all.filter((g) => g.pass).length, score: Math.round((all.reduce((s, g) => s + g.score, 0) / all.length) * 1000) / 1000 };
  }
  const means = Object.values(graders).map((g) => g.score);
  return { cases: runs.length, graders, overall: means.length ? Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 1000) / 1000 : 0 };
}

export type { PlanCase };
