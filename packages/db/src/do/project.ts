/**
 * ProjectRoom Durable Object SQLite schema (one instance per project).
 * Mirrors `db/do-project.sql`. Migrations are applied in the DO constructor.
 */
import { sql } from "drizzle-orm";
import { check, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { DoMigration } from "./migrate";

export const nodeKinds = ["text", "script", "image", "video", "audio", "asset", "render"] as const;

/** Keys: revision, timeline_revision, workspace_id, title. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const canvases = sqliteTable("canvases", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  viewport: text("viewport"),
});

export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id").notNull(),
    kind: text("kind", { enum: nodeKinds }).notNull(),
    title: text("title").notNull(),
    params: text("params").notNull().default("{}"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    groupId: text("group_id"),
    activeVersionId: text("active_version_id"),
    status: text("status").notNull().default("idle"),
    createdBy: text("created_by").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Bypassed: passes its input through when types match (DO migration 3). */
    bypass: integer("bypass", { mode: "boolean" }).notNull().default(false),
    /** Collapsed on the canvas (view only). */
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    check(
      "nodes_kind_check",
      sql`${t.kind} IN ('text','script','image','video','audio','asset','render')`,
    ),
  ],
);

export const edges = sqliteTable("edges", {
  id: text("id").primaryKey(),
  canvasId: text("canvas_id").notNull(),
  fromNode: text("from_node").notNull(),
  fromPort: text("from_port").notNull(),
  toNode: text("to_node").notNull(),
  toPort: text("to_port").notNull(),
  ord: integer("ord").notNull().default(0),
  pinnedVersionId: text("pinned_version_id"),
  /** JSON `[{x,y}, …]` reroute points (DO migration 4), or null. */
  reroutes: text("reroutes"),
});

export const nodeVersions = sqliteTable(
  "node_versions",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull(),
    n: integer("n").notNull(),
    assetId: text("asset_id"),
    output: text("output"),
    inputDigest: text("input_digest").notNull(),
    model: text("model"),
    jobId: text("job_id"),
    createdAt: integer("created_at").notNull(),
    /** D-005 content rating of the output (`safe | suggestive | explicit`) from the generation postCheck; null when unrated (DO migration 5). */
    rating: text("rating"),
  },
  (t) => [unique().on(t.nodeId, t.n)],
);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  canvasId: text("canvas_id").notNull(),
  title: text("title").notNull(),
  color: text("color"),
});

export const timelines = sqliteTable("timelines", {
  canvasId: text("canvas_id").primaryKey(),
  edl: text("edl").notNull(),
  revision: integer("revision").notNull(),
});

/**
 * Undo/redo and audit. `ops` are the normalized ops that were applied,
 * `inverse` the ops that revert them. `kind` is patch | undo | redo; `target`
 * is the revision an undo/redo row reverts; `undone` marks a patch/redo row
 * that was undone or an undo row that was redone.
 */
export const patchLog = sqliteTable("patch_log", {
  revision: integer("revision").primaryKey(),
  actor: text("actor").notNull(),
  ops: text("ops").notNull(),
  createdAt: integer("created_at").notNull(),
  kind: text("kind", { enum: ["patch", "undo", "redo"] }).notNull().default("patch"),
  inverse: text("inverse").notNull().default("[]"),
  target: integer("target"),
  undone: integer("undone", { mode: "boolean" }).notNull().default(false),
  /** DO migration 7 (D-021): `user` or `agent`, and the agent turn that made it (`agent:<threadId>:<turnId>`). */
  origin: text("origin", { enum: ["user", "agent"] }).notNull().default("user"),
  source: text("source"),
});

/** D-014: UserHub gateways (one per user id) subscribed to this project's events (DO migration 6). */
export const hubSubscribers = sqliteTable("hub_subscribers", {
  userId: text("user_id").primaryKey(),
  subscribedAt: integer("subscribed_at").notNull(),
});

/**
 * D-014: ring of recent replayable project events for catch-up on resubscribe
 * (`seq` is the event cursor; `revision` the graph revision when it was sent).
 * Pruned to the newest 500 (DO migration 6).
 */
export const eventRing = sqliteTable("event_ring", {
  seq: integer("seq").primaryKey(),
  revision: integer("revision").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Agent threads bound to this project, told about new revisions so pending proposals rebase eagerly (DO migration 6). */
export const agentThreads = sqliteTable("agent_threads", {
  threadId: text("thread_id").primaryKey(),
  /** JSON AgentCaller of the turn that left a pending proposal (used for `AgentSession.onRevision`). */
  caller: text("caller").notNull(),
  registeredAt: integer("registered_at").notNull(),
});

export const projectSchema = { meta, canvases, nodes, edges, nodeVersions, groups, timelines, patchLog, hubSubscribers, eventRing, agentThreads };

export const projectMigrations: readonly DoMigration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE canvases (id TEXT PRIMARY KEY, title TEXT NOT NULL, viewport TEXT);
CREATE TABLE nodes (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('text','script','image','video','audio','asset','render')), title TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', x REAL NOT NULL, y REAL NOT NULL, group_id TEXT, active_version_id TEXT, status TEXT NOT NULL DEFAULT 'idle', created_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE edges (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, from_node TEXT NOT NULL, from_port TEXT NOT NULL, to_node TEXT NOT NULL, to_port TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, pinned_version_id TEXT);
CREATE TABLE node_versions (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, n INTEGER NOT NULL, asset_id TEXT, output TEXT, input_digest TEXT NOT NULL, model TEXT, job_id TEXT, created_at INTEGER NOT NULL, UNIQUE (node_id, n));
CREATE TABLE groups (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, title TEXT NOT NULL, color TEXT);
CREATE TABLE timelines (canvas_id TEXT PRIMARY KEY, edl TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE patch_log (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, ops TEXT NOT NULL, created_at INTEGER NOT NULL);
`,
  },
  {
    version: 2,
    name: "undo_log",
    sql: `
ALTER TABLE patch_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'patch' CHECK (kind IN ('patch','undo','redo'));
ALTER TABLE patch_log ADD COLUMN inverse TEXT NOT NULL DEFAULT '[]';
ALTER TABLE patch_log ADD COLUMN target INTEGER;
ALTER TABLE patch_log ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;
CREATE INDEX patch_log_actor ON patch_log (actor, revision);
CREATE INDEX node_versions_node ON node_versions (node_id, n);
`,
  },
  {
    version: 3,
    name: "node_flags",
    sql: `
ALTER TABLE nodes ADD COLUMN bypass INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 4,
    name: "edge_reroutes",
    sql: `
ALTER TABLE edges ADD COLUMN reroutes TEXT;
`,
  },
  {
    version: 5,
    name: "version_rating",
    sql: `
ALTER TABLE node_versions ADD COLUMN rating TEXT;
UPDATE node_versions SET rating = json_extract(output, '$.rating') WHERE output IS NOT NULL AND json_valid(output) AND json_type(output, '$.rating') = 'text';
`,
  },
  {
    version: 6,
    name: "gateway_and_threads",
    sql: `
CREATE TABLE hub_subscribers (user_id TEXT PRIMARY KEY, subscribed_at INTEGER NOT NULL);
CREATE TABLE event_ring (seq INTEGER PRIMARY KEY, revision INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE agent_threads (thread_id TEXT PRIMARY KEY, caller TEXT NOT NULL, registered_at INTEGER NOT NULL);
`,
  },
  {
    version: 7,
    name: "patch_attribution",
    sql: `
ALTER TABLE patch_log ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
ALTER TABLE patch_log ADD COLUMN source TEXT;
`,
  },
];
