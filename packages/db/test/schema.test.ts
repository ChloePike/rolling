import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as d1 from "../src/d1/schema";
import * as projectDo from "../src/do/project";
import * as creditsDo from "../src/do/credits";
import * as agentDo from "../src/do/agent";
import { migrateDurableObject, type MigratableStorage, type DoMigration } from "../src/do/migrate";

function tablesOf(mod: Record<string, unknown>): SQLiteTable[] {
  return Object.values(mod).filter(
    (v): v is SQLiteTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v,
  );
}

function columnsIn(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => String(r.name))
    .sort();
}

function expectSchemaMatches(db: DatabaseSync, tables: SQLiteTable[]) {
  expect(tables.length).toBeGreaterThan(0);
  for (const t of tables) {
    const cfg = getTableConfig(t);
    expect(columnsIn(db, cfg.name), `table ${cfg.name}`).toEqual(cfg.columns.map((c) => c.name).sort());
  }
}

/** Adapts node:sqlite to the structural DO storage used by the migration helper. */
function fakeStorage(db: DatabaseSync): MigratableStorage {
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (bindings.length === 0 && !/^\s*select/i.test(query)) {
          db.exec(query);
          return { toArray: () => [] };
        }
        if (/^\s*select/i.test(query)) return { toArray: () => db.prepare(query).all(...bindings) };
        db.prepare(query).all(...bindings);
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

describe("D1 migration", () => {
  it("matches the Drizzle schema", () => {
    const db = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/d1/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toEqual(["0001_init.sql", "0002_models.sql", "0003_plan_names.sql", "0004_auth.sql", "0005_billing.sql", "0006_projects_assets.sql", "0007_runs.sql", "0008_agent.sql", "0009_safety.sql", "0010_uploads.sql", "0011_agent_allowance.sql", "0012_team.sql", "0013_account.sql", "0014_exports.sql", "0015_runs_templates.sql", "0016_seed_templates.sql", "0017_template_covers.sql", "0018_privacy.sql", "0019_seed_inspiration_templates.sql", "0020_template_media.sql", "0021_template_feed_order.sql", "0022_public_items_asset_index.sql", "0023_inspiration_people.sql", "0024_prompt_expand.sql", "0025_run_surface.sql", "0027_operations.sql", "0031_post_production.sql", "0032_review.sql"]);
    for (const f of files) db.exec(readFileSync(new URL(f, dir), "utf8"));
    expectSchemaMatches(db, tablesOf(d1));
    // 0015: run requests and retries, template listing fields; 0016 seeds the built-in templates.
    expect(columnsIn(db, "runs")).toEqual(expect.arrayContaining(["request", "retry_of", "tool", "character_id"]));
    // 0027: operations (staff seeded with the owner, audit log append-only, evidence locked).
    expect(String(db.prepare("SELECT role FROM staff WHERE email = 'phd.chloepike@gmail.com'").all()[0]?.role)).toBe("admin");
    db.exec("INSERT INTO admin_audit (id, actor_kind, action, created_at) VALUES ('aud_1', 'system', 'test', 1)");
    expect(() => db.exec("UPDATE admin_audit SET action = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM admin_audit")).toThrow(/append-only/);
    db.exec("INSERT INTO trust_cases (id, kind, created_at, updated_at) VALUES ('case_1', 'child_safety', 1, 1)");
    db.exec("INSERT INTO evidence_items (id, case_id, kind, r2_key, source_key, captured_at, retain_until) VALUES ('evi_1', 'case_1', 'text', 'evidence/case_1/prompt.txt', 'prompt', 1, 2)");
    expect(() => db.exec("DELETE FROM evidence_items")).toThrow(/locked/);
    db.exec("UPDATE trust_cases SET status = 'closed' WHERE id = 'case_1'");
    db.exec("DELETE FROM evidence_items");
    // 0025: where a run was started.
    expect(columnsIn(db, "runs")).toContain("surface");
    expect(columnsIn(db, "templates")).toEqual(expect.arrayContaining(["description", "meta", "created_at"]));
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM templates WHERE workspace_id IS NULL").all()[0]?.n)).toBeGreaterThanOrEqual(6);
    // 0017, 0020: built-in template covers; 0019: at least 6 built-ins per Home inspiration category.
    for (const cat of ["product", "talking", "drama", "holiday"]) {
      expect(Number(db.prepare("SELECT COUNT(*) AS n FROM templates WHERE workspace_id IS NULL AND category = ?").all(cat)[0]?.n), cat).toBeGreaterThanOrEqual(6);
    }
    const covers = db
      .prepare("SELECT id, json_extract(meta, '$.coverKey') AS k, json_extract(meta, '$.coverWidth') AS w, json_extract(meta, '$.coverColor') AS c, json_extract(meta, '$.tags') AS tags FROM templates WHERE workspace_id IS NULL")
      .all() as Array<{ id: string; k: string; w: number; c: string; tags: string }>;
    // 0023: people in complex scenes; the new built-ins arrive with their covers.
    for (const id of ["tpl_drama_dinner_party", "tpl_drama_last_rehearsal", "tpl_concert_vlog", "tpl_cooking_show", "tpl_wedding_toast", "tpl_market_handoff"]) {
      expect(covers.find((r) => r.id === id)?.k, id).toBeTruthy();
    }
    for (const r of covers) {
      expect(r.k, r.id).toMatch(new RegExp(`^public/templates/${r.id}/poster-[0-9a-f]{10}\\.jpg$`));
      expect(r.w, r.id).toBe(720);
      expect(r.c, r.id).toMatch(/^#[0-9a-f]{6}$/);
      // 0020 merges into meta: the seed's listing fields stay.
      expect(JSON.parse(r.tags).length, r.id).toBeGreaterThan(0);
    }
    // 0024 (D-020): Enhance prompt default on, expanded prompts on jobs, gateway feature flags.
    expect(columnsIn(db, "user_prefs")).toContain("enhance_prompt");
    expect(columnsIn(db, "jobs")).toContain("expanded_prompt");
    expect(columnsIn(db, "gateway_features")).toEqual(["checked_at", "enabled", "feature", "reason"]);
    // 0032 (D-024): result review pref, verdicts on jobs, Auto retries.
    expect(columnsIn(db, "user_prefs")).toContain("review_results");
    expect(columnsIn(db, "jobs")).toEqual(expect.arrayContaining(["review", "review_cost_usd"]));
    expect(columnsIn(db, "review_retries")).toEqual(["budget_key", "created_at", "credits", "job_id", "node_id", "prev_params", "retry_run_id", "run_id"]);
    // 0014: exports.
    expect(columnsIn(db, "exports")).toEqual(expect.arrayContaining(["preset", "status", "progress", "asset_id", "range_start", "range_end"]));
    // 0013: profiles, avatars, profile publishing, feedback, account deletion.
    expect(columnsIn(db, "share_links")).toEqual(expect.arrayContaining(["show_on_profile", "cover_asset_id"]));
    db.exec("INSERT INTO user_prefs (user_id, handle) VALUES ('usr_h1', 'ada')");
    expect(() => db.exec("INSERT INTO user_prefs (user_id, handle) VALUES ('usr_h2', 'ADA')")).toThrow();
    // 0012 (D-013): Team seats.
    expect(columnsIn(db, "subscriptions")).toContain("seats");
    expect(columnsIn(db, "checkout_sessions")).toContain("seats");
    expect(columnsIn(db, "models")).toEqual(["data", "hidden", "id", "kind", "mature", "price", "synced_at"]);
    expect(columnsIn(db, "user_prefs")).toContain("mature_content");
    expect(columnsIn(db, "workspaces")).toContain("mature_allowed");
    // 0009 (D-005): review flag and content ratings.
    expect(columnsIn(db, "workspaces")).toContain("safety_flag");
    expect(columnsIn(db, "assets")).toEqual(expect.arrayContaining(["rating", "rating_confidence", "rating_model"]));
    // 0004: theme (D-010) and confirm threshold default 300 (D-006).
    expect(columnsIn(db, "user_prefs")).toContain("theme");
    db.exec("INSERT INTO user_prefs (user_id) VALUES ('usr_t')");
    expect(db.prepare("SELECT confirm_threshold, theme FROM user_prefs WHERE user_id = 'usr_t'").all()[0]).toEqual({ confirm_threshold: 300, theme: "system" });
  });
});

describe.each<[string, readonly DoMigration[], Record<string, unknown>]>([
  ["project", projectDo.projectMigrations, projectDo],
  ["credits", creditsDo.creditsMigrations, creditsDo],
  ["agent", agentDo.agentMigrations, agentDo],
])("DO %s migrations", (_name, migrations, mod) => {
  it("apply once, are idempotent, and match the Drizzle schema", () => {
    const db = new DatabaseSync(":memory:");
    const storage = fakeStorage(db);
    expect(migrateDurableObject(storage, migrations)).toBe(migrations.length);
    expect(migrateDurableObject(storage, migrations)).toBe(migrations.length);
    expectSchemaMatches(db, tablesOf(mod));
  });
});

describe("D1 0031 post-production (D-033 .. D-037)", () => {
  it("keeps exports while widening the presets, and adds post jobs, placements and brand kits", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../migrations/d1/0014_exports.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO exports (id, workspace_id, project_id, canvas_id, preset, timeline_revision, status, width, height, duration, created_by, created_at) VALUES ('exp_1', 'ws', 'prj', 'cnv', 'mp4_720p', 1, 'done', 1280, 720, 5, 'u', 1)");
    db.exec(readFileSync(new URL("../migrations/d1/0031_post_production.sql", import.meta.url), "utf8"));
    expect({ ...(db.prepare("SELECT preset, options, preview FROM exports WHERE id = 'exp_1'").all()[0] as object) }).toEqual({ preset: "mp4_720p", options: "{}", preview: 0 });
    db.exec("INSERT INTO exports (id, workspace_id, project_id, canvas_id, preset, timeline_revision, status, width, height, duration, created_by, created_at, batch_id) VALUES ('exp_2', 'ws', 'prj', 'cnv', 'vertical_9x16', 1, 'queued', 1080, 1920, 5, 'u', 1, 'b1')");
    expect(() => db.exec("INSERT INTO exports (id, workspace_id, project_id, canvas_id, preset, timeline_revision, status, width, height, duration, created_by, created_at) VALUES ('exp_3', 'ws', 'prj', 'cnv', 'gif', 1, 'queued', 1, 1, 1, 'u', 1)")).toThrow();
    expect(() => db.exec("INSERT INTO post_jobs (id, kind, workspace_id, status, created_by, created_at) VALUES ('p', 'dub', 'ws', 'queued', 'u', 1)")).toThrow();
    expect(() => db.exec("INSERT INTO timeline_placements (id, quote_id, workspace_id, project_id, canvas_id, mode, anchor_clip_id, seconds, status, created_by, created_at, updated_at) VALUES ('p', 'q', 'ws', 'prj', 'cnv', 'before', 'v1', 5, 'quoted', 'u', 1, 1)")).toThrow();
    expect(columnsIn(db, "brand_kits")).toEqual(["data", "updated_at", "updated_by", "workspace_id"]);
  });
});
