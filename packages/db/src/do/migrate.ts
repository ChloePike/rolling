/**
 * Minimal versioned migrations for Durable Object SQLite storage.
 *
 * Each DO keeps an ordered list of SQL migrations. `migrateDurableObject` is
 * called from the DO constructor inside `ctx.blockConcurrencyWhile`, records the
 * applied version in `_migrations`, and applies only the missing ones, each in
 * its own synchronous transaction.
 *
 * Never edit or reorder a shipped migration; append a new one.
 */

/** Structural subset of `DurableObjectStorage` so this package does not depend on workers-types. */
export interface MigratableStorage {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
}

export interface DoMigration {
  /** Strictly increasing, starting at 1. */
  version: number;
  name: string;
  /** One or more statements separated by `;`. */
  sql: string;
}

export function migrateDurableObject(storage: MigratableStorage, migrations: readonly DoMigration[]): number {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const row = storage.sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").toArray()[0];
  let current = Number(row?.v ?? 0);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (m.version <= current) continue;
    if (m.version !== current + 1) {
      throw new Error(`DO migration gap: expected version ${current + 1}, got ${m.version} (${m.name})`);
    }
    storage.transactionSync(() => {
      storage.sql.exec(m.sql);
      storage.sql.exec(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
        m.version,
        m.name,
        Date.now(),
      );
    });
    current = m.version;
  }
  return current;
}
