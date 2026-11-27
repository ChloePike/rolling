/**
 * AgentSession Durable Object SQLite schema (one instance per agent thread).
 * Mirrors `db/do-agent.sql`.
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DoMigration } from "./migrate";

export const proposalKinds = ["plan", "graphPatch", "timelinePatch", "fields"] as const;
export const proposalStatuses = ["proposed", "applied", "discarded", "stale"] as const;

/** Keys: thread_id, workspace_id, project_id, canvas_id, surface, skill, tool, summary, turn_count, llm, created_by. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  createdAt: integer("created_at").notNull(),
  /** v2: proposal created in this assistant message. */
  proposalId: text("proposal_id"),
  /** v2: turn id (user and assistant messages of one turn share it). */
  turnId: text("turn_id"),
});

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: proposalKinds }).notNull(),
    baseRevision: integer("base_revision"),
    body: text("body").notNull(),
    estimate: integer("estimate"),
    status: text("status", { enum: proposalStatuses }).notNull().default("proposed"),
    decidedAt: integer("decided_at"),
    /** v2: creation time (ms). */
    createdAt: integer("created_at"),
    /** v2: why the proposal became stale. */
    staleReason: text("stale_reason"),
  },
  (t) => [
    check("proposals_kind_check", sql`${t.kind} IN ('plan','graphPatch','timelinePatch','fields')`),
    check("proposals_status_check", sql`${t.status} IN ('proposed','applied','discarded','stale')`),
  ],
);

/**
 * v3 (D-021): changes Auto mode applied, one row each, undoable on their own.
 * `undo` holds what undo needs: nothing for graph changes (ProjectRoom reverts the
 * revision), the EDL before the change for timeline patches.
 */
export const autoChanges = sqliteTable("auto_changes", {
  id: text("id").primaryKey(),
  turnId: text("turn_id").notNull(),
  proposalId: text("proposal_id").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  projectId: text("project_id"),
  revision: integer("revision").notNull(),
  ops: integer("ops").notNull(),
  nodeIds: text("node_ids").notNull(),
  undo: text("undo"),
  status: text("status").notNull().default("applied"),
  createdAt: integer("created_at").notNull(),
});

/** v3 (D-021): `run.start` calls of Auto turns (started, needs_approval, refused) and the turn budget. */
export const autoRuns = sqliteTable("auto_runs", {
  id: text("id").primaryKey(),
  turnId: text("turn_id").notNull(),
  nodeIds: text("node_ids").notNull(),
  credits: integer("credits").notNull(),
  status: text("status").notNull(),
  runId: text("run_id"),
  code: text("code"),
  createdAt: integer("created_at").notNull(),
});

/** v3 (D-021): each Auto turn's budget and what it started. */
export const autoTurns = sqliteTable("auto_turns", {
  turnId: text("turn_id").primaryKey(),
  budget: integer("budget").notNull(),
  spent: integer("spent").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const agentSchema = { meta, messages, proposals, autoChanges, autoRuns, autoTurns };

export const agentMigrations: readonly DoMigration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('plan','graphPatch','timelinePatch','fields')), base_revision INTEGER, body TEXT NOT NULL, estimate INTEGER, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','discarded','stale')), decided_at INTEGER);
`,
  },
  {
    version: 2,
    name: "turns_and_proposal_times",
    sql: `
ALTER TABLE messages ADD COLUMN proposal_id TEXT;
ALTER TABLE messages ADD COLUMN turn_id TEXT;
ALTER TABLE proposals ADD COLUMN created_at INTEGER;
ALTER TABLE proposals ADD COLUMN stale_reason TEXT;
CREATE INDEX messages_created ON messages (created_at);
`,
  },
  {
    version: 3,
    name: "auto_mode",
    sql: `
CREATE TABLE auto_changes (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, proposal_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, project_id TEXT, revision INTEGER NOT NULL, ops INTEGER NOT NULL, node_ids TEXT NOT NULL, undo TEXT, status TEXT NOT NULL DEFAULT 'applied', created_at INTEGER NOT NULL);
CREATE INDEX auto_changes_turn ON auto_changes (turn_id);
CREATE TABLE auto_runs (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, node_ids TEXT NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL, run_id TEXT, code TEXT, created_at INTEGER NOT NULL);
CREATE INDEX auto_runs_turn ON auto_runs (turn_id);
CREATE TABLE auto_turns (turn_id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL, created_at INTEGER NOT NULL);
`,
  },
];
