import { z } from 'zod';

/**
 * Project comments (D-031). Threads are pinned to an anchor: a node, a node
 * version, a timeline time range, a point on the canvas, or (for client
 * reviewers) a time in one item of a review link. Stored in the project's
 * ProjectRoom SQLite; fanned out as project events.
 */

export const COMMENT_BODY_MAX = 4000;
export const COMMENT_MENTIONS_MAX = 20;

const NodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Seconds = z.number().finite().min(0).max(24 * 3600);

export const NodeAnchor = z.object({ kind: z.literal('node'), nodeId: NodeId });
export const VersionAnchor = z.object({ kind: z.literal('version'), nodeId: NodeId, versionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const TimelineAnchor = z
  .object({ kind: z.literal('timeline'), canvasId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), start: Seconds, end: Seconds })
  .refine((a) => a.end >= a.start, { message: 'end must not be before start', path: ['end'] });
export const CanvasAnchor = z.object({ kind: z.literal('canvas'), x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7) });
/** Reviewer comments: one item of a review link, optionally at a time (seconds) in a video. */
export const ReviewAnchor = z.object({
  kind: z.literal('review'),
  reviewId: z.string().min(1).max(64),
  itemId: z.string().min(1).max(64),
  at: Seconds.nullable(),
});

/** Anchors members can pin a thread to (review anchors come only from review links). */
export const MemberAnchor = z.union([NodeAnchor, VersionAnchor, TimelineAnchor, CanvasAnchor, ReviewAnchor]);
export type CommentAnchor = z.infer<typeof MemberAnchor>;
export type AnchorKind = CommentAnchor['kind'];
export const ANCHOR_KINDS: readonly AnchorKind[] = ['node', 'version', 'timeline', 'canvas', 'review'];

export const CommentBody = z.string().trim().min(1).max(COMMENT_BODY_MAX);
const Mentions = z.array(z.string().min(1).max(80)).max(COMMENT_MENTIONS_MAX).default([]);

/** `POST /api/projects/:id/comments`: a new thread with its first comment. */
export const CreateThreadInput = z.object({ anchor: MemberAnchor, body: CommentBody, mentions: Mentions }).strict();
export type CreateThreadInput = z.infer<typeof CreateThreadInput>;

/** `POST /api/projects/:id/comments/:threadId/replies`. */
export const ReplyInput = z.object({ body: CommentBody, mentions: Mentions }).strict();
export type ReplyInput = z.infer<typeof ReplyInput>;

/** `PATCH /api/projects/:id/comments/:threadId`: resolve or reopen (editors and owners). */
export const ThreadStatusInput = z.object({ status: z.enum(['open', 'resolved']) }).strict();

/** `PATCH /api/projects/:id/comments/:threadId/:commentId`: the author edits the text. */
export const EditCommentInput = z.object({ body: CommentBody, mentions: Mentions }).strict();

/** `POST /api/projects/:id/comments/read`: marks threads read for the caller. */
export const MarkReadInput = z.object({ threadIds: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict();

export type ThreadStatus = 'open' | 'resolved';

export interface CommentAuthor {
  kind: 'member' | 'reviewer';
  /** User id for members, reviewer id for reviewers. */
  id: string;
  name: string;
}

export interface CommentView {
  id: string;
  threadId: string;
  author: CommentAuthor;
  body: string;
  mentions: string[];
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
}

export interface ThreadView {
  id: string;
  anchor: CommentAnchor;
  status: ThreadStatus;
  createdBy: CommentAuthor;
  createdAt: number;
  updatedAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
  /** The review link a reviewer thread belongs to, else null. */
  reviewId: string | null;
  comments: CommentView[];
  /** For the caller: a comment by someone else arrived after they last read the thread. */
  unread: boolean;
  /** The caller is mentioned in this thread. */
  mentionsMe: boolean;
}

/** Permission rules (D-031): viewers comment; editors and owners resolve; authors edit; authors and owners delete. */
export type CollabRole = 'owner' | 'editor' | 'viewer';
export const canComment = (_role: CollabRole) => true;
export const canResolve = (role: CollabRole) => role === 'owner' || role === 'editor';
export const canEditComment = (authorId: string, userId: string) => authorId === userId;
export const canDeleteComment = (role: CollabRole, authorId: string, userId: string) => authorId === userId || role === 'owner';

/**
 * Mentions a comment really makes: ids the client listed that are members of
 * the workspace, de-duplicated, never the author.
 */
export function validMentions(listed: readonly string[], members: ReadonlySet<string>, author: string): string[] {
  const out: string[] = [];
  for (const id of listed) if (members.has(id) && id !== author && !out.includes(id)) out.push(id);
  return out;
}

/** A thread is unread for `userId` when someone else wrote after `readAt` (null: never read). */
export function isUnread(comments: ReadonlyArray<Pick<CommentView, 'author' | 'createdAt' | 'deleted'>>, userId: string, readAt: number | null): boolean {
  return comments.some((c) => !c.deleted && !(c.author.kind === 'member' && c.author.id === userId) && (readAt === null || c.createdAt > readAt));
}

/** Short excerpt for notifications and emails (one line, at most `max` characters). */
export function excerpt(body: string, max = 140): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Panel filters. */
export const COMMENT_FILTERS = ['open', 'resolved', 'mine', 'mentions', 'unread', 'reviews', 'all'] as const;
export type CommentFilter = (typeof COMMENT_FILTERS)[number];

export function matchesFilter(t: Pick<ThreadView, 'status' | 'createdBy' | 'comments' | 'unread' | 'mentionsMe' | 'reviewId'>, filter: CommentFilter, userId: string): boolean {
  switch (filter) {
    case 'open':
      return t.status === 'open';
    case 'resolved':
      return t.status === 'resolved';
    case 'mine':
      return t.comments.some((c) => c.author.kind === 'member' && c.author.id === userId);
    case 'mentions':
      return t.mentionsMe;
    case 'unread':
      return t.unread;
    case 'reviews':
      return t.reviewId !== null;
    case 'all':
      return true;
  }
}
