/**
 * ProjectRoom collaboration tables (D-031): comment threads, comments, read
 * markers and the project activity feed. Mirrors `db/do-project.sql`.
 *
 * Own migration chain (`_migrations_collab`, see `migrateDurableObject`'s
 * `chain`), applied in the ProjectRoom constructor after the main chain.
 * Presence is never stored: it lives in memory per connection.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DoMigration } from "./migrate";

export const COLLAB_MIGRATION_CHAIN = "collab";

export const commentThreads = sqliteTable(
  "comment_threads",
  {
    id: text("id").primaryKey(),
    anchorKind: text("anchor_kind", { enum: ["node", "version", "timeline", "canvas", "review"] }).notNull(),
    /** JSON CommentAnchor (`@rolling/core/collab`). */
    anchor: text("anchor").notNull(),
    /** The anchored node (node and version anchors), for node badges and node deletion. */
    nodeId: text("node_id"),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    /** The review link of a reviewer thread (D1 `review_links.id`), else null. */
    reviewId: text("review_id"),
    createdByKind: text("created_by_kind", { enum: ["member", "reviewer"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    check("comment_threads_anchor_check", sql`${t.anchorKind} IN ('node','version','timeline','canvas','review')`),
    check("comment_threads_status_check", sql`${t.status} IN ('open','resolved')`),
    index("comment_threads_updated").on(t.updatedAt),
    index("comment_threads_review").on(t.reviewId),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    authorKind: text("author_kind", { enum: ["member", "reviewer"] }).notNull(),
    /** User id (members) or reviewer id (reviewers). */
    authorId: text("author_id").notNull(),
    /** Display name when written (members are shown with their current name). */
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    /** JSON user ids mentioned (validated workspace members). */
    mentions: text("mentions").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [check("comments_author_check", sql`${t.authorKind} IN ('member','reviewer')`), index("comments_thread").on(t.threadId, t.createdAt)],
);

/** Per user and thread: when the user last read it (unread state). */
export const commentReads = sqliteTable(
  "comment_reads",
  {
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    readAt: integer("read_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.threadId] })],
);

/** Project activity feed (edits coalesced per person, runs, comments, reviews). */
export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    actorKind: text("actor_kind", { enum: ["member", "reviewer", "agent", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("activity_updated").on(t.updatedAt)],
);

export const projectCollabSchema = { commentThreads, comments, commentReads, activity };

export const projectCollabMigrations: readonly DoMigration[] = [
  {
    version: 1,
    name: "comments_activity",
    sql: `
CREATE TABLE comment_threads (id TEXT PRIMARY KEY, anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('node','version','timeline','canvas','review')), anchor TEXT NOT NULL, node_id TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), review_id TEXT, created_by_kind TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_by TEXT, resolved_at INTEGER);
CREATE INDEX comment_threads_updated ON comment_threads (updated_at);
CREATE INDEX comment_threads_review ON comment_threads (review_id);
CREATE TABLE comments (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author_kind TEXT NOT NULL CHECK (author_kind IN ('member','reviewer')), author_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER);
CREATE INDEX comments_thread ON comments (thread_id, created_at);
CREATE TABLE comment_reads (user_id TEXT NOT NULL, thread_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (user_id, thread_id));
CREATE TABLE activity (id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX activity_updated ON activity (updated_at);
`,
  },
];
