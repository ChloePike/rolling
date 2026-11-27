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

/**
 * `opts.chain` names a separate migration chain (`_migrations_<chain>`) in the
 * same storage, so a feature area (e.g. ProjectRoom collaboration, D-031)
 * versions its tables on its own and never races the main chain's numbers.
 */
export function migrateDurableObject(storage: MigratableStorage, migrations: readonly DoMigration[], opts: { chain?: string } = {}): number {
  if (opts.chain !== undefined && !/^[a-z][a-z0-9_]{0,31}$/.test(opts.chain)) throw new Error(`Invalid migration chain ${opts.chain}`);
  const table = opts.chain ? `_migrations_${opts.chain}` : "_migrations";
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  const row = storage.sql.exec(`SELECT COALESCE(MAX(version), 0) AS v FROM ${table}`).toArray()[0];
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
        `INSERT INTO ${table} (version, name, applied_at) VALUES (?, ?, ?)`,
        m.version,
        m.name,
        Date.now(),
      );
    });
    current = m.version;
  }
  return current;
}
