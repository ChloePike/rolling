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
    index("workspace_members_user").on(t.userId),
    check("workspace_members_role_check", sql`${t.role} IN ('owner','editor','viewer')`),
  ],
);

export const userPrefs = sqliteTable(
  "user_prefs",
  {
    userId: text("user_id").primaryKey(),
    language: text("language").notNull().default("en"),
    currency: text("currency").notNull().default("USD"),
    creationMode: text("creation_mode").notNull().default("simple"),
    defaultRatio: text("default_ratio").notNull().default("9:16"),
    defaultModel: text("default_model").notNull().default("auto"),
    /** D-006: default 300 credits (migration 0004). */
    confirmThreshold: integer("confirm_threshold").notNull().default(300),
    notifications: text("notifications")
      .notNull()
      .default('{"done":true,"low":true,"renewal":true,"product":false}'),
    handle: text("handle").unique(),
    bio: text("bio"),
    /** D-005: per-user 18+ opt-in. Off by default; only effective for workspaces with an active paid plan. */
    matureContent: integer("mature_content", { mode: "boolean" }).notNull().default(false),
    /** D-010: system (default), light or dark. */
    theme: text("theme", { enum: ["system", "light", "dark"] }).notNull().default("system"),
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (t) => [check("user_prefs_theme_check", sql`${t.theme} IN ('system','light','dark')`)],
);

/*
 * Better Auth tables (migration 0004). Better Auth reads and writes them through its
 * own D1 adapter; dates are ISO 8601 text here (not epoch ms like the rest of D1).
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: text("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: text("access_token_expires_at"),
    refreshTokenExpiresAt: text("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/** Email sign-in code resend cooldown (one row per address). */
export const authEmailSends = sqliteTable("auth_email_sends", {
  email: text("email").primaryKey(),
  lastSentAt: integer("last_sent_at").notNull(),
});

/** `test-inbox` email provider store (staging e2e only; 24 h TTL, refused in production). */
export const testInbox = sqliteTable(
  "test_inbox",
  {
    id: text("id").primaryKey(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    code: text("code"),
    template: text("template"),
    sentAt: integer("sent_at").notNull(),
  },
  (t) => [index("test_inbox_to").on(t.toEmail, sql`${t.sentAt} DESC`)],
);

/** Workspace invites; the emailed link carries the raw token, only its SHA-256 is stored. */
export const workspaceInvites = sqliteTable(
  "workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["editor", "viewer"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    acceptedBy: text("accepted_by"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    index("workspace_invites_ws").on(t.workspaceId, sql`${t.createdAt} DESC`),
    check("workspace_invites_role_check", sql`${t.role} IN ('editor','viewer')`),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    plan: text("plan", { enum: ["starter", "plus", "pro"] }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    status: text("status").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
    /** M2 (migration 0005). */
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: integer("current_period_start"),
  },
  (t) => [
    index("subscriptions_ws").on(t.workspaceId, sql`${t.currentPeriodEnd} DESC`),
    check("subscriptions_plan_check", sql`${t.plan} IN ('starter','plus','pro')`),
    check("subscriptions_interval_check", sql`${t.interval} IN ('month','year')`),
  ],
);

/** Checkout sessions created by `POST /api/billing/checkout` (migration 0005). */
export const checkoutSessions = sqliteTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["plan", "topUp"] }).notNull(),
    plan: text("plan", { enum: ["starter", "plus", "pro"] }),
    interval: text("interval", { enum: ["month", "year"] }),
    amountCents: integer("amount_cents"),
    credits: integer("credits"),
    resumeQuoteId: text("resume_quote_id"),
    status: text("status", { enum: ["open", "complete", "expired"] }).notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("checkout_sessions_ws").on(t.workspaceId, sql`${t.createdAt} DESC`),
    check("checkout_sessions_kind_check", sql`${t.kind} IN ('plan','topUp')`),
    check("checkout_sessions_status_check", sql`${t.status} IN ('open','complete','expired')`),
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
  /** 0007 (M4): who quoted, the scope, and when. */
  createdBy: text("created_by"),
  scope: text("scope"),
  createdAt: integer("created_at"),
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
    // 0007 (M4): Activity fields and totals.
    title: text("title"),
    source: text("source").notNull().default("canvas"),
    creditsQuoted: integer("credits_quoted").notNull().default(0),
    creditsSpent: integer("credits_spent").notNull().default(0),
    creditsRefunded: integer("credits_refunded").notNull().default(0),
    /** JSON run options (staging-only `forceFailure`). */
    options: text("options").notNull().default("{}"),
    updatedAt: integer("updated_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("runs_ws").on(t.workspaceId, sql`${t.createdAt} DESC`),
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
    // 0007 (M4).
    workspaceId: text("workspace_id"),
    itemRef: text("item_ref"),
    createdBy: text("created_by"),
    attempt: integer("attempt").notNull().default(1),
    assetId: text("asset_id"),
    errorMessage: text("error_message"),
    updatedAt: integer("updated_at"),
  },
  (t) => [
    index("jobs_activity").on(t.runId),
    index("jobs_ext").on(t.provider, t.externalId),
    index("jobs_ws").on(t.workspaceId, sql`${t.createdAt} DESC`),
    check(
      "jobs_status_check",
      sql`${t.status} IN ('queued','submitted','running','succeeded','failed','canceled','unknown')`,
    ),
  ],
);

export const runItemStatuses = ["pending", "running", "succeeded", "failed", "skipped", "canceled"] as const;

/** M4 (0007): one row per `run` item of a quote; held and started when its inputs land. */
export const runItems = sqliteTable(
  "run_items",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    ref: text("ref").notNull(),
    nodeId: text("node_id"),
    title: text("title"),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    /** Frozen GenSpec (JSON). */
    spec: text("spec").notNull(),
    priceRequest: text("price_request").notNull().default("{}"),
    paramsHash: text("params_hash"),
    dependsOn: text("depends_on").notNull().default("[]"),
    credits: integer("credits").notNull(),
    status: text("status", { enum: runItemStatuses }).notNull(),
    jobId: text("job_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    ord: integer("ord").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.ref] }), index("run_items_pending").on(t.status, t.runId)],
);

/** M4 (0007): provider webhook deliveries seen (dedupe on `webhook-id`). */
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  externalId: text("external_id"),
  receivedAt: integer("received_at").notNull(),
});

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
    /** Refund reason / note (migration 0005). */
    note: text("note"),
  },
  (t) => [index("ledger_ws").on(t.workspaceId, sql`${t.createdAt} DESC`)],
);

export const assetKinds = ["image", "video", "audio", "text"] as const;
export const assetSources = ["mine", "team", "builtin", "public", "generated"] as const;
export const assetStatuses = ["uploading", "processing", "ready", "failed"] as const;

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
    /** Upload lifecycle (migration 0006): uploading -> processing -> ready | failed. */
    status: text("status", { enum: assetStatuses }).notNull().default("ready"),
    /** D-005: mature outputs are only signed for allowed users and never shown publicly. */
    mature: integer("mature", { mode: "boolean" }).notNull().default(false),
    size: integer("size"),
    contentType: text("content_type"),
  },
  (t) => [
    index("assets_ws").on(t.workspaceId, t.kind, sql`${t.createdAt} DESC`),
    index("assets_source").on(t.source, t.kind, sql`${t.createdAt} DESC`),
    index("assets_project").on(t.projectId),
    check("assets_status_check", sql`${t.status} IN ('uploading','processing','ready','failed')`),
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

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    meta: text("meta"),
    coverAssetId: text("cover_asset_id"),
    versions: text("versions").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [index("characters_ws").on(t.workspaceId, sql`${t.createdAt} DESC`)],
);

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
  (t) => [index("voices_ws").on(t.workspaceId), check("voices_kind_check", sql`${t.kind} IN ('builtin','cloned')`)],
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
  workspaceId: text("workspace_id"),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(0),
}, (t) => [index("share_links_project").on(t.projectId)]);

export const agentThreads = sqliteTable("agent_threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  surface: text("surface").notNull(),
  skill: text("skill"),
  title: text("title"),
  updatedAt: integer("updated_at").notNull(),
});

/** D-002: model catalog synced from the gateway listing (migration 0002). */
export const modelKinds = ["image", "video", "chat"] as const;

export const models = sqliteTable(
  "models",
  {
    /** Gateway model id, e.g. `bytedance/seedance-2.5`. */
    id: text("id").primaryKey(),
    kind: text("kind", { enum: modelKinds }).notNull(),
    /** JSON: parsed listing model (technical fields, no price). */
    data: text("data").notNull(),
    /** JSON: price rules from the listing. */
    price: text("price").notNull(),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    mature: integer("mature", { mode: "boolean" }).notNull().default(false),
    /** Last sync that saw the model in the listing (epoch ms). */
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [
    index("models_kind").on(t.kind),
    index("models_synced").on(t.syncedAt),
    check("models_kind_check", sql`${t.kind} IN ('image','video','chat')`),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type UserPrefs = typeof userPrefs.$inferSelect;
export type User = typeof users.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type PublicItem = typeof publicItems.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;
