/**
 * Offline graders for the result review (D-024): given what the reviewer said
 * about a job's takes and the run's context, is the right thing done? No model
 * is called; the verdicts are written the way the reviewer answers (raw JSON),
 * so parsing, scoring, ranking, the retry decision, the version pick and the
 * agent's context line are all graded on the same path production uses.
 *
 * Graders (0 or 1 per case; null when it does not apply):
 * - `action`: none / offer / auto as the case expects (Auto retries once, within the budget; never a retry of a retry).
 * - `best_take`: the preselected take of a multi-take run.
 * - `keeps_better`: after an Auto retry, the better version stays current.
 * - `fix_applies`: "Retry with fix" changes the node (prompt, negative terms or seed) and keeps unrelated params.
 * - `agent_line`: the agent's context names the problem node with its worst issue, and leaves good nodes out.
 */
import type { GraphNode, GraphState } from '@rolling/core/graph';
import {
  buildReview,
  decideRetry,
  fixParams,
  overallScore,
  parseReviewAnswer,
  pickCurrent,
  summarizeReview,
  takeVerdict,
  type RetryContext,
  type ResultReview,
  type ReviewAction,
} from '@rolling/core/review';
import { reviewLines } from '../src/context';

export const REVIEW_GRADER_IDS = ['action', 'best_take', 'keeps_better', 'fix_applies', 'agent_line'] as const;
export type ReviewGraderId = (typeof REVIEW_GRADER_IDS)[number];

export interface ReviewCase {
  id: string;
  /** The reviewer's raw answer. */
  answer: string;
  takes: number;
  ctx: RetryContext;
  expect: {
    action: ReviewAction['kind'];
    reason?: string;
    best?: number;
    /** Raw answer of the retry's review, and which version should stay current. */
    retry?: { answer: string; current: 'original' | 'retry' };
    /** The node's params before the fix (fix_applies). */
    params?: Record<string, unknown>;
    /** Words the agent's context line must carry (agent_line); [] = the node must not be listed. */
    agentMentions?: string[];
  };
}

export interface ReviewGrade {
  grader: ReviewGraderId;
  pass: boolean;
  failures: string[];
}

const S = (s: Partial<Record<string, number | null>>) => ({ anatomy: 5, text: 5, adherence: 5, continuity: null, framing: 5, artifacts: 5, ...s });
const answer = (...takes: { scores: Record<string, number | null>; issues?: unknown[]; fix?: unknown }[]) => JSON.stringify({ takes: takes.map((t) => ({ issues: [], fix: null, ...t })) });

const HANDS = { dimension: 'anatomy', severity: 'major', note: 'Left hand has six fingers' };
const HANDS_FIX = { prompt: 'A chef plating pasta, relaxed hands with five fingers each', negativePrompt: 'extra fingers, fused fingers', note: 'Asks for natural hands' };
const LOGO = { dimension: 'text', severity: 'major', note: 'Made-up logo on the mug' };
const LOGO_FIX = { negativePrompt: 'logo, text, watermark', note: 'Removes the logo' };
const COUNT = { dimension: 'adherence', severity: 'major', note: 'One dog, the prompt asks for two' };
const COUNT_FIX = { prompt: 'Two golden retrievers running on a beach', note: 'Makes the count explicit' };
const COAT = { dimension: 'continuity', severity: 'major', note: 'Coat is blue, not red' };
const COAT_FIX = { prompt: 'Mara, short silver hair, red wool coat, walks through a night market', note: 'Restates the red coat' };
const MELT = { dimension: 'artifacts', severity: 'major', note: 'Background melts between frames' };

const edit = (over: Partial<RetryContext> = {}): RetryContext => ({ mode: 'edit', isRetry: false, nodeRetried: false, retryCredits: 40, budgetLeft: null, hasNode: true, ...over });
const auto = (over: Partial<RetryContext> = {}): RetryContext => edit({ mode: 'auto', budgetLeft: 300, ...over });

export const REVIEW_CASES: ReviewCase[] = [
  { id: 'good-image-edit', answer: answer({ scores: S({}) }), takes: 1, ctx: edit(), expect: { action: 'none', agentMentions: [] } },
  { id: 'good-image-auto', answer: answer({ scores: S({}) }), takes: 1, ctx: auto(), expect: { action: 'none', agentMentions: [] } },
  { id: 'minor-issue-only', answer: answer({ scores: S({ framing: 4 }), issues: [{ dimension: 'framing', severity: 'minor', note: 'Slightly tight on the left' }] }), takes: 1, ctx: auto(), expect: { action: 'none', agentMentions: [] } },
  {
    id: 'hands-edit-offer',
    answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }),
    takes: 1,
    ctx: edit(),
    expect: { action: 'offer', reason: 'manual', params: { prompt: 'A chef plating pasta', negativePrompt: 'blur', model: 'm1', seconds: 5 }, agentMentions: ['hands', 'six fingers', 'Retry with fix'] },
  },
  { id: 'hands-read-offer', answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }), takes: 1, ctx: edit({ mode: 'read' }), expect: { action: 'offer', reason: 'manual' } },
  {
    id: 'hands-auto-retry',
    answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }),
    takes: 1,
    ctx: auto(),
    expect: { action: 'auto', retry: { answer: answer({ scores: S({ anatomy: 4 }) }), current: 'retry' }, agentMentions: ['six fingers'] },
  },
  {
    id: 'auto-retry-worse-keeps-original',
    answer: answer({ scores: S({ anatomy: 3, adherence: 2 }), issues: [COUNT], fix: COUNT_FIX }),
    takes: 1,
    ctx: auto(),
    expect: { action: 'auto', retry: { answer: answer({ scores: S({ anatomy: 1, adherence: 4 }), issues: [HANDS] }), current: 'original' } },
  },
  { id: 'auto-over-budget', answer: answer({ scores: S({ text: 1 }), issues: [LOGO], fix: LOGO_FIX }), takes: 1, ctx: auto({ retryCredits: 120, budgetLeft: 100 }), expect: { action: 'offer', reason: 'budget' } },
  { id: 'auto-budget-exact', answer: answer({ scores: S({ text: 1 }), issues: [LOGO], fix: LOGO_FIX }), takes: 1, ctx: auto({ retryCredits: 100, budgetLeft: 100 }), expect: { action: 'auto' } },
  { id: 'auto-node-already-retried', answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }), takes: 1, ctx: auto({ nodeRetried: true }), expect: { action: 'offer', reason: 'retried' } },
  { id: 'auto-retry-of-retry', answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }), takes: 1, ctx: auto({ isRetry: true }), expect: { action: 'offer', reason: 'retried' } },
  { id: 'bad-without-fix', answer: answer({ scores: S({ artifacts: 1 }), issues: [MELT] }), takes: 1, ctx: auto(), expect: { action: 'none', agentMentions: ['melts'] } },
  { id: 'no-node-tool-run', answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }), takes: 1, ctx: auto({ hasNode: false }), expect: { action: 'none' } },
  {
    id: 'logo-negative-terms',
    answer: answer({ scores: S({ text: 2 }), issues: [LOGO], fix: LOGO_FIX }),
    takes: 1,
    ctx: edit(),
    expect: { action: 'offer', params: { prompt: 'A ceramic mug on a desk', negativePrompt: 'Logo, blur' }, agentMentions: ['logo'] },
  },
  {
    id: 'continuity-coat',
    answer: answer({ scores: S({ continuity: 2 }), issues: [COAT], fix: COAT_FIX }),
    takes: 1,
    ctx: edit(),
    expect: { action: 'offer', params: { prompt: 'Mara walks through a night market', shot: { subject: 'Mara' } }, agentMentions: ['red'] },
  },
  {
    id: 'takes-best-is-third',
    answer: answer({ scores: S({ anatomy: 2 }), issues: [HANDS], fix: HANDS_FIX }, { scores: S({ adherence: 3 }) }, { scores: S({}) }, { scores: S({ artifacts: 3 }) }),
    takes: 4,
    ctx: auto(),
    expect: { action: 'none', best: 2, agentMentions: [] },
  },
  {
    id: 'takes-all-bad-best-is-least-bad',
    answer: answer({ scores: S({ anatomy: 1 }), issues: [HANDS], fix: HANDS_FIX }, { scores: S({ adherence: 2 }), issues: [COUNT], fix: COUNT_FIX }),
    takes: 2,
    ctx: edit(),
    expect: { action: 'offer', best: 1, agentMentions: ['two', 'take 2'] },
  },
  {
    id: 'takes-tie-keeps-order',
    answer: answer({ scores: S({ framing: 4 }) }, { scores: S({ framing: 4 }) }),
    takes: 2,
    ctx: edit(),
    expect: { action: 'none', best: 0 },
  },
  { id: 'seed-only-fix', answer: answer({ scores: S({ artifacts: 2 }), issues: [MELT], fix: { newSeed: true, note: 'Same prompt, new seed' } }), takes: 1, ctx: edit(), expect: { action: 'offer', params: { prompt: 'Waves at dusk', seed: 3 } } },
];

function node(id: string, title: string, params: Record<string, unknown> = {}): GraphNode {
  return { id, kind: 'image', title, params, status: 'done', version: { n: 1, total: 1 }, x: 0, y: 0 } as unknown as GraphNode;
}

function reviewOf(raw: string, takes: number): ResultReview {
  return buildReview({ model: 'eval', costUsd: null, takes: parseReviewAnswer(raw, takes, overallScore).map((t) => takeVerdict(t)) });
}

export function gradeReviewCase(c: ReviewCase): ReviewGrade[] {
  const grades: ReviewGrade[] = [];
  const add = (grader: ReviewGraderId, failures: string[]) => grades.push({ grader, pass: failures.length === 0, failures });
  const review = reviewOf(c.answer, c.takes);
  const action = decideRetry(review, c.ctx);

  const af: string[] = [];
  if (action.kind !== c.expect.action) af.push(`action ${action.kind}, expected ${c.expect.action}`);
  if (c.expect.reason && 'reason' in action && action.reason !== c.expect.reason) af.push(`reason ${action.reason}, expected ${c.expect.reason}`);
  add('action', af);

  if (c.expect.best !== undefined) add('best_take', review.best === c.expect.best ? [] : [`best take ${review.best}, expected ${c.expect.best}`]);

  if (c.expect.retry) {
    const retry = reviewOf(c.expect.retry.answer, 1);
    const pick = pickCurrent(review, retry);
    add('keeps_better', pick === c.expect.retry.current ? [] : [`kept ${pick} (${review.score} vs ${retry.score}), expected ${c.expect.retry.current}`]);
  }

  if (c.expect.params && review.fix) {
    const before = c.expect.params;
    const out = fixParams(before, review.fix, () => 0.5);
    const ff: string[] = [];
    if (Object.keys(out).length === 0) ff.push('the fix changes nothing');
    for (const k of Object.keys(out)) if (!['prompt', 'negativePrompt', 'seed'].includes(k)) ff.push(`the fix writes ${k}`);
    if (review.fix.prompt && out.prompt !== review.fix.prompt) ff.push('the revised prompt is not written');
    if (review.fix.negativePrompt) {
      const neg = String(out.negativePrompt ?? before.negativePrompt ?? '').toLowerCase();
      for (const term of review.fix.negativePrompt.split(',').map((t) => t.trim().toLowerCase())) if (!neg.includes(term)) ff.push(`negative prompt misses "${term}"`);
      const had = typeof before.negativePrompt === 'string' ? before.negativePrompt.split(',').map((t) => t.trim()) : [];
      for (const term of had) if (!String(out.negativePrompt ?? before.negativePrompt).includes(term)) ff.push(`negative prompt lost "${term}"`);
      const count = (s: string) => s.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
      const list = count(String(out.negativePrompt ?? ''));
      if (new Set(list).size !== list.length) ff.push('negative prompt repeats a term');
    }
    if (review.fix.newSeed && (out.seed === undefined || out.seed === before.seed)) ff.push('no fresh seed');
    add('fix_applies', ff);
  }

  if (c.expect.agentMentions) {
    const good = node('node_good', 'Opening shot');
    const shot = node('node_x', 'Shot 3');
    const state = { revision: 4, nodes: [good, shot], edges: [] } as unknown as GraphState;
    const withAction = { ...review, action } as ResultReview;
    const goodReview = reviewOf(answer({ scores: S({}) }), 1);
    const text = reviewLines(state, { node_good: summarizeReview(goodReview), node_x: summarizeReview(withAction) }) ?? '';
    const lf: string[] = [];
    if (text.includes('node_good')) lf.push('a node without problems is listed');
    if (c.expect.agentMentions.length === 0) {
      if (text.includes('node_x')) lf.push('a good result is listed');
    } else {
      if (!text.includes('node_x "Shot 3"')) lf.push('the problem node is not named');
      for (const w of c.expect.agentMentions) if (!text.toLowerCase().includes(w.toLowerCase())) lf.push(`context misses "${w}"`);
    }
    add('agent_line', lf);
  }
  return grades;
}

export function reviewScorecard(cases: readonly ReviewCase[] = REVIEW_CASES): Record<ReviewGraderId, { applied: number; passed: number }> {
  const out = Object.fromEntries(REVIEW_GRADER_IDS.map((g) => [g, { applied: 0, passed: 0 }])) as Record<ReviewGraderId, { applied: number; passed: number }>;
  for (const c of cases) {
    for (const g of gradeReviewCase(c)) {
      out[g.grader].applied++;
      if (g.pass) out[g.grader].passed++;
    }
  }
  return out;
}
