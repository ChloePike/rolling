/**
 * `AgentAllowanceStore` over the CreditAccount DO's SQLite (`agent_holds`,
 * migration v3; idempotency records share the ledger's `idempotency` table).
 */
import type { AgentHoldRecord, AgentAllowanceStore, IdemRecord } from "@rolling/core/credits";

type Row = Record<string, SqlStorageValue>;

const num = (v: SqlStorageValue | undefined): number => Number(v ?? 0);
const numOrNull = (v: SqlStorageValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function holdFromRow(r: Row): AgentHoldRecord {
  return {
    turnId: String(r.turn_id),
    userId: String(r.user_id),
    llm: String(r.llm),
    periodStart: num(r.period_start),
    estimateMicros: num(r.estimate_micros),
    actualMicros: numOrNull(r.actual_micros),
    overrunMicros: num(r.overrun_micros),
    status: String(r.status) as AgentHoldRecord["status"],
    createdAt: num(r.created_at),
    closedAt: numOrNull(r.closed_at),
  };
}

export class SqlAgentAllowanceStore implements AgentAllowanceStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private all(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as Row[];
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  getAgentHold(turnId: string): AgentHoldRecord | null {
    const r = this.all("SELECT * FROM agent_holds WHERE turn_id = ?", turnId)[0];
    return r ? holdFromRow(r) : null;
  }

  putAgentHold(h: AgentHoldRecord): void {
    this.storage.sql.exec(
      `INSERT INTO agent_holds (turn_id, user_id, llm, period_start, estimate_micros, actual_micros, overrun_micros, status, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (turn_id) DO UPDATE SET actual_micros = excluded.actual_micros, overrun_micros = excluded.overrun_micros, status = excluded.status, closed_at = excluded.closed_at`,
      h.turnId,
      h.userId,
      h.llm,
      h.periodStart,
      h.estimateMicros,
      h.actualMicros,
      h.overrunMicros,
      h.status,
      h.createdAt,
      h.closedAt,
    );
  }

  agentUsedMicros(periodStart: number): number {
    return num(this.all("SELECT COALESCE(SUM(actual_micros), 0) AS s FROM agent_holds WHERE status = 'settled' AND period_start = ?", periodStart)[0]?.s);
  }

  openAgentHolds(): AgentHoldRecord[] {
    return this.all("SELECT * FROM agent_holds WHERE status = 'held'").map(holdFromRow);
  }

  recentAgentCosts(llm: string, limit: number): number[] {
    return this.all("SELECT actual_micros FROM agent_holds WHERE llm = ? AND status = 'settled' ORDER BY closed_at DESC LIMIT ?", llm, limit).map((r) => num(r.actual_micros));
  }

  getIdem(key: string): IdemRecord | null {
    const r = this.all("SELECT * FROM idempotency WHERE key = ?", key)[0];
    if (!r) return null;
    return { key: String(r.key), op: String(r.op), fingerprint: String(r.fingerprint), result: JSON.parse(String(r.result)), createdAt: num(r.created_at) };
  }

  putIdem(rec: IdemRecord): void {
    this.storage.sql.exec(
      "INSERT INTO idempotency (key, op, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)",
      rec.key,
      rec.op,
      rec.fingerprint,
      JSON.stringify(rec.result ?? null),
      rec.createdAt,
    );
  }
}
