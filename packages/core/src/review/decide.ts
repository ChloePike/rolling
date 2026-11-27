/**
 * What a review means for the run (D-024): the overall score, the best take,
 * whether to offer or start a retry with the fix, and which of two versions
 * stays current. Pure functions; the Generate workflow and the UI call them.
 */
import {
  REVIEW_DIMENSIONS,
  REVIEW_VERSION,
  type ResultReview,
  type ReviewAction,
  type ReviewFix,
  type ReviewGrade,
  type ReviewIssue,
  type ReviewScores,
  type ReviewSummary,
  type TakeVerdict,
} from './types';

/** A dimension at or below this score is a problem worth a retry. */
export const RETRY_SCORE_AT_OR_BELOW = 2;
/** Overall score bands. */
export const GRADE_BANDS = { good: 4, fair: 3 } as const;
/** A major issue caps the overall score below "fair". */
export const MAJOR_ISSUE_CAP = 2.5;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Overall 1–5: half the worst dimension, half the mean of the scored ones, so
 * one bad hand sinks a take the way it would for a director. A major issue
 * caps the overall at MAJOR_ISSUE_CAP (poor). No scored dimension → 3 (unknown, not good).
 */
export function overallScore(scores: ReviewScores, issues: readonly Pick<ReviewIssue, 'severity'>[] = []): number {
  const vals = REVIEW_DIMENSIONS.map((d) => scores[d]).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return 3;
  const min = Math.min(...vals);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const score = round1(0.5 * min + 0.5 * mean);
  return issues.some((i) => i.severity === 'major') ? Math.min(score, MAJOR_ISSUE_CAP) : score;
}

export function gradeOf(score: number): ReviewGrade {
  return score >= GRADE_BANDS.good ? 'good' : score >= GRADE_BANDS.fair ? 'fair' : 'poor';
}

export function takeVerdict(v: Omit<TakeVerdict, 'grade' | 'score'> & { score?: number }): TakeVerdict {
  const score = v.score ?? overallScore(v.scores, v.issues);
  return { scores: v.scores, issues: v.issues, fix: v.fix, score, grade: gradeOf(score) };
}

/** A take needs another try: a dimension at 2 or below, or a major issue. */
export function needsRetry(t: Pick<TakeVerdict, 'scores' | 'issues'>): boolean {
  if (t.issues.some((i) => i.severity === 'major')) return true;
  return REVIEW_DIMENSIONS.some((d) => {
    const s = t.scores[d];
    return typeof s === 'number' && s <= RETRY_SCORE_AT_OR_BELOW;
  });
}

function majors(t: Pick<TakeVerdict, 'issues'>): number {
  return t.issues.filter((i) => i.severity === 'major').length;
}

/** Take indices, best first: overall score, then fewer major issues, then the worst dimension, then output order. */
export function rankTakes(takes: readonly Pick<TakeVerdict, 'score' | 'issues' | 'scores'>[]): number[] {
  const worst = (t: Pick<TakeVerdict, 'scores'>) => Math.min(...REVIEW_DIMENSIONS.map((d) => t.scores[d] ?? 5));
  return takes
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.score - a.t.score || majors(a.t) - majors(b.t) || worst(b.t) - worst(a.t) || a.i - b.i)
    .map((x) => x.i);
}

/** The stored review of a job's outputs, with the best take preselected. */
export function buildReview(input: { model: string; costUsd: number | null; takes: TakeVerdict[] }): ResultReview {
  if (input.takes.length === 0) throw new RangeError('a review needs at least one take');
  const best = rankTakes(input.takes)[0]!;
  const t = input.takes[best]!;
  return { v: REVIEW_VERSION, model: input.model, costUsd: input.costUsd, takes: input.takes, best, score: t.score, grade: t.grade, issues: t.issues, fix: t.fix };
}

/** D-021 agent modes as the review reads them; runs the user started without the agent count as `edit`. */
export type ReviewMode = 'read' | 'edit' | 'auto';

export interface RetryContext {
  mode: ReviewMode;
  /** This job is itself a retry with a review fix (never retried again automatically). */
  isRetry: boolean;
  /** The node was already retried automatically in this Auto turn. */
  nodeRetried: boolean;
  /** Credits the retry would hold (its quote), null when unknown. */
  retryCredits: number | null;
  /** What is left of the Auto turn's budget, null when the run has none. */
  budgetLeft: number | null;
  /** The output belongs to a canvas node (only nodes can be retried with a fix). */
  hasNode: boolean;
}

/**
 * What to do with a review. Nothing when the best take is fine or the review
 * has no fix. Auto mode retries once per node when the retry fits what is left
 * of the turn's budget; otherwise (and in Read and Edit mode, and for retries)
 * the result viewer offers "Retry with fix" and the user decides.
 */
export function decideRetry(review: Pick<ResultReview, 'takes' | 'best' | 'fix'>, ctx: RetryContext): ReviewAction {
  const best = review.takes[review.best];
  if (!best || !needsRetry(best) || !review.fix || !ctx.hasNode) return { kind: 'none' };
  if (ctx.isRetry) return { kind: 'offer', reason: 'retried' };
  if (ctx.mode !== 'auto') return { kind: 'offer', reason: 'manual' };
  if (ctx.nodeRetried) return { kind: 'offer', reason: 'retried' };
  if (ctx.retryCredits === null || ctx.budgetLeft === null || ctx.retryCredits > ctx.budgetLeft) return { kind: 'offer', reason: 'budget' };
  return { kind: 'auto', runId: null };
}

/**
 * Which version stays current after an Auto retry: the better best take
 * (`rankTakes`: score, then fewer major issues, then the worst dimension); a
 * tie keeps the retry (it carries the fix). Unreviewed sides lose to reviewed
 * ones; neither reviewed keeps the retry.
 */
export function pickCurrent(original: Pick<ResultReview, 'takes' | 'best'> | null, retry: Pick<ResultReview, 'takes' | 'best'> | null): 'original' | 'retry' {
  const o = original?.takes[original.best];
  const r = retry?.takes[retry.best];
  if (!r) return o ? 'original' : 'retry';
  if (!o) return 'retry';
  return rankTakes([r, o])[0] === 0 ? 'retry' : 'original';
}

/** Compact form for the node chip, the agent context and the web. */
export function summarizeReview(r: ResultReview): ReviewSummary {
  return {
    score: r.score,
    grade: r.grade,
    issues: r.issues.slice(0, 4).map((i) => ({ dimension: i.dimension, severity: i.severity, note: i.note })),
    fix: r.fix,
    offer: r.action?.kind === 'offer',
    autoRetried: r.action?.kind === 'auto',
    takes: r.takes.length,
    best: r.best,
  };
}

/**
 * The node params a "Retry with fix" writes: the revised prompt, the extra
 * negative terms appended to the node's own, and a fresh seed. Params the fix
 * does not name stay as they are.
 */
export function fixParams(params: Readonly<Record<string, unknown>>, fix: ReviewFix, random: () => number = Math.random): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fix.prompt && fix.prompt !== params.prompt) out.prompt = fix.prompt;
  if (fix.negativePrompt) {
    const current = typeof params.negativePrompt === 'string' ? params.negativePrompt.trim() : '';
    const have = new Set(current.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const add = fix.negativePrompt
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !have.has(s.toLowerCase()));
    if (add.length) out.negativePrompt = [current, ...add].filter(Boolean).join(', ');
  }
  if (fix.newSeed || (!out.prompt && !out.negativePrompt)) out.seed = Math.floor(random() * 2_147_483_647);
  return out;
}

/** Ratio as a number (`16:9` → 1.777…), null when unreadable. */
export function ratioValue(ratio: string | undefined | null): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(ratio ?? '');
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** Deterministic framing check: the output's pixel size against the declared ratio (3% tolerance). */
export function ratioIssue(declared: string | undefined, width: number | undefined, height: number | undefined): ReviewIssue | null {
  const want = ratioValue(declared);
  if (!want || !width || !height) return null;
  const got = width / height;
  if (Math.abs(got - want) / want <= 0.03) return null;
  return { dimension: 'framing', severity: 'major', note: `Output is ${width}×${height}, not ${declared}` };
}

/** Folds the deterministic ratio check into a take: the framing score drops to 2 and the issue is listed first. */
export function withRatioCheck(t: TakeVerdict, issue: ReviewIssue | null): TakeVerdict {
  if (!issue) return t;
  const scores = { ...t.scores, framing: Math.min(t.scores.framing ?? 5, 2) };
  const issues = [issue, ...t.issues.filter((i) => i.dimension !== 'framing' || i.note !== issue.note)];
  return takeVerdict({ scores, issues, fix: t.fix });
}
