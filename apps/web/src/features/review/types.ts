/**
 * D-024 result review as the web reads it: the summary the server keeps on a
 * node version (`output.review`, ProjectRoom `quality`). Mirrors
 * `ReviewSummary` / `ResultReview` in `@rolling/core/review`.
 */
import { fixParams, summarizeReview, type ResultReview, type ReviewSummary } from '@rolling/core/review';

export type ReviewView = ReviewSummary & {
  /** Auto mode skipped the retry because it was over the turn's budget. */
  overBudget?: boolean;
};

/** The view of a version's `output.review`, or undefined when it has none (or an unreadable one). */
export function reviewViewOf(raw: unknown): ReviewView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as ResultReview;
  if (typeof r.score !== 'number' || !Array.isArray(r.takes) || !Array.isArray(r.issues)) return undefined;
  const s = summarizeReview(r);
  return { ...s, ...(r.action?.kind === 'offer' && r.action.reason === 'budget' && { overBudget: true }) };
}

/**
 * The canvas op "Retry with fix" commits before it runs the node: the fix's
 * prompt, the extra negative terms and a fresh seed when the fix asks for one.
 * Null when the review has no fix or the result is already good.
 */
export function retryWithFixOp(node: { id: string; params: Readonly<Record<string, unknown>> }, review: ReviewView | undefined, random?: () => number): { op: 'updateNode'; nodeId: string; params: Record<string, unknown> } | null {
  if (!review?.fix || review.grade === 'good') return null;
  return { op: 'updateNode', nodeId: node.id, params: fixParams(node.params, review.fix, random) };
}
