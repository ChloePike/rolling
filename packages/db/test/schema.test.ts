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
    expect(files).toEqual(["0001_init.sql", "0002_models.sql", "0003_plan_names.sql", "0004_auth.sql", "0005_billing.sql", "0006_projects_assets.sql", "0007_runs.sql", "0008_agent.sql", "0009_safety.sql", "0010_uploads.sql"]);
    for (const f of files) db.exec(readFileSync(new URL(f, dir), "utf8"));
    expectSchemaMatches(db, tablesOf(d1));
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
