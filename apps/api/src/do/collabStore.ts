/**
 * ProjectRoom collaboration (D-031): comment threads, read markers and the
 * activity feed in the room's SQLite (`packages/db/src/do/projectCollab.ts`),
 * and presence in memory. ProjectRoom owns one `CollabStore` and one
 * `PresenceBoard` and exposes them as RPCs; nothing here talks to D1 or the
 * network.
 */
import {
  EDIT_COALESCE_MS,
  ACTIVITY_KEEP,
  isUnread,
  excerpt,
  PRESENCE_SERVER_MIN_INTERVAL_MS,
  PRESENCE_TTL_MS,
  type ActivityActor,
  type ActivityEntry,
  type ActivityKind,
  type CommentAnchor,
  type CommentAuthor,
  type CommentView,
  type PresenceCursor,
  type PresenceEntry,
  type ThreadStatus,
  type ThreadView,
} from "@rolling/core/collab";
import { newId } from "@rolling/core/ids";

type ThreadRow = {
  id: string;
  anchor_kind: string;
  anchor: string;
  node_id: string | null;
  status: ThreadStatus;
  review_id: string | null;
  created_by_kind: "member" | "reviewer";
  created_by: string;
  created_by_name: string;
  created_at: number;
  updated_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
};

type CommentRow = {
  id: string;
  thread_id: string;
  author_kind: "member" | "reviewer";
  author_id: string;
  author_name: string;
  body: string;
  mentions: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
};

type ActivityRow = {
  id: string;
  kind: string;
  actor_kind: ActivityActor["kind"];
  actor_id: string;
  actor_name: string | null;
  data: string;
  created_at: number;
  updated_at: number;
};

export type CollabError = { ok: false; code: "NOT_FOUND" | "FORBIDDEN"; message: string };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function commentView(r: CommentRow): CommentView {
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    threadId: r.thread_id,
    author: { kind: r.author_kind, id: r.author_id, name: r.author_name },
    body: deleted ? "" : r.body,
    mentions: deleted ? [] : parseJson<string[]>(r.mentions, []),
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deleted,
  };
}

function activityView(r: ActivityRow): ActivityEntry {
  return {
    id: r.id,
    kind: r.kind as ActivityKind,
    actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name },
    data: parseJson<Record<string, unknown>>(r.data, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class CollabStore {
  constructor(private readonly sql: SqlStorage) {}

  // ---------------------------------------------------------------- threads

  private threadRow(id: string): ThreadRow | null {
    return this.sql.exec<ThreadRow>("SELECT * FROM comment_threads WHERE id = ?", id).toArray()[0] ?? null;
  }

  private commentsOf(threadIds: string[]): Map<string, CommentRow[]> {
    const out = new Map<string, CommentRow[]>();
    for (let i = 0; i < threadIds.length; i += 50) {
      const chunk = threadIds.slice(i, i + 50);
      const rows = this.sql.exec<CommentRow>(`SELECT * FROM comments WHERE thread_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at, id`, ...chunk).toArray();
      for (const r of rows) out.set(r.thread_id, [...(out.get(r.thread_id) ?? []), r]);
    }
    return out;
  }

  private views(rows: ThreadRow[], userId: string | null): ThreadView[] {
    const comments = this.commentsOf(rows.map((r) => r.id));
    const reads = new Map<string, number>();
    if (userId) for (const r of this.sql.exec<{ thread_id: string; read_at: number }>("SELECT thread_id, read_at FROM comment_reads WHERE user_id = ?", userId).toArray()) reads.set(r.thread_id, Number(r.read_at));
    return rows.map((t) => {
      const list = (comments.get(t.id) ?? []).map(commentView);
      return {
        id: t.id,
        anchor: parseJson<CommentAnchor>(t.anchor, { kind: "canvas", x: 0, y: 0 }),
        status: t.status,
        createdBy: { kind: t.created_by_kind, id: t.created_by, name: t.created_by_name },
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        resolvedBy: t.resolved_by,
        resolvedAt: t.resolved_at,
        reviewId: t.review_id,
        comments: list,
        unread: userId ? isUnread(list, userId, reads.get(t.id) ?? null) : false,
        mentionsMe: userId ? list.some((c) => c.mentions.includes(userId)) : false,
      };
    });
  }

  thread(id: string, userId: string | null): ThreadView | null {
    const row = this.threadRow(id);
    return row ? this.views([row], userId)[0]! : null;
  }

  listThreads(userId: string | null, opts: { reviewId?: string } = {}): ThreadView[] {
    const rows = opts.reviewId
      ? this.sql.exec<ThreadRow>("SELECT * FROM comment_threads WHERE review_id = ? ORDER BY created_at", opts.reviewId).toArray()
      : this.sql.exec<ThreadRow>("SELECT * FROM comment_threads ORDER BY updated_at DESC").toArray();
    // Threads whose every comment was deleted are gone.
    return this.views(rows, userId).filter((t) => t.comments.some((c) => !c.deleted));
  }

  createThread(input: { anchor: CommentAnchor; author: CommentAuthor; body: string; mentions: string[]; reviewId?: string | null; now?: number }): { thread: ThreadView; commentId: string } {
    const now = input.now ?? Date.now();
    const id = newId("commentThread");
    const commentId = newId("comment");
    const nodeId = input.anchor.kind === "node" || input.anchor.kind === "version" ? input.anchor.nodeId : null;
    this.sql.exec(
      "INSERT INTO comment_threads (id, anchor_kind, anchor, node_id, status, review_id, created_by_kind, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)",
      id,
      input.anchor.kind,
      JSON.stringify(input.anchor),
      nodeId,
      input.reviewId ?? null,
      input.author.kind,
      input.author.id,
      input.author.name,
      now,
      now,
    );
    this.insertComment(commentId, id, input.author, input.body, input.mentions, now);
    if (input.author.kind === "member") this.markRead(input.author.id, [id], now);
    return { thread: this.thread(id, input.author.kind === "member" ? input.author.id : null)!, commentId };
  }

  reply(threadId: string, input: { author: CommentAuthor; body: string; mentions: string[]; now?: number }): { thread: ThreadView; commentId: string; participants: string[] } | CollabError {
    const t = this.threadRow(threadId);
    if (!t) return { ok: false, code: "NOT_FOUND", message: "Thread not found" };
    const now = input.now ?? Date.now();
    const participants = this.participants(threadId);
    const commentId = newId("comment");
    this.insertComment(commentId, threadId, input.author, input.body, input.mentions, now);
    // A reply to a resolved thread reopens it.
    this.sql.exec("UPDATE comment_threads SET updated_at = ?, status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?", now, threadId);
    if (input.author.kind === "member") this.markRead(input.author.id, [threadId], now);
    return { thread: this.thread(threadId, input.author.kind === "member" ? input.author.id : null)!, commentId, participants };
  }

  /** Member ids who wrote in a thread. */
  participants(threadId: string): string[] {
    return this.sql
      .exec<{ author_id: string }>("SELECT DISTINCT author_id FROM comments WHERE thread_id = ? AND author_kind = 'member' AND deleted_at IS NULL", threadId)
      .toArray()
      .map((r) => r.author_id);
  }

  private insertComment(id: string, threadId: string, author: CommentAuthor, body: string, mentions: string[], now: number): void {
    this.sql.exec(
      "INSERT INTO comments (id, thread_id, author_kind, author_id, author_name, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      threadId,
      author.kind,
      author.id,
      author.name,
      body,
      JSON.stringify(mentions),
      now,
    );
  }

  setStatus(threadId: string, status: ThreadStatus, userId: string, now = Date.now()): ThreadView | CollabError {
    const t = this.threadRow(threadId);
    if (!t) return { ok: false, code: "NOT_FOUND", message: "Thread not found" };
    if (status === "resolved") this.sql.exec("UPDATE comment_threads SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", userId, now, now, threadId);
    else this.sql.exec("UPDATE comment_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, threadId);
    return this.thread(threadId, userId)!;
  }

  comment(threadId: string, commentId: string): CommentRow | null {
    return this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ? AND thread_id = ?", commentId, threadId).toArray()[0] ?? null;
  }

  editComment(threadId: string, commentId: string, body: string, mentions: string[], userId: string, now = Date.now()): { thread: ThreadView; added: string[] } | CollabError {
    const c = this.comment(threadId, commentId);
    if (!c || c.deleted_at !== null) return { ok: false, code: "NOT_FOUND", message: "Comment not found" };
    if (c.author_kind !== "member" || c.author_id !== userId) return { ok: false, code: "FORBIDDEN", message: "Only the author can edit a comment" };
    const before = new Set(parseJson<string[]>(c.mentions, []));
    this.sql.exec("UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?", body, JSON.stringify(mentions), now, commentId);
    this.sql.exec("UPDATE comment_threads SET updated_at = ? WHERE id = ?", now, threadId);
    return { thread: this.thread(threadId, userId)!, added: mentions.filter((m) => !before.has(m)) };
  }

  /** Soft delete (the thread keeps its place; a thread with no comment left disappears). */
  deleteComment(threadId: string, commentId: string, userId: string, isOwner: boolean, now = Date.now()): { thread: ThreadView | null } | CollabError {
    const c = this.comment(threadId, commentId);
    if (!c || c.deleted_at !== null) return { ok: false, code: "NOT_FOUND", message: "Comment not found" };
    if (!isOwner && !(c.author_kind === "member" && c.author_id === userId)) return { ok: false, code: "FORBIDDEN", message: "Only the author or an owner can delete a comment" };
    this.sql.exec("UPDATE comments SET deleted_at = ?, body = '', mentions = '[]' WHERE id = ?", now, commentId);
    this.sql.exec("UPDATE comment_threads SET updated_at = ? WHERE id = ?", now, threadId);
    const t = this.thread(threadId, userId);
    return { thread: t && t.comments.some((x) => !x.deleted) ? t : null };
  }

  markRead(userId: string, threadIds: string[], now = Date.now()): void {
    for (const id of threadIds) {
      this.sql.exec("INSERT INTO comment_reads (user_id, thread_id, read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, thread_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)", userId, id, now);
    }
  }

  unreadCount(userId: string): number {
    return this.listThreads(userId).filter((t) => t.unread).length;
  }

  // ---------------------------------------------------------------- activity

  /**
   * Adds an entry, or for `edit` grows the same person's entry made within
   * EDIT_COALESCE_MS. Returns the entry as it should be broadcast.
   */
  record(kind: ActivityKind, actor: ActivityActor, data: Record<string, unknown>, now = Date.now()): ActivityEntry {
    if (kind === "edit") {
      const last = this.sql
        .exec<ActivityRow>("SELECT * FROM activity WHERE kind = 'edit' AND actor_kind = ? AND actor_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1", actor.kind, actor.id, now - EDIT_COALESCE_MS)
        .toArray()[0];
      const newest = this.sql.exec<{ id: string }>("SELECT id FROM activity ORDER BY updated_at DESC, id DESC LIMIT 1").toArray()[0];
      // Coalesce only while nothing else happened in between.
      if (last && newest?.id === last.id) {
        const prev = parseJson<Record<string, unknown>>(last.data, {});
        const merged = { ...prev, count: Number(prev.count ?? 1) + Number(data.count ?? 1) };
        this.sql.exec("UPDATE activity SET data = ?, updated_at = ? WHERE id = ?", JSON.stringify(merged), now, last.id);
        return activityView({ ...last, data: JSON.stringify(merged), updated_at: now });
      }
    }
    const id = newId("activity");
    this.sql.exec(
      "INSERT INTO activity (id, kind, actor_kind, actor_id, actor_name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      kind,
      actor.kind,
      actor.id,
      actor.name,
      JSON.stringify(data),
      now,
      now,
    );
    if (Math.random() < 0.02) {
      const cut = this.sql.exec<{ updated_at: number }>("SELECT updated_at FROM activity ORDER BY updated_at DESC LIMIT 1 OFFSET ?", ACTIVITY_KEEP).toArray()[0];
      if (cut) this.sql.exec("DELETE FROM activity WHERE updated_at <= ?", cut.updated_at);
    }
    return { id, kind, actor, data, createdAt: now, updatedAt: now };
  }

  /** Newest first; `before` is an `updatedAt` cursor. */
  listActivity(opts: { before?: number; limit: number }): ActivityEntry[] {
    const rows = opts.before
      ? this.sql.exec<ActivityRow>("SELECT * FROM activity WHERE updated_at < ? ORDER BY updated_at DESC, id DESC LIMIT ?", opts.before, opts.limit).toArray()
      : this.sql.exec<ActivityRow>("SELECT * FROM activity ORDER BY updated_at DESC, id DESC LIMIT ?", opts.limit).toArray();
    return rows.map(activityView);
  }

  hasRunStarted(jobId: string): boolean {
    return this.sql.exec("SELECT 1 FROM activity WHERE kind = 'run.started' AND json_extract(data, '$.jobId') = ? LIMIT 1", jobId).toArray().length > 0;
  }

  // ---------------------------------------------------------------- privacy

  /** Account deletion (D-018): the user's name and id leave comments, reads and activity. */
  pseudonymize(userId: string, tombstone: string): number {
    let changed = 0;
    changed += this.sql.exec("UPDATE comments SET author_id = ?, author_name = 'Deleted user' WHERE author_kind = 'member' AND author_id = ?", tombstone, userId).rowsWritten;
    changed += this.sql.exec("UPDATE comment_threads SET created_by = ?, created_by_name = 'Deleted user' WHERE created_by_kind = 'member' AND created_by = ?", tombstone, userId).rowsWritten;
    changed += this.sql.exec("UPDATE comment_threads SET resolved_by = ? WHERE resolved_by = ?", tombstone, userId).rowsWritten;
    changed += this.sql.exec("UPDATE comments SET mentions = REPLACE(mentions, ?, ?) WHERE mentions LIKE ?", userId, tombstone, `%${userId}%`).rowsWritten;
    changed += this.sql.exec("DELETE FROM comment_reads WHERE user_id = ?", userId).rowsWritten;
    changed += this.sql.exec("UPDATE activity SET actor_id = ?, actor_name = NULL WHERE actor_kind = 'member' AND actor_id = ?", tombstone, userId).rowsWritten;
    return changed;
  }
}

/** Activity text for a comment event. */
export function commentActivityData(thread: ThreadView, body: string): Record<string, unknown> {
  return { threadId: thread.id, anchor: thread.anchor.kind, excerpt: excerpt(body, 120), ...(thread.reviewId ? { reviewId: thread.reviewId } : {}) };
}

// ---------------------------------------------------------------- presence

interface PresenceSlot {
  entry: PresenceEntry;
  connId: string;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Presence of the people on a project, in memory only (D-031): one entry per
 * browser tab (`<connId>:<key>`). Updates faster than
 * PRESENCE_SERVER_MIN_INTERVAL_MS are coalesced (the latest one is sent when
 * the interval ends). Entries not refreshed within PRESENCE_TTL_MS are dropped.
 * If the room is evicted the board is empty; clients' heartbeats refill it.
 */
export class PresenceBoard {
  private slots = new Map<string, PresenceSlot>();

  constructor(
    private readonly send: (type: "presence.updated" | "presence.left", payload: unknown, exceptConn: { userId: string; connId: string } | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  list(): PresenceEntry[] {
    this.prune();
    return [...this.slots.values()].map((s) => s.entry);
  }

  update(input: { userId: string; connId: string; key: string; name: string; image: string | null; canEdit: boolean; cursor?: PresenceCursor | null; selection?: string[] }): PresenceEntry {
    this.prune();
    const id = `${input.connId}:${input.key}`;
    const now = this.now();
    const prev = this.slots.get(id);
    const entry: PresenceEntry = {
      id,
      userId: input.userId,
      name: input.name,
      image: input.image,
      canEdit: input.canEdit,
      cursor: input.cursor === undefined ? (prev?.entry.cursor ?? null) : input.cursor,
      selection: input.selection === undefined ? (prev?.entry.selection ?? []) : input.selection,
      at: now,
    };
    const slot: PresenceSlot = prev ? { ...prev, entry } : { entry, connId: input.connId, sentAt: 0, timer: null };
    this.slots.set(id, slot);
    const wait = slot.sentAt + PRESENCE_SERVER_MIN_INTERVAL_MS - now;
    if (wait <= 0 && !slot.timer) this.flush(id);
    else if (!slot.timer) {
      slot.timer = setTimeout(() => {
        const s = this.slots.get(id);
        if (s) s.timer = null;
        this.flush(id);
      }, Math.max(0, wait));
    }
    return entry;
  }

  private flush(id: string): void {
    const s = this.slots.get(id);
    if (!s) return;
    s.sentAt = this.now();
    this.send("presence.updated", { entry: s.entry }, { userId: s.entry.userId, connId: s.connId });
  }

  /** One tab (`key`), or every tab of a connection, left. */
  leave(connId: string, key?: string): number {
    let n = 0;
    for (const [id, s] of [...this.slots]) {
      if (s.connId !== connId || (key !== undefined && id !== `${connId}:${key}`)) continue;
      this.drop(id, s);
      n++;
    }
    return n;
  }

  /** Every connection of a user (hub unsubscribed, membership lost). */
  leaveUser(userId: string): number {
    let n = 0;
    for (const [id, s] of [...this.slots]) {
      if (s.entry.userId !== userId) continue;
      this.drop(id, s);
      n++;
    }
    return n;
  }

  private drop(id: string, s: PresenceSlot): void {
    if (s.timer) clearTimeout(s.timer);
    this.slots.delete(id);
    this.send("presence.left", { id, userId: s.entry.userId }, null);
  }

  prune(): void {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const [id, s] of [...this.slots]) if (s.entry.at < cutoff) this.drop(id, s);
  }

  clear(): void {
    for (const s of this.slots.values()) if (s.timer) clearTimeout(s.timer);
    this.slots.clear();
  }
}
