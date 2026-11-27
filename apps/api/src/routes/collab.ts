/**
 * Project collaboration routes (D-031), mounted under `/api/projects`:
 * comments (threads pinned to a node, version, timeline range or canvas
 * point), the project activity feed, and the owner side of client review
 * links. Thin handlers: storage is ProjectRoom (comments, activity) and D1
 * (review links, `../collab/reviews.ts`).
 *
 * Roles: every member (viewers too) reads, comments and replies; editors and
 * owners resolve and reopen; authors edit their comments; authors and owners
 * delete them; editors and owners create and manage review links.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CreateReviewInput,
  CreateThreadInput,
  EditCommentInput,
  excerpt,
  MarkReadInput,
  ReplyInput,
  ThreadStatusInput,
  UpdateReviewInput,
  validMentions,
  type ThreadView,
} from "@rolling/core/collab";
import type { AppEnv } from "../env";
import { projectAccess, projectRoom, requireAuth, roomCaller, type AuthContext, type ProjectAccess } from "../lib/access";
import { limitOrThrow } from "../auth/rateLimit";
import { unwrap } from "../lib/room";
import { validate } from "../lib/validate";
import type { CollabCaller } from "../do/ProjectRoom";
import { appUrl, emailUsers, notifyInApp } from "../collab/notify";
import { createReview, listReviews, reviewDetail, updateReview } from "../collab/reviews";

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const IdParam = z.object({ id: Id });
const ThreadParam = z.object({ id: Id, threadId: Id });
const CommentParam = z.object({ id: Id, threadId: Id, commentId: Id });
const ReviewParam = z.object({ id: Id, reviewId: Id });
const ActivityQuery = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });

export interface MemberInfo {
  userId: string;
  name: string;
  image: string | null;
  role: string;
}

/** Members of the project's workspace (mention picker, names on activity). */
export async function workspaceMembers(env: Env, workspaceId: string): Promise<MemberInfo[]> {
  const rows = await env.DB.prepare(
    `SELECT m.user_id, m.role, u.name, u.email, u.image FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
  )
    .bind(workspaceId)
    .all<{ user_id: string; role: string; name: string | null; email: string | null; image: string | null }>();
  return rows.results.map((r) => ({ userId: r.user_id, role: r.role, name: displayName(r.name, r.email, r.user_id), image: r.image }));
}

export function displayName(name: string | null | undefined, email: string | null | undefined, fallback: string): string {
  return name?.trim() || email?.split("@")[0] || fallback;
}

function callerName(auth: AuthContext): string {
  return displayName(auth.user?.name, auth.user?.email, auth.userId);
}

async function ctx(c: Context<AppEnv>, id: string, min: "viewer" | "editor" = "viewer"): Promise<{ auth: AuthContext; acc: ProjectAccess; caller: CollabCaller }> {
  const auth = await requireAuth(c);
  const acc = await projectAccess(c, auth, id, min);
  let name = callerName(auth);
  if (!auth.user) {
    // Dev identities carry no profile; a users row (tests, seeded accounts) still names them.
    const row = await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?1").bind(auth.userId).first<{ name: string | null; email: string | null }>();
    if (row) name = displayName(row.name, row.email, auth.userId);
  }
  return { auth, acc, caller: { ...roomCaller(auth, acc), role: acc.role, name } };
}

function waiter(c: Context<AppEnv>): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * After a new comment: mentions get a mention notification (in-app + email);
 * thread participants and the project's creator get a comment notification
 * (in-app). Never the author; a mentioned person gets only the mention.
 */
async function notifyComment(
  c: Context<AppEnv>,
  input: { acc: ProjectAccess; authorId: string; authorName: string; thread: ThreadView; body: string; mentions: string[]; participants: string[] },
): Promise<void> {
  const { acc, thread } = input;
  const projectId = acc.project.id;
  const href = `/p/${projectId}?thread=${thread.id}`;
  const text = excerpt(input.body);
  const wait = waiter(c);
  const mentioned = input.mentions.filter((m) => m !== input.authorId);
  if (mentioned.length) {
    await notifyInApp(c.env, mentioned, "mentions", { kind: "mention", projectId, threadId: thread.id, title: `${input.authorName} mentioned you in ${acc.project.title}`, message: text, href }, wait);
    await emailUsers(c.env, mentioned, "mentions", "comment-mention", { authorName: input.authorName, projectTitle: acc.project.title || "Untitled", excerpt: text, url: appUrl(c.env, href) }, wait);
  }
  const others = [...input.participants, acc.project.created_by].filter((u) => u !== input.authorId && !mentioned.includes(u));
  if (others.length) {
    await notifyInApp(c.env, others, "comments", { kind: "comment", projectId, threadId: thread.id, title: `${input.authorName} commented on ${acc.project.title}`, message: text, href }, wait);
  }
}

export const collab = new Hono<AppEnv>()
  // ------------------------------------------------------------ comments
  /** `{ threads, members, unread }`: every thread of the project, newest activity first. */
  .get("/:id/comments", validate("param", IdParam), async (c) => {
    const { acc, caller } = await ctx(c, c.req.valid("param").id);
    const [res, members] = await Promise.all([projectRoom(c.env, acc.project.id).listThreads(caller), workspaceMembers(c.env, acc.project.workspace_id)]);
    const { threads } = unwrap(res);
    return c.json({ threads, members, unread: threads.filter((t) => t.unread).length, canResolve: caller.role !== "viewer" });
  })
  .post("/:id/comments", validate("param", IdParam), validate("json", CreateThreadInput), async (c) => {
    const { auth, acc, caller } = await ctx(c, c.req.valid("param").id);
    await limitOrThrow(c.env.RATE_LIMIT, `comment:${auth.userId}`);
    const input = c.req.valid("json");
    const members = await workspaceMembers(c.env, acc.project.workspace_id);
    const mentions = validMentions(input.mentions, new Set(members.map((m) => m.userId)), auth.userId);
    const res = unwrap(await projectRoom(c.env, acc.project.id).createThread(caller, { anchor: input.anchor, body: input.body, mentions }));
    await notifyComment(c, { acc, authorId: auth.userId, authorName: caller.name, thread: res.thread, body: input.body, mentions, participants: [] });
    return c.json({ thread: res.thread }, 201);
  })
  .post("/:id/comments/read", validate("param", IdParam), validate("json", MarkReadInput), async (c) => {
    const { acc, caller } = await ctx(c, c.req.valid("param").id);
    const res = unwrap(await projectRoom(c.env, acc.project.id).markThreadsRead(caller, c.req.valid("json").threadIds));
    return c.json({ unread: res.unread });
  })
  .post("/:id/comments/:threadId/replies", validate("param", ThreadParam), validate("json", ReplyInput), async (c) => {
    const { id, threadId } = c.req.valid("param");
    const { auth, acc, caller } = await ctx(c, id);
    await limitOrThrow(c.env.RATE_LIMIT, `comment:${auth.userId}`);
    const input = c.req.valid("json");
    const members = await workspaceMembers(c.env, acc.project.workspace_id);
    const mentions = validMentions(input.mentions, new Set(members.map((m) => m.userId)), auth.userId);
    const res = unwrap(await projectRoom(c.env, id).replyThread(caller, threadId, { body: input.body, mentions }));
    await notifyComment(c, { acc, authorId: auth.userId, authorName: caller.name, thread: res.thread, body: input.body, mentions, participants: res.participants });
    return c.json({ thread: res.thread, commentId: res.commentId }, 201);
  })
  /** Resolve / reopen (editors and owners; viewers get 403). */
  .patch("/:id/comments/:threadId", validate("param", ThreadParam), validate("json", ThreadStatusInput), async (c) => {
    const { id, threadId } = c.req.valid("param");
    const { caller } = await ctx(c, id);
    const res = unwrap(await projectRoom(c.env, id).setThreadStatus(caller, threadId, c.req.valid("json").status));
    return c.json({ thread: res.thread });
  })
  .patch("/:id/comments/:threadId/:commentId", validate("param", CommentParam), validate("json", EditCommentInput), async (c) => {
    const { id, threadId, commentId } = c.req.valid("param");
    const { auth, acc, caller } = await ctx(c, id);
    const input = c.req.valid("json");
    const members = await workspaceMembers(c.env, acc.project.workspace_id);
    const mentions = validMentions(input.mentions, new Set(members.map((m) => m.userId)), auth.userId);
    const res = unwrap(await projectRoom(c.env, id).editComment(caller, threadId, commentId, { body: input.body, mentions }));
    // Only people newly mentioned by the edit are told.
    if (res.added.length) await notifyComment(c, { acc, authorId: auth.userId, authorName: caller.name, thread: res.thread, body: input.body, mentions: res.added, participants: [] });
    return c.json({ thread: res.thread });
  })
  .delete("/:id/comments/:threadId/:commentId", validate("param", CommentParam), async (c) => {
    const { id, threadId, commentId } = c.req.valid("param");
    const { caller } = await ctx(c, id);
    const res = unwrap(await projectRoom(c.env, id).deleteComment(caller, threadId, commentId));
    return c.json({ thread: res.thread });
  })

  // ------------------------------------------------------------ activity
  /** `{ entries, members, next }`: newest first; `next` is the `before` cursor of the following page. */
  .get("/:id/activity", validate("param", IdParam), validate("query", ActivityQuery), async (c) => {
    const { acc, caller } = await ctx(c, c.req.valid("param").id);
    const q = c.req.valid("query");
    const limit = q.limit ?? 50;
    const [res, members] = await Promise.all([projectRoom(c.env, acc.project.id).listActivity(caller, { before: q.before, limit }), workspaceMembers(c.env, acc.project.workspace_id)]);
    const { entries } = unwrap(res);
    const names = new Map(members.map((m) => [m.userId, m.name]));
    return c.json({
      entries: entries.map((e) => ((e.actor.kind === "member" || e.actor.kind === "agent") && !e.actor.name ? { ...e, actor: { ...e.actor, name: names.get(e.actor.id) ?? null } } : e)),
      next: entries.length === limit ? entries[entries.length - 1]!.updatedAt : null,
    });
  })

  // ------------------------------------------------------------ review links (owner side)
  .get("/:id/reviews", validate("param", IdParam), async (c) => {
    const { acc } = await ctx(c, c.req.valid("param").id);
    return c.json({ reviews: await listReviews(c.env, acc.project.id) });
  })
  /** Editors and owners. Mature items need `confirmMature` from an owner who may view mature content (409 `MATURE_CONFIRM_REQUIRED`, 403 when not allowed). */
  .post("/:id/reviews", validate("param", IdParam), validate("json", CreateReviewInput), async (c) => {
    const { auth, acc, caller } = await ctx(c, c.req.valid("param").id, "editor");
    await limitOrThrow(c.env.RATE_LIMIT, `review-create:${auth.userId}`);
    const review = await createReview(c.env, { auth, acc, caller, input: c.req.valid("json") });
    return c.json({ review }, 201);
  })
  .get("/:id/reviews/:reviewId", validate("param", ReviewParam), async (c) => {
    const { id, reviewId } = c.req.valid("param");
    const { acc } = await ctx(c, id);
    return c.json(await reviewDetail(c.env, acc.project.id, reviewId));
  })
  .patch("/:id/reviews/:reviewId", validate("param", ReviewParam), validate("json", UpdateReviewInput), async (c) => {
    const { id, reviewId } = c.req.valid("param");
    const { acc, caller } = await ctx(c, id, "editor");
    return c.json({ review: await updateReview(c.env, { projectId: acc.project.id, reviewId, caller, patch: c.req.valid("json") }) });
  })
  .delete("/:id/reviews/:reviewId", validate("param", ReviewParam), async (c) => {
    const { id, reviewId } = c.req.valid("param");
    const { acc, caller } = await ctx(c, id, "editor");
    return c.json({ review: await updateReview(c.env, { projectId: acc.project.id, reviewId, caller, patch: { revoke: true } }) });
  });
