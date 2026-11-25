/**
 * CreditAccount Durable Object SQLite schema (one instance per workspace).
 * Source of truth for credits. Mirrors `db/do-credits.sql`.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DoMigration } from "./migrate";

export const ledgerKinds = ["grant", "purchase", "hold", "settle", "release", "refund", "expire", "adjust"] as const;
export const creditBuckets = ["plan", "purchased"] as const;

/** Single row (id = 1). */
export const balance = sqliteTable(
  "balance",
  {
    id: integer("id").primaryKey(),
    plan: integer("plan").notNull().default(0),
    purchased: integer("purchased").notNull().default(0),
    held: integer("held").notNull().default(0),
    planExpiresAt: integer("plan_expires_at"),
    autoTopup: text("auto_topup"),
    // v2 (M2)
    workspaceId: text("workspace_id"),
    planId: text("plan_id"),
    planInterval: text("plan_interval"),
    periodStart: integer("period_start"),
    periodEnd: integer("period_end"),
    autoTopupSeq: integer("auto_topup_seq").notNull().default(0),
  },
  (t) => [check("balance_singleton", sql`${t.id} = 1`)],
);

export const ledger = sqliteTable(
  "ledger",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ledgerKinds }).notNull(),
    bucket: text("bucket", { enum: creditBuckets }).notNull(),
    amount: integer("amount").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    jobId: text("job_id"),
    stripeRef: text("stripe_ref"),
    idemKey: text("idem_key").unique(),
    createdAt: integer("created_at").notNull(),
    // v2 (M2)
    note: text("note"),
    /** Set once the line was sent to the `ledger-mirror` queue (outbox). */
    mirroredAt: integer("mirrored_at"),
  },
  (t) => [
    index("ledger_unmirrored").on(t.createdAt).where(sql`${t.mirroredAt} IS NULL`),
    check(
      "ledger_kind_check",
      sql`${t.kind} IN ('grant','purchase','hold','settle','release','refund','expire','adjust')`,
    ),
    check("ledger_bucket_check", sql`${t.bucket} IN ('plan','purchased')`),
  ],
);

export const holdStatuses = ["held", "settled", "released"] as const;

/** One row per job; kept after settle/release so a job closes at most once. */
export const holds = sqliteTable(
  "holds",
  {
    jobId: text("job_id").primaryKey(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    fromPlan: integer("from_plan").notNull(),
    fromPurchased: integer("from_purchased").notNull(),
    createdAt: integer("created_at").notNull(),
    // v2 (M2)
    quoteId: text("quote_id").notNull().default(""),
    itemRef: text("item_ref").notNull().default(""),
    modelId: text("model_id").notNull().default(""),
    credits: integer("credits").notNull().default(0),
    planExpiresAt: integer("plan_expires_at"),
    status: text("status", { enum: holdStatuses }).notNull().default("held"),
    spent: integer("spent"),
    closedAt: integer("closed_at"),
  },
  (t) => [index("holds_status").on(t.status), index("holds_quote").on(t.quoteId)],
);

export const quotes = sqliteTable("quotes", {
  id: text("id").primaryKey(),
  items: text("items").notNull(),
  total: integer("total").notNull(),
  expiresAt: integer("expires_at").notNull(),
  // v2 (M2)
  createdAt: integer("created_at").notNull().default(0),
  runId: text("run_id"),
});

/** Results of idempotent operations, by key (v2). */
export const idempotency = sqliteTable("idempotency", {
  key: text("key").primaryKey(),
  op: text("op").notNull(),
  fingerprint: text("fingerprint").notNull(),
  result: text("result").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const memberUsage = sqliteTable(
  "member_usage",
  {
    userId: text("user_id").notNull(),
    month: text("month").notNull(),
    spent: integer("spent").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

export const agentHoldStatuses = ["held", "settled", "released", "expired"] as const;

/** Agent allowance holds, one row per turn (v3, D-012). Amounts in micro-USD. */
export const agentHolds = sqliteTable(
  "agent_holds",
  {
    turnId: text("turn_id").primaryKey(),
    userId: text("user_id").notNull(),
    llm: text("llm").notNull(),
    periodStart: integer("period_start").notNull(),
    estimateMicros: integer("estimate_micros").notNull(),
    actualMicros: integer("actual_micros"),
    overrunMicros: integer("overrun_micros").notNull().default(0),
    status: text("status", { enum: agentHoldStatuses }).notNull().default("held"),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [index("agent_holds_status").on(t.status), index("agent_holds_period").on(t.periodStart, t.status), index("agent_holds_llm").on(t.llm, t.status, t.closedAt)],
);

export const creditsSchema = { balance, ledger, holds, quotes, memberUsage, idempotency, agentHolds };

export const creditsMigrations: readonly DoMigration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE balance (id INTEGER PRIMARY KEY CHECK (id = 1), plan INTEGER NOT NULL DEFAULT 0, purchased INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, plan_expires_at INTEGER, auto_topup TEXT);
CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('grant','purchase','hold','settle','release','refund','expire','adjust')), bucket TEXT NOT NULL CHECK (bucket IN ('plan','purchased')), amount INTEGER NOT NULL, user_id TEXT, run_id TEXT, job_id TEXT, stripe_ref TEXT, idem_key TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE holds (job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, from_plan INTEGER NOT NULL, from_purchased INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE quotes (id TEXT PRIMARY KEY, items TEXT NOT NULL, total INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE member_usage (user_id TEXT NOT NULL, month TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, month));
INSERT INTO balance (id) VALUES (1);
`,
  },
  {
    version: 2,
    name: "ledger_m2",
    sql: `
ALTER TABLE balance ADD COLUMN workspace_id TEXT;
ALTER TABLE balance ADD COLUMN plan_id TEXT;
ALTER TABLE balance ADD COLUMN plan_interval TEXT;
ALTER TABLE balance ADD COLUMN period_start INTEGER;
ALTER TABLE balance ADD COLUMN period_end INTEGER;
ALTER TABLE balance ADD COLUMN auto_topup_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN note TEXT;
ALTER TABLE ledger ADD COLUMN mirrored_at INTEGER;
CREATE INDEX ledger_unmirrored ON ledger (created_at) WHERE mirrored_at IS NULL;
ALTER TABLE holds ADD COLUMN quote_id TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN item_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN model_id TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE holds ADD COLUMN plan_expires_at INTEGER;
ALTER TABLE holds ADD COLUMN status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released'));
ALTER TABLE holds ADD COLUMN spent INTEGER;
ALTER TABLE holds ADD COLUMN closed_at INTEGER;
CREATE INDEX holds_status ON holds (status);
CREATE INDEX holds_quote ON holds (quote_id);
ALTER TABLE quotes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN run_id TEXT;
CREATE TABLE idempotency (key TEXT PRIMARY KEY, op TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
`,
  },
  {
    version: 3,
    name: "agent_allowance",
    sql: `
CREATE TABLE agent_holds (turn_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, llm TEXT NOT NULL, period_start INTEGER NOT NULL, estimate_micros INTEGER NOT NULL, actual_micros INTEGER, overrun_micros INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released','expired')), created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE INDEX agent_holds_status ON agent_holds (status);
CREATE INDEX agent_holds_period ON agent_holds (period_start, status);
CREATE INDEX agent_holds_llm ON agent_holds (llm, status, closed_at);
`,
  },
];
