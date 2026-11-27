/**
 * Durable Object SQLite backups (D-030): a JSON dump of every user table of a
 * DO's storage, and its restore. Used by `exportBackup` / `restoreBackup` on
 * CreditAccount and ProjectRoom (BackupWorkflow writes the dumps to the
 * private R2 prefix `backups/`).
 *
 * Restore replaces every table's rows inside one synchronous transaction. The
 * dump's migration version must equal the object's, so the schema matches.
 * Internal tables (`_cf_*`, `sqlite_*`) are never dumped or touched.
 */
import type { MigratableStorage } from "./migrate";

export interface DoDump {
  format: 1;
  /** `CreditAccount` or `ProjectRoom`. */
  kind: string;
  /** `idFromName` of the object (workspace id, project id). */
  name: string;
  schemaVersion: number;
  createdAt: number;
  tables: Record<string, { columns: string[]; rows: unknown[][] }>;
}

function userTables(storage: MigratableStorage): string[] {
  return storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .toArray()
    .map((r) => String(r.name));
}

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function schemaVersionOf(storage: MigratableStorage): number {
  try {
    return Number(storage.sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").toArray()[0]?.v ?? 0);
  } catch {
    return 0;
  }
}

/** Binary values become `{ $b64 }` so the dump stays JSON. */
function encode(v: unknown): unknown {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return { $b64: btoa(s) };
  }
  return v;
}

function decode(v: unknown): unknown {
  if (v && typeof v === "object" && "$b64" in v && typeof (v as { $b64: unknown }).$b64 === "string") {
    const s = atob((v as { $b64: string }).$b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  }
  return v;
}

export function dumpDurableObject(storage: MigratableStorage, kind: string, name: string, now = Date.now()): DoDump {
  const tables: DoDump["tables"] = {};
  for (const t of userTables(storage)) {
    const cols = storage.sql.exec(`PRAGMA table_info(${quote(t)})`).toArray().map((c) => String(c.name));
    const rows = storage.sql
      .exec(`SELECT ${cols.map(quote).join(", ")} FROM ${quote(t)}`)
      .toArray()
      .map((r) => cols.map((c) => encode(r[c] ?? null)));
    tables[t] = { columns: cols, rows };
  }
  return { format: 1, kind, name, schemaVersion: schemaVersionOf(storage), createdAt: now, tables };
}

export function isEmptyDurableObject(storage: MigratableStorage, ignore: readonly string[] = []): boolean {
  for (const t of userTables(storage)) {
    if (t === "_migrations" || ignore.includes(t)) continue;
    const n = Number(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(t)}`).toArray()[0]?.n ?? 0);
    if (n > 0) return false;
  }
  return true;
}

export class BackupMismatchError extends Error {
  override readonly name = "BackupMismatchError";
}

/** Replaces the object's rows with the dump's (one transaction). Returns the rows written. */
export function restoreDurableObject(storage: MigratableStorage, dump: DoDump, expect: { kind: string; name?: string }): number {
  if (dump.format !== 1) throw new BackupMismatchError("Unknown backup format.");
  if (dump.kind !== expect.kind) throw new BackupMismatchError(`Backup is for ${dump.kind}, not ${expect.kind}.`);
  if (expect.name && dump.name !== expect.name) throw new BackupMismatchError(`Backup is for ${dump.name}, not ${expect.name}.`);
  const version = schemaVersionOf(storage);
  if (dump.schemaVersion !== version) throw new BackupMismatchError(`Backup schema v${dump.schemaVersion} does not match v${version}.`);
  const existing = new Set(userTables(storage));
  let written = 0;
  storage.transactionSync(() => {
    for (const [table, data] of Object.entries(dump.tables)) {
      if (table === "_migrations") continue;
      if (!existing.has(table)) throw new BackupMismatchError(`Unknown table ${table}.`);
      storage.sql.exec(`DELETE FROM ${quote(table)}`);
      if (data.rows.length === 0) continue;
      const sql = `INSERT INTO ${quote(table)} (${data.columns.map(quote).join(", ")}) VALUES (${data.columns.map(() => "?").join(", ")})`;
      for (const row of data.rows) {
        storage.sql.exec(sql, ...row.map(decode));
        written++;
      }
    }
  });
  return written;
}
