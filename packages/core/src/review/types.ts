/**
 * Result review (D-024): the structured verdict a vision-capable chat model
 * gives each generation output, the way a director reviews a take. Scores are
 * 1 (unusable) to 5 (no visible problem) per dimension; null when the
 * dimension does not apply (no character references, no text in the shot).
 */
import { z } from 'zod';

export const REVIEW_DIMENSIONS = ['anatomy', 'text', 'adherence', 'continuity', 'framing', 'artifacts'] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const REVIEW_SEVERITIES = ['minor', 'major'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export type ReviewGrade = 'good' | 'fair' | 'poor';

/** Bumped when the review prompt or the verdict shape changes. */
export const REVIEW_VERSION = 1;

const Score = z.preprocess((v) => {
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}, z.number().min(1).max(5).transform((n) => Math.round(n)).nullable());

const Text = (max: number) => z.string().transform((s) => s.trim().replace(/\s+/g, ' ').slice(0, max));

export const ReviewIssueSchema = z.object({
  dimension: z.enum(REVIEW_DIMENSIONS),
  severity: z.enum(REVIEW_SEVERITIES).catch('minor'),
  note: Text(200).pipe(z.string().min(1)),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

/**
 * A change to the run that should fix what the review found. `prompt` is the
 * whole revised prompt (the user's words kept, the fix added); `negativePrompt`
 * is added to what the node already avoids; `newSeed` asks for a fresh seed.
 */
export const ReviewFixSchema = z.object({
  prompt: Text(4000).optional(),
  negativePrompt: Text(600).optional(),
  newSeed: z.boolean().optional(),
  note: Text(160).pipe(z.string().min(1)),
});
export type ReviewFix = z.infer<typeof ReviewFixSchema>;

const ScoresSchema = z
  .object(Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, Score.optional()])) as Record<ReviewDimension, z.ZodOptional<typeof Score>>)
  .passthrough();

/** One take as the model answers it (lenient: unknown issue dimensions and empty fixes are dropped in `parseReviewAnswer`). */
const TakeAnswerSchema = z.object({
  scores: ScoresSchema,
  issues: z.array(z.unknown()).max(20).default([]),
  fix: z.unknown().optional(),
});

const AnswerSchema = z.object({ takes: z.array(TakeAnswerSchema) });

export type ReviewScores = Record<ReviewDimension, number | null>;

/** The verdict of one output (one take). */
export interface TakeVerdict {
  scores: ReviewScores;
  issues: ReviewIssue[];
  fix: ReviewFix | null;
  /** Overall 1–5, one decimal (`overallScore`). */
  score: number;
  grade: ReviewGrade;
}

/** What is stored on the version (`output.review`), the assets (`meta.review`) and the job (`jobs.review`). */
export interface ResultReview {
  v: typeof REVIEW_VERSION;
  /** Gateway chat model that reviewed. */
  model: string;
  /** Gateway cost of the review (covered from the margin, D-024); null when the gateway did not report it. */
  costUsd: number | null;
  /** One verdict per reviewed output, in output order. */
  takes: TakeVerdict[];
  /** Index of the preselected take (the best one). */
  best: number;
  /** Shortcuts of the best take. */
  score: number;
  grade: ReviewGrade;
  issues: ReviewIssue[];
  fix: ReviewFix | null;
  /** What was done about it (`decideRetry`). */
  action?: ReviewAction;
  /** This job retried an earlier one with its fix. */
  retryOf?: { jobId: string };
}

export type ReviewAction =
  | { kind: 'none' }
  /** The result viewer offers "Retry with fix"; the user runs it. */
  | { kind: 'offer'; reason?: 'budget' | 'retried' | 'manual' }
  /** Auto mode retried once (D-021 budget): the retry run. */
  | { kind: 'auto'; runId: string | null };

/** The compact form the canvas node chip and the agent read. */
export interface ReviewSummary {
  score: number;
  grade: ReviewGrade;
  issues: { dimension: ReviewDimension; severity: ReviewSeverity; note: string }[];
  fix: ReviewFix | null;
  offer: boolean;
  autoRetried: boolean;
  takes: number;
  best: number;
}

export class ReviewParseError extends Error {
  override readonly name = 'ReviewParseError';
}

function firstJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) throw new ReviewParseError('review answer is not JSON');
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      throw new ReviewParseError('review answer is not JSON');
    }
  }
}

/**
 * Parses the reviewer's answer for `count` takes. Lenient where a model drifts
 * (string scores, unknown dimensions, a fix without a note) and strict where it
 * matters: one verdict per take, every score 1–5 or null.
 */
export function parseReviewAnswer(text: string, count: number, overall: (s: ReviewScores, issues: readonly ReviewIssue[]) => number): Omit<TakeVerdict, 'grade'>[] {
  const raw = firstJson(text);
  // A single-take answer without the wrapper is accepted.
  const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && !('takes' in raw) && 'scores' in raw ? { takes: [raw] } : Array.isArray(raw) ? { takes: raw } : raw;
  const parsed = AnswerSchema.safeParse(wrapped);
  if (!parsed.success) throw new ReviewParseError(`review answer failed validation: ${parsed.error.issues[0]?.path.join('.') ?? ''}`);
  if (parsed.data.takes.length !== count) throw new ReviewParseError(`review rated ${parsed.data.takes.length} of ${count} takes`);
  return parsed.data.takes.map((t) => {
    const scores = Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, t.scores[d] ?? null])) as ReviewScores;
    const issues = t.issues.flatMap((i) => {
      const r = ReviewIssueSchema.safeParse(i);
      return r.success ? [r.data] : [];
    });
    let fix: ReviewFix | null = null;
    if (t.fix && typeof t.fix === 'object') {
      const f = t.fix as Record<string, unknown>;
      const note = typeof f.note === 'string' && f.note.trim() ? f.note : issues[0]?.note ?? 'Retry with the fix';
      const r = ReviewFixSchema.safeParse({ ...f, note });
      if (r.success && (r.data.prompt || r.data.negativePrompt || r.data.newSeed)) {
        fix = {
          ...(r.data.prompt && { prompt: r.data.prompt }),
          ...(r.data.negativePrompt && { negativePrompt: r.data.negativePrompt }),
          ...(r.data.newSeed && { newSeed: true }),
          note: r.data.note,
        };
      }
    }
    return { scores, issues: issues.slice(0, 8), fix, score: overall(scores, issues) };
  });
}
