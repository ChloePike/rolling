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
  uniqueIndex,
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
    /** D-005 review flag (migration 0009): set after repeated hard-limit blocks; mature runs are refused until cleared. */
    safetyFlag: integer("safety_flag", { mode: "boolean" }).notNull().default(false),
    safetyFlaggedAt: integer("safety_flagged_at"),
    /** Migration 0013: set when the owner deleted their account; members are removed, the row stays for Stripe and ledger history. */
    deletedAt: integer("deleted_at"),
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
    /** Migration 0013: R2 key of the derived, safe-rated avatar (served by `/api/media/avatar/:userId`). */
    avatarKey: text("avatar_key"),
    avatarAssetId: text("avatar_asset_id"),
    /** Migration 0024 (D-020): "Enhance prompt" default for Home, tools and Quick Create. */
    enhancePrompt: integer("enhance_prompt", { mode: "boolean" }).notNull().default(true),
    /** Migration 0032 (D-024): "Review results" (a vision model reviews each output). */
    reviewResults: integer("review_results", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    check("user_prefs_theme_check", sql`${t.theme} IN ('system','light','dark')`),
    // Migration 0013: handles are unique case-insensitively.
    uniqueIndex("user_prefs_handle_ci").on(sql`lower(${t.handle})`),
  ],
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
    /** Migration 0013: monthly credit limit applied to the member on accept (null = no limit). */
    monthlyCreditLimit: integer("monthly_credit_limit"),
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
    plan: text("plan", { enum: ["starter", "plus", "pro", "team"] }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    status: text("status").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
    /** M2 (migration 0005). */
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: integer("current_period_start"),
    /** D-013 (migration 0012): members including the owner (Team seat quantity + 1); 1 for personal plans. */
    seats: integer("seats").notNull().default(1),
  },
  (t) => [
    index("subscriptions_ws").on(t.workspaceId, sql`${t.currentPeriodEnd} DESC`),
    check("subscriptions_plan_check", sql`${t.plan} IN ('starter','plus','pro','team')`),
    check("subscriptions_seats_check", sql`${t.seats} >= 1`),
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
    plan: text("plan", { enum: ["starter", "plus", "pro", "team"] }),
    interval: text("interval", { enum: ["month", "year"] }),
    amountCents: integer("amount_cents"),
    credits: integer("credits"),
    resumeQuoteId: text("resume_quote_id"),
    status: text("status", { enum: ["open", "complete", "expired"] }).notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
    /** D-013 (migration 0012): Team seats bought in this checkout. */
    seats: integer("seats"),
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
  /** 0015: the normalized request (`{ promptSpec, onlyRefs?, priorAssets?, retryOf? }` or `{ scope, nodeIds?, retryOf? }`). */
  request: text("request"),
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
    // 0015: the request it was quoted from, retries, tool and saved Character.
    request: text("request"),
    retryOf: text("retry_of"),
    tool: text("tool"),
    characterId: text("character_id"),
    // 0025: where the run was started (home, quick, remix, avatar, character, canvas, agent).
    surface: text("surface"),
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
    /** Migration 0024 (D-020): the prompt that rendered when the gateway expanded it. */
    expandedPrompt: text("expanded_prompt"),
    /** Migration 0032 (D-024): the result review (JSON) and its gateway cost, covered from the margin. */
    review: text("review"),
    reviewCostUsd: real("review_cost_usd"),
    /** Migration 0027: the gateway's `usage.cost` in USD (margin dashboard). */
    gatewayCostUsd: real("gateway_cost_usd"),
  },
  (t) => [
    index("jobs_activity").on(t.runId),
    index("jobs_ext").on(t.provider, t.externalId),
    index("jobs_ws").on(t.workspaceId, sql`${t.createdAt} DESC`),
    index("jobs_time").on(t.createdAt),
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
  (t) => [index("ledger_ws").on(t.workspaceId, sql`${t.createdAt} DESC`), index("ledger_lines_user").on(t.userId)],
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
    /** D-005 content rating (migration 0009) from core/safety: safe | suggestive | explicit; null = not rated yet. */
    rating: text("rating", { enum: ["safe", "suggestive", "explicit"] }),
    ratingConfidence: real("rating_confidence"),
    ratingModel: text("rating_model"),
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

/** D-011 (migration 0010): resumable multipart uploads and the parts received so far. */
export const uploadStatuses = ["uploading", "complete", "aborted", "expired"] as const;

export const uploads = sqliteTable(
  "uploads",
  {
    assetId: text("asset_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    /** Client hash of name + size + lastModified + first/last 1 MB; resumes an unexpired upload. */
    fingerprint: text("fingerprint"),
    uploadId: text("upload_id").notNull(),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),
    contentType: text("content_type").notNull(),
    status: text("status", { enum: uploadStatuses }).notNull().default("uploading"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("uploads_fingerprint").on(t.workspaceId, t.userId, t.fingerprint, t.status),
    index("uploads_expiry").on(t.status, t.expiresAt),
    check("uploads_status_check", sql`${t.status} IN ('uploading','complete','aborted','expired')`),
  ],
);

export const uploadParts = sqliteTable(
  "upload_parts",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => uploads.assetId, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    size: integer("size").notNull(),
    etag: text("etag").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.n] })],
);

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
    /** Migration 0029 (D-032): consistent characters. */
    kind: text("kind").notNull().default("person"),
    descriptor: text("descriptor"),
    descriptorVersion: integer("descriptor_version").notNull().default(1),
    sheet: text("sheet"),
    outfits: text("outfits").notNull().default("[]"),
    realFace: integer("real_face", { mode: "boolean" }).notNull().default(false),
    refFaceKey: text("ref_face_key"),
    updatedAt: integer("updated_at"),
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
  /** Null for built-in templates; a workspace id for "save selection as template" (workspace-private). */
  workspaceId: text("workspace_id"),
  title: text("title").notNull(),
  category: text("category"),
  graph: text("graph").notNull(),
  slots: text("slots").notNull(),
  previewAssetId: text("preview_asset_id"),
  uses: integer("uses").notNull().default(0),
  /** Migration 0013: author (public profile lists global templates they authored). */
  createdBy: text("created_by"),
  /** 0015: listing fields (`meta`: durationSec, ratio, roles, hasLines, tags, featured, nodeCount). */
  description: text("description"),
  meta: text("meta").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
}, (t) => [index("templates_ws").on(t.workspaceId, t.category, sql`${t.uses} DESC`)]);

export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  snapshotKey: text("snapshot_key").notNull(),
  allowDownload: integer("allow_download", { mode: "boolean" }).notNull().default(false),
  revokedAt: integer("revoked_at"),
  workspaceId: text("workspace_id"),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(0),
  /** Migration 0013: "Publish to profile". */
  showOnProfile: integer("show_on_profile", { mode: "boolean" }).notNull().default(false),
  coverAssetId: text("cover_asset_id"),
  /** Migration 0013: `link` (anyone with the link) or `workspace` (signed-in members only). */
  audience: text("audience", { enum: ["link", "workspace"] }).notNull().default("link"),
  /** Migration 0013: prompts are kept in the snapshot only when true. */
  showPrompt: integer("show_prompt", { mode: "boolean" }).notNull().default(true),
}, (t) => [index("share_links_project").on(t.projectId), check("share_links_audience_check", sql`${t.audience} IN ('link','workspace')`), index("share_links_profile").on(t.createdBy, t.showOnProfile, sql`${t.createdAt} DESC`)]);

/** Migration 0013: R2 prefixes queued for deletion (account deletion), worked through by the sweep cron. */
export const r2Cleanup = sqliteTable(
  "r2_cleanup",
  {
    prefix: text("prefix").primaryKey(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull(),
    doneAt: integer("done_at"),
  },
  (t) => [index("r2_cleanup_pending").on(t.doneAt, t.createdAt)],
);

/** Migration 0013: Help → Send feedback. */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    workspaceId: text("workspace_id"),
    kind: text("kind", { enum: ["bug", "idea", "other"] }).notNull(),
    message: text("message").notNull(),
    page: text("page"),
    diagnostics: text("diagnostics"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("feedback_time").on(sql`${t.createdAt} DESC`), check("feedback_kind_check", sql`${t.kind} IN ('bug','idea','other')`)],
);

/** Migration 0014: MP4 exports of a project's timeline (ExportWorkflow + FfmpegRenderer). */
export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    canvasId: text("canvas_id").notNull(),
    preset: text("preset", { enum: ["mp4_1080p", "mp4_720p", "vertical_9x16", "square_1x1", "landscape_16x9"] }).notNull(),
    rangeStart: real("range_start"),
    rangeEnd: real("range_end"),
    timelineRevision: integer("timeline_revision").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
    progress: real("progress").notNull().default(0),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    duration: real("duration").notNull(),
    assetId: text("asset_id"),
    r2Key: text("r2_key"),
    size: integer("size"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    /** Migration 0031 (D-034): export options (captions, smoother motion, brand kit), batch and preview. */
    options: text("options").notNull().default("{}"),
    batchId: text("batch_id"),
    preview: integer("preview", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("exports_project").on(t.projectId, sql`${t.createdAt} DESC`),
    index("exports_batch").on(t.batchId),
    check("exports_preset_check", sql`${t.preset} IN ('mp4_1080p','mp4_720p','vertical_9x16','square_1x1','landscape_16x9')`),
    check("exports_status_check", sql`${t.status} IN ('queued','running','done','failed')`),
  ],
);

export const agentThreads = sqliteTable("agent_threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  surface: text("surface").notNull(),
  skill: text("skill"),
  title: text("title"),
  updatedAt: integer("updated_at").notNull(),
  /** Migration 0008. */
  createdBy: text("created_by"),
}, (t) => [index("agent_threads_ws").on(t.workspaceId, t.updatedAt)]);

/** M6: proposal id -> thread, for the apply/discard routes (migration 0008). */
export const agentProposals = sqliteTable("agent_proposals", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("proposed"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("agent_proposals_thread").on(t.threadId)]);

/**
 * D-012: one row per agent turn with its gateway cost (migration 0011; replaces
 * 0008's daily turn counts). History mirror of the CreditAccount agent ledger.
 */
export const agentUsage = sqliteTable("agent_usage", {
  turnId: text("turn_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id"),
  threadId: text("thread_id"),
  /** Public LLM id. */
  llm: text("llm").notNull(),
  periodStart: integer("period_start").notNull(),
  costUsd: real("cost_usd").notNull().default(0),
  overrunUsd: real("overrun_usd").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  /** `settled`, `released` or `unmetered` (DeepSeek, D-012 amendment: cost recorded, no allowance hold). */
  status: text("status").notNull().default("settled"),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("agent_usage_ws").on(t.workspaceId, t.periodStart),
  index("agent_usage_ws_llm").on(t.workspaceId, t.llm, sql`${t.createdAt} DESC`),
  // Migration 0018: retention purge and pseudonymisation.
  index("agent_usage_time").on(t.createdAt),
  index("agent_usage_user").on(t.userId),
]);

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

/** D-005 safety log (migration 0009): no prompt beyond a 200-character excerpt, no media. */
export const safetyEvents = sqliteTable(
  "safety_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    jobId: text("job_id"),
    stage: text("stage", { enum: ["pre", "post", "agent", "quote", "upload"] }).notNull(),
    verdict: text("verdict", { enum: ["allow", "block"] }).notNull(),
    /** JSON array of SafetyCode. */
    codes: text("codes").notNull().default("[]"),
    model: text("model"),
    excerpt: text("excerpt"),
    /** At least one hard-limit code (counts toward the review flag). */
    hard: integer("hard", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("safety_events_ws").on(t.workspaceId, t.hard, sql`${t.createdAt} DESC`), index("safety_events_time").on(sql`${t.createdAt} DESC`), index("safety_events_user").on(t.userId)],
);

/** Classifier assessments by content hash (migration 0009). */
export const safetyCache = sqliteTable(
  "safety_cache",
  {
    key: text("key").primaryKey(),
    /** JSON assessment. */
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("safety_cache_expiry").on(t.expiresAt)],
);

/**
 * Migration 0018: one row per deleted account (durable deletion job, AccountDeletionWorkflow).
 * `userId` holds the raw id only while the job runs; it becomes the tombstone when done.
 */
export const accountDeletions = sqliteTable(
  "account_deletions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tombstone: text("tombstone").notNull(),
    status: text("status", { enum: ["pending", "done"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    doneAt: integer("done_at"),
  },
  (t) => [index("account_deletions_pending").on(t.status, t.updatedAt), check("account_deletions_status_check", sql`${t.status} IN ('pending','done')`)],
);

export const accountDeletionItemKinds = ["project_room", "project_pseudonymize", "agent_session", "credit_account", "user_hub"] as const;

/** Migration 0018: Durable Objects a deletion job wipes or pseudonymises. */
export const accountDeletionItems = sqliteTable(
  "account_deletion_items",
  {
    deletionId: text("deletion_id").notNull(),
    kind: text("kind", { enum: accountDeletionItemKinds }).notNull(),
    ref: text("ref").notNull(),
    doneAt: integer("done_at"),
  },
  (t) => [primaryKey({ columns: [t.deletionId, t.kind, t.ref] }), index("account_deletion_items_pending").on(t.deletionId, t.doneAt)],
);

/** Migration 0018: Settings → Account → Export my data (DataExportWorkflow). */
export const dataExports = sqliteTable(
  "data_exports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed", "expired"] }).notNull().default("queued"),
    r2Key: text("r2_key"),
    size: integer("size"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    expiresAt: integer("expires_at"),
  },
  (t) => [index("data_exports_user").on(t.userId, sql`${t.createdAt} DESC`)],
);

/** Migration 0024 (D-020): gateway features this environment's account may not have yet (`prompt_expand`). */
export const gatewayFeatures = sqliteTable("gateway_features", {
  feature: text("feature").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  reason: text("reason"),
  checkedAt: integer("checked_at").notNull(),
});

/** Migration 0032 (D-024): Auto mode's retries with a review fix, at most one per node per budget key (turn, else run). */
export const reviewRetries = sqliteTable(
  "review_retries",
  {
    budgetKey: text("budget_key").notNull(),
    nodeId: text("node_id").notNull(),
    jobId: text("job_id").notNull(),
    runId: text("run_id").notNull(),
    retryRunId: text("retry_run_id"),
    credits: integer("credits").notNull(),
    prevParams: text("prev_params"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.budgetKey, t.nodeId] })],
);

/*
 * Operations (migration 0027, D-025 .. D-030): staff, admin audit, suspensions, notices,
 * trust & safety cases and evidence, status probes, ops settings, gateway breaker, backups.
 */
export const staffRoles = ["admin", "reviewer"] as const;

export const staff = sqliteTable("staff", {
  email: text("email").primaryKey(),
  userId: text("user_id").unique(),
  role: text("role", { enum: staffRoles }).notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by"),
});

/** Append-only (UPDATE and DELETE are refused by triggers). */
export const adminAudit = sqliteTable(
  "admin_audit",
  {
    id: text("id").primaryKey(),
    actorKind: text("actor_kind", { enum: ["staff", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    reason: text("reason"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("admin_audit_time").on(sql`${t.createdAt} DESC`), index("admin_audit_target").on(t.targetKind, t.targetId, sql`${t.createdAt} DESC`)],
);

export const suspensions = sqliteTable(
  "suspensions",
  {
    id: text("id").primaryKey(),
    subjectKind: text("subject_kind", { enum: ["user", "workspace"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").notNull(),
    caseId: text("case_id"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    liftedAt: integer("lifted_at"),
    liftedBy: text("lifted_by"),
  },
  (t) => [index("suspensions_subject").on(t.subjectKind, t.subjectId, t.liftedAt)],
);

export const userNotices = sqliteTable(
  "user_notices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id"),
    kind: text("kind", { enum: ["warning", "content_removed", "suspended", "restored"] }).notNull(),
    message: text("message").notNull(),
    caseId: text("case_id"),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (t) => [index("user_notices_user").on(t.userId, t.readAt, sql`${t.createdAt} DESC`)],
);

export const trustCaseKinds = ["safety", "report", "appeal", "dmca", "counter_notice", "child_safety"] as const;
export const trustCaseStatuses = ["open", "actioned", "dismissed", "closed"] as const;

export const trustCases = sqliteTable(
  "trust_cases",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: trustCaseKinds }).notNull(),
    status: text("status", { enum: trustCaseStatuses }).notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    workspaceId: text("workspace_id"),
    userId: text("user_id"),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    targetUrl: text("target_url"),
    category: text("category"),
    details: text("details"),
    reporterUserId: text("reporter_user_id"),
    reporterEmail: text("reporter_email"),
    data: text("data").notNull().default("{}"),
    dedupeKey: text("dedupe_key"),
    relatedCaseId: text("related_case_id"),
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("trust_cases_queue").on(t.status, sql`${t.priority} DESC`, t.createdAt),
    index("trust_cases_workspace").on(t.workspaceId, sql`${t.createdAt} DESC`),
    index("trust_cases_user").on(t.userId, sql`${t.createdAt} DESC`),
    uniqueIndex("trust_cases_open_dedupe").on(t.dedupeKey).where(sql`${t.status} = 'open' AND ${t.dedupeKey} IS NOT NULL`),
  ],
);

/** Locked evidence of child-safety cases (rows cannot be deleted before the case is closed and retention passed). */
export const evidenceItems = sqliteTable(
  "evidence_items",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    kind: text("kind", { enum: ["object", "text"] }).notNull(),
    r2Key: text("r2_key").notNull(),
    sourceKey: text("source_key").notNull(),
    sha256: text("sha256"),
    size: integer("size"),
    contentType: text("content_type"),
    capturedAt: integer("captured_at").notNull(),
    retainUntil: integer("retain_until").notNull(),
  },
  (t) => [uniqueIndex("evidence_items_case_id_source_key_unique").on(t.caseId, t.sourceKey), index("evidence_items_case").on(t.caseId)],
);

export const statusComponents = ["api", "gateway", "media", "auth"] as const;

export const statusChecks = sqliteTable(
  "status_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    component: text("component", { enum: statusComponents }).notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    latencyMs: integer("latency_ms"),
    detail: text("detail"),
    checkedAt: integer("checked_at").notNull(),
  },
  (t) => [index("status_checks_component").on(t.component, sql`${t.checkedAt} DESC`)],
);

export const opsSettings = sqliteTable("ops_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export const gatewayBreaker = sqliteTable("gateway_breaker", {
  gateway: text("gateway").primaryKey(),
  state: text("state", { enum: ["closed", "open"] }).notNull().default("closed"),
  failures: integer("failures").notNull().default(0),
  windowStart: integer("window_start").notNull().default(0),
  openedAt: integer("opened_at"),
  openUntil: integer("open_until"),
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});

export const backupRuns = sqliteTable("backup_runs", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
  creditAccounts: integer("credit_accounts").notNull().default(0),
  projectRooms: integer("project_rooms").notNull().default(0),
  bytes: integer("bytes").notNull().default(0),
  pruned: integer("pruned").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

/** Migration 0030 (D-031): client review links (media frozen at creation, reviewers without an account). */
export const reviewLinks = sqliteTable(
  "review_links",
  {
    id: text("id").primaryKey(),
    /** Unguessable URL token (`/review/<token>`). */
    token: text("token").notNull(),
    projectId: text("project_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind", { enum: ["version", "export", "shots"] }).notNull(),
    title: text("title").notNull(),
    /** JSON ReviewItem[] (`@rolling/core/collab`). */
    items: text("items").notNull().default("[]"),
    /** Confirmed mature items (D-005): shown only to signed-in mature-allowed viewers. */
    mature: integer("mature", { mode: "boolean" }).notNull().default(false),
    passwordHash: text("password_hash"),
    passwordVersion: integer("password_version").notNull().default(0),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("review_links_token").on(t.token),
    index("review_links_project").on(t.projectId, sql`${t.createdAt} DESC`),
    check("review_links_kind_check", sql`${t.kind} IN ('version','export','shots')`),
  ],
);

/** Migration 0030: reviewers who verified their email on a link (bearer token stored hashed). */
export const reviewReviewers = sqliteTable(
  "review_reviewers",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    verifiedAt: integer("verified_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("review_reviewers_token").on(t.tokenHash), uniqueIndex("review_reviewers_link_email").on(t.linkId, t.email)],
);

/** Migration 0030: pending one-time codes per link and email. */
export const reviewCodes = sqliteTable(
  "review_codes",
  {
    linkId: text("link_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.email] })],
);

/** Migration 0030: approve / request changes, one row per decision (the latest per reviewer counts). */
export const reviewDecisions = sqliteTable(
  "review_decisions",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    decision: text("decision", { enum: ["approved", "changes_requested"] }).notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("review_decisions_link").on(t.linkId, t.createdAt), check("review_decisions_check", sql`${t.decision} IN ('approved','changes_requested')`)],
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

/** Migration 0031 (D-033, D-034): auto captions / transcripts (Workers AI Whisper) and Resize jobs. */
export const postJobs = sqliteTable(
  "post_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["captions", "transcript", "resize"] }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    canvasId: text("canvas_id"),
    assetId: text("asset_id"),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
    progress: real("progress").notNull().default(0),
    params: text("params").notNull().default("{}"),
    result: text("result"),
    audioSeconds: real("audio_seconds").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("post_jobs_ws").on(t.workspaceId, t.kind, sql`${t.createdAt} DESC`),
    index("post_jobs_project").on(t.projectId, sql`${t.createdAt} DESC`),
    check("post_jobs_kind_check", sql`${t.kind} IN ('captions','transcript','resize')`),
    check("post_jobs_status_check", sql`${t.status} IN ('queued','running','done','failed')`),
  ],
);

/** Migration 0031 (D-036, D-037): where a run's output lands on the timeline (extend after a clip, lip-sync replaces a shot). */
export const timelinePlacements = sqliteTable(
  "timeline_placements",
  {
    id: text("id").primaryKey(),
    quoteId: text("quote_id").notNull().unique(),
    runId: text("run_id"),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    canvasId: text("canvas_id").notNull(),
    mode: text("mode", { enum: ["after", "replace"] }).notNull(),
    anchorClipId: text("anchor_clip_id").notNull(),
    placedClipId: text("placed_clip_id"),
    seconds: real("seconds").notNull(),
    previous: text("previous"),
    status: text("status", { enum: ["quoted", "pending", "placed", "dropped"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("timeline_placements_run").on(t.runId),
    check("timeline_placements_mode_check", sql`${t.mode} IN ('after','replace')`),
    check("timeline_placements_status_check", sql`${t.status} IN ('quoted','pending','placed','dropped')`),
  ],
);

/** Migration 0031 (D-035): one brand kit per workspace (`data`: BrandKit JSON from `@rolling/core/post`). */
export const brandKits = sqliteTable("brand_kits", {
  workspaceId: text("workspace_id").primaryKey(),
  data: text("data").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Migration 0029 (D-032): sheet pictures of a character version, so runs can tell them apart. */
export const characterSheetAssets = sqliteTable(
  "character_sheet_assets",
  {
    assetId: text("asset_id").primaryKey(),
    characterId: text("character_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    version: integer("version").notNull(),
    view: text("view").notNull(),
    outfitId: text("outfit_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("character_sheet_assets_char").on(t.characterId, t.version)],
);

/** Migration 0029 (D-032): consistency check per output (drift score). */
export const characterChecks = sqliteTable(
  "character_checks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    characterId: text("character_id").notNull(),
    version: integer("version").notNull(),
    assetId: text("asset_id").notNull(),
    runId: text("run_id"),
    jobId: text("job_id"),
    projectId: text("project_id"),
    score: real("score"),
    verdict: text("verdict", { enum: ["consistent", "minor", "drift", "no_face", "error"] }).notNull(),
    faces: integer("faces").notNull().default(0),
    method: text("method").notNull(),
    model: text("model"),
    costUsd: real("cost_usd"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("character_checks_char").on(t.characterId, sql`${t.createdAt} DESC`),
    index("character_checks_asset").on(t.assetId),
    check("character_checks_verdict_check", sql`${t.verdict} IN ('consistent','minor','drift','no_face','error')`),
  ],
);

/** Migration 0029 (D-032): projects that used a character. */
export const characterUses = sqliteTable(
  "character_uses",
  {
    characterId: text("character_id").notNull(),
    projectId: text("project_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    uses: integer("uses").notNull().default(1),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.projectId] }), index("character_uses_ws").on(t.workspaceId, sql`${t.lastUsedAt} DESC`)],
);
