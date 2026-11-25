/**
 * Drizzle schema for the global D1 database. Mirrors `db/d1.sql` plus the
 * D-005 columns (`user_prefs.mature_content`, `workspaces.mature_allowed`).
 *
 * Times are integer epoch ms. JSON columns are TEXT holding JSON.
 * Better Auth owns its own tables (user, session, account, verification).
 *
 * The FTS5 table `asset_search` cannot be expressed in Drizzle; it is created
 * by the hand-written migration and queried with raw SQL (see `assetSearchSql`).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["personal", "team"] }).notNull(),
    stripeCustomerId: text("stripe_customer_id").unique(),
    /** D-005: workspace admins can disable 18+ content for all members. */
    matureAllowed: integer("mature_allowed", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [check("workspaces_kind_check", sql`${t.kind} IN ('personal','team')`)],
);

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    monthlyCreditLimit: integer("monthly_credit_limit"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check("workspace_members_role_check", sql`${t.role} IN ('owner','editor','viewer')`),
  ],
);

export const userPrefs = sqliteTable("user_prefs", {
  userId: text("user_id").primaryKey(),
  language: text("language").notNull().default("en"),
  currency: text("currency").notNull().default("USD"),
  creationMode: text("creation_mode").notNull().default("simple"),
  defaultRatio: text("default_ratio").notNull().default("9:16"),
  defaultModel: text("default_model").notNull().default("auto"),
  confirmThreshold: integer("confirm_threshold").notNull().default(20),
  notifications: text("notifications")
    .notNull()
    .default('{"done":true,"low":true,"renewal":true,"product":false}'),
  handle: text("handle").unique(),
  bio: text("bio"),
  /** D-005: per-user 18+ opt-in. Off by default; only effective for workspaces with an active paid plan. */
  matureContent: integer("mature_content", { mode: "boolean" }).notNull().default(false),
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    plan: text("plan", { enum: ["starter", "pro", "studio"] }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    status: text("status").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("subscriptions_plan_check", sql`${t.plan} IN ('starter','pro','studio')`),
    check("subscriptions_interval_check", sql`${t.interval} IN ('month','year')`),
  ],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at").notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("canvas"),
    thumbKey: text("thumb_key"),
    nodeCount: integer("node_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("projects_ws").on(t.workspaceId, sql`${t.updatedAt} DESC`)],
);

export const quotes = sqliteTable("quotes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  items: text("items").notNull(),
  total: integer("total").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const runStatuses = ["queued", "running", "succeeded", "partial", "failed", "canceled"] as const;

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    quoteId: text("quote_id").notNull(),
    scope: text("scope").notNull(),
    status: text("status", { enum: runStatuses }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "runs_status_check",
      sql`${t.status} IN ('queued','running','succeeded','partial','failed','canceled')`,
    ),
  ],
);

export const jobStatuses = [
  "queued",
  "submitted",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const;

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    projectId: text("project_id"),
    nodeId: text("node_id"),
    title: text("title"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    paramsSummary: text("params_summary"),
    externalId: text("external_id"),
    workflowId: text("workflow_id"),
    status: text("status", { enum: jobStatuses }).notNull(),
    progress: real("progress"),
    costQuote: integer("cost_quote").notNull(),
    costActual: integer("cost_actual"),
    refunded: integer("refunded", { mode: "boolean" }).notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_activity").on(t.runId),
    index("jobs_ext").on(t.provider, t.externalId),
    check(
      "jobs_status_check",
      sql`${t.status} IN ('queued','submitted','running','succeeded','failed','canceled','unknown')`,
    ),
  ],
);

/** Mirror of the CreditAccount ledger (written by the `ledger-mirror` queue). */
export const ledgerLines = sqliteTable(
  "ledger_lines",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id"),
    kind: text("kind").notNull(),
    bucket: text("bucket").notNull(),
    amount: integer("amount").notNull(),
    runId: text("run_id"),
    jobId: text("job_id"),
    stripeRef: text("stripe_ref"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ledger_ws").on(t.workspaceId, sql`${t.createdAt} DESC`)],
);

export const assetKinds = ["image", "video", "audio", "text"] as const;
export const assetSources = ["mine", "team", "builtin", "public", "generated"] as const;

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    kind: text("kind", { enum: assetKinds }).notNull(),
    source: text("source", { enum: assetSources }).notNull(),
    name: text("name").notNull(),
    r2Key: text("r2_key").notNull(),
    meta: text("meta").notNull().default("{}"),
    license: text("license"),
    projectId: text("project_id"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("assets_ws").on(t.workspaceId, t.kind, sql`${t.createdAt} DESC`),
    check("assets_kind_check", sql`${t.kind} IN ('image','video','audio','text')`),
    check(
      "assets_source_check",
      sql`${t.source} IN ('mine','team','builtin','public','generated')`,
    ),
  ],
);

/** D-004: PoseWear items are first-party content. */
export const publicLicenses = ["first-party", "cc0", "mit"] as const;

export const publicItems = sqliteTable(
  "public_items",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    sub: text("sub"),
    title: text("title").notNull(),
    promptEn: text("prompt_en"),
    promptZh: text("prompt_zh"),
    /** JSON array of tag strings. */
    tags: text("tags").notNull().default("[]"),
    /** JSON array of `{ name, r2Key }`. */
    angles: text("angles"),
    depthKey: text("depth_key"),
    assetId: text("asset_id").notNull(),
    license: text("license", { enum: publicLicenses }).notNull(),
    source: text("source").notNull(),
    /** Mature items never appear on public surfaces (D-005). */
    mature: integer("mature", { mode: "boolean" }).notNull().default(false),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [
    index("public_items_cat").on(t.category, t.sub, t.sort),
    check("public_items_license_check", sql`${t.license} IN ('first-party','cc0','mit')`),
  ],
);

/**
 * `asset_search` is an FTS5 virtual table: `(id UNINDEXED, name, tags)`.
 * Drizzle cannot model it; use this raw SQL helper with `db.all()`.
 */
export const assetSearchSql = (query: string, limit = 50) =>
  sql`SELECT id FROM asset_search WHERE asset_search MATCH ${query} ORDER BY rank LIMIT ${limit}`;

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  meta: text("meta"),
  coverAssetId: text("cover_asset_id"),
  versions: text("versions").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
});

export const voices = sqliteTable(
  "voices",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    name: text("name").notNull(),
    language: text("language"),
    kind: text("kind", { enum: ["builtin", "cloned"] }).notNull(),
    status: text("status").notNull(),
    providerRef: text("provider_ref"),
    sampleAssetId: text("sample_asset_id"),
  },
  (t) => [check("voices_kind_check", sql`${t.kind} IN ('builtin','cloned')`)],
);

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  title: text("title").notNull(),
  category: text("category"),
  graph: text("graph").notNull(),
  slots: text("slots").notNull(),
  previewAssetId: text("preview_asset_id"),
  uses: integer("uses").notNull().default(0),
});

export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  snapshotKey: text("snapshot_key").notNull(),
  allowDownload: integer("allow_download", { mode: "boolean" }).notNull().default(false),
  revokedAt: integer("revoked_at"),
});

export const agentThreads = sqliteTable("agent_threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  surface: text("surface").notNull(),
  skill: text("skill"),
  title: text("title"),
  updatedAt: integer("updated_at").notNull(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type UserPrefs = typeof userPrefs.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type PublicItem = typeof publicItems.$inferSelect;
