/**
 * Project activity feed (D-031): edits, runs, comments and review events,
 * newest first. Kept in the ProjectRoom (SQLite `activity`), streamed as the
 * project event `activity.added` (a coalesced edit entry is re-sent with the
 * same id and a higher `count`).
 */

export type ActivityKind =
  | 'edit'
  | 'run.started'
  | 'run.done'
  | 'run.failed'
  | 'comment'
  | 'comment.resolved'
  | 'comment.reopened'
  | 'review.created'
  | 'review.revoked'
  | 'review.comment'
  | 'review.decision';

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'edit',
  'run.started',
  'run.done',
  'run.failed',
  'comment',
  'comment.resolved',
  'comment.reopened',
  'review.created',
  'review.revoked',
  'review.comment',
  'review.decision',
];

/** Edits by one person within this window are one entry (`count` grows). */
export const EDIT_COALESCE_MS = 10 * 60_000;
/** Newest activity entries a room keeps. */
export const ACTIVITY_KEEP = 2000;

export interface ActivityActor {
  kind: 'member' | 'reviewer' | 'agent' | 'system';
  id: string;
  name: string | null;
}

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  actor: ActivityActor;
  /** Kind-specific: `{ count }` for edits, `{ nodeId, title?, refunded? }` for runs, `{ threadId, excerpt }` for comments, `{ reviewId, decision?, title? }` for reviews. */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Filters of the activity feed. */
export const ACTIVITY_FILTERS = ['all', 'edits', 'runs', 'comments', 'reviews'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function activityMatches(kind: ActivityKind, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'edits':
      return kind === 'edit';
    case 'runs':
      return kind.startsWith('run.');
    case 'comments':
      return kind === 'comment' || kind.startsWith('comment.');
    case 'reviews':
      return kind.startsWith('review.');
  }
}
