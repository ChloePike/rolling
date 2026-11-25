/**
 * CreditAccount Durable Object SQLite schema (one instance per workspace).
 * Source of truth for credits. Mirrors `db/do-credits.sql`.
 */
import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  },
  (t) => [
    check(
      "ledger_kind_check",
      sql`${t.kind} IN ('grant','purchase','hold','settle','release','refund','expire','adjust')`,
    ),
    check("ledger_bucket_check", sql`${t.bucket} IN ('plan','purchased')`),
  ],
);

export const holds = sqliteTable("holds", {
  jobId: text("job_id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  fromPlan: integer("from_plan").notNull(),
  fromPurchased: integer("from_purchased").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const quotes = sqliteTable("quotes", {
  id: text("id").primaryKey(),
  items: text("items").notNull(),
  total: integer("total").notNull(),
  expiresAt: integer("expires_at").notNull(),
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

export const creditsSchema = { balance, ledger, holds, quotes, memberUsage };

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
];
