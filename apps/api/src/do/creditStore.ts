/**
 * `LedgerStore` over the CreditAccount Durable Object's SQLite storage
 * (schema: `@rolling/db/do/credits`, migration v2). Synchronous, like the
 * ledger; `transaction` maps to `storage.transactionSync`.
 */
import type { AccountState, AutoTopUpSettings, HoldRecord, IdemRecord, LedgerLine, LedgerStore, PlanInterval, StoredQuote } from "@rolling/core/credits";
import type { PlanId } from "@rolling/core/pricing/config";

type Row = Record<string, SqlStorageValue>;

const num = (v: SqlStorageValue | undefined): number => Number(v ?? 0);
const numOrNull = (v: SqlStorageValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: SqlStorageValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

function parseAutoTopUp(raw: SqlStorageValue | undefined): AutoTopUpSettings | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as AutoTopUpSettings;
  } catch {
    return null;
  }
}

function holdFromRow(r: Row): HoldRecord {
  return {
    jobId: String(r.job_id),
    quoteId: String(r.quote_id),
    itemRef: String(r.item_ref),
    modelId: String(r.model_id),
    runId: String(r.run_id),
    userId: String(r.user_id),
    credits: num(r.credits),
    fromPlan: num(r.from_plan),
    fromPurchased: num(r.from_purchased),
    planExpiresAt: numOrNull(r.plan_expires_at),
    status: String(r.status) as HoldRecord["status"],
    spent: numOrNull(r.spent),
    createdAt: num(r.created_at),
    closedAt: numOrNull(r.closed_at),
  };
}

export function lineFromRow(r: Row): LedgerLine {
  return {
    id: String(r.id),
    kind: String(r.kind) as LedgerLine["kind"],
    bucket: String(r.bucket) as LedgerLine["bucket"],
    amount: num(r.amount),
    userId: strOrNull(r.user_id),
    runId: strOrNull(r.run_id),
    jobId: strOrNull(r.job_id),
    stripeRef: strOrNull(r.stripe_ref),
    idemKey: String(r.idem_key),
    note: strOrNull(r.note),
    createdAt: num(r.created_at),
  };
}

export class SqlLedgerStore implements LedgerStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql() {
    return this.storage.sql;
  }

  private all(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...bindings).toArray() as Row[];
  }

  private one(query: string, ...bindings: SqlStorageValue[]): Row | null {
    return this.all(query, ...bindings)[0] ?? null;
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  getAccount(): AccountState {
    const r = this.one("SELECT * FROM balance WHERE id = 1")!;
    return {
      plan: num(r.plan),
      purchased: num(r.purchased),
      held: num(r.held),
      planExpiresAt: numOrNull(r.plan_expires_at),
      planId: strOrNull(r.plan_id) as PlanId | null,
      interval: strOrNull(r.plan_interval) as PlanInterval | null,
      periodStart: numOrNull(r.period_start),
      periodEnd: numOrNull(r.period_end),
      autoTopUp: parseAutoTopUp(r.auto_topup),
      autoTopUpSeq: num(r.auto_topup_seq),
      seats: Math.max(1, num(r.seats ?? 1)),
      sliceSeats: Math.max(1, num(r.slice_seats ?? 1)),
      grantedPlanId: strOrNull(r.granted_plan_id) as PlanId | null,
    };
  }

  putAccount(s: AccountState): void {
    this.sql.exec(
      `UPDATE balance SET plan = ?, purchased = ?, held = ?, plan_expires_at = ?, plan_id = ?, plan_interval = ?,
         period_start = ?, period_end = ?, auto_topup = ?, auto_topup_seq = ?, seats = ?, slice_seats = ?, granted_plan_id = ? WHERE id = 1`,
      s.plan,
      s.purchased,
      s.held,
      s.planExpiresAt,
      s.planId,
      s.interval,
      s.periodStart,
      s.periodEnd,
      s.autoTopUp ? JSON.stringify(s.autoTopUp) : null,
      s.autoTopUpSeq,
      s.seats,
      s.sliceSeats,
      s.grantedPlanId,
    );
  }

  getQuote(id: string): StoredQuote | null {
    const r = this.one("SELECT * FROM quotes WHERE id = ?", id);
    if (!r) return null;
    return {
      id: String(r.id),
      items: JSON.parse(String(r.items)),
      total: num(r.total),
      createdAt: num(r.created_at),
      expiresAt: num(r.expires_at),
      runId: strOrNull(r.run_id),
    };
  }

  putQuote(q: StoredQuote): void {
    this.sql.exec(
      `INSERT INTO quotes (id, items, total, expires_at, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET items = excluded.items, total = excluded.total, expires_at = excluded.expires_at, run_id = excluded.run_id`,
      q.id,
      JSON.stringify(q.items),
      q.total,
      q.expiresAt,
      q.createdAt,
      q.runId,
    );
  }

  getHold(jobId: string): HoldRecord | null {
    const r = this.one("SELECT * FROM holds WHERE job_id = ?", jobId);
    return r ? holdFromRow(r) : null;
  }

  putHold(h: HoldRecord): void {
    this.sql.exec(
      `INSERT INTO holds (job_id, run_id, user_id, from_plan, from_purchased, created_at, quote_id, item_ref, model_id, credits, plan_expires_at, status, spent, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET status = excluded.status, spent = excluded.spent, closed_at = excluded.closed_at`,
      h.jobId,
      h.runId,
      h.userId,
      h.fromPlan,
      h.fromPurchased,
      h.createdAt,
      h.quoteId,
      h.itemRef,
      h.modelId,
      h.credits,
      h.planExpiresAt,
      h.status,
      h.spent,
      h.closedAt,
    );
  }

  openHolds(): HoldRecord[] {
    return this.all("SELECT * FROM holds WHERE status = 'held'").map(holdFromRow);
  }

  holdsForQuote(quoteId: string): HoldRecord[] {
    return this.all("SELECT * FROM holds WHERE quote_id = ?", quoteId).map(holdFromRow);
  }

  getMemberSpent(userId: string, month: string): number {
    return num(this.one("SELECT spent FROM member_usage WHERE user_id = ? AND month = ?", userId, month)?.spent);
  }

  addMemberSpent(userId: string, month: string, amount: number): void {
    this.sql.exec(
      `INSERT INTO member_usage (user_id, month, spent) VALUES (?, ?, ?)
       ON CONFLICT (user_id, month) DO UPDATE SET spent = spent + excluded.spent`,
      userId,
      month,
      amount,
    );
  }

  getIdem(key: string): IdemRecord | null {
    const r = this.one("SELECT * FROM idempotency WHERE key = ?", key);
    if (!r) return null;
    return { key: String(r.key), op: String(r.op), fingerprint: String(r.fingerprint), result: JSON.parse(String(r.result)), createdAt: num(r.created_at) };
  }

  putIdem(rec: IdemRecord): void {
    this.sql.exec(
      "INSERT INTO idempotency (key, op, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)",
      rec.key,
      rec.op,
      rec.fingerprint,
      JSON.stringify(rec.result ?? null),
      rec.createdAt,
    );
  }

  appendLines(lines: LedgerLine[]): void {
    for (const l of lines) {
      this.sql.exec(
        `INSERT INTO ledger (id, kind, bucket, amount, user_id, run_id, job_id, stripe_ref, idem_key, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        l.id,
        l.kind,
        l.bucket,
        l.amount,
        l.userId,
        l.runId,
        l.jobId,
        l.stripeRef,
        l.idemKey,
        l.createdAt,
        l.note,
      );
    }
  }

  // --- outbox and housekeeping (not part of LedgerStore) ---

  unmirroredLines(limit: number): LedgerLine[] {
    return this.all("SELECT * FROM ledger WHERE mirrored_at IS NULL ORDER BY created_at, id LIMIT ?", limit).map(lineFromRow);
  }

  markMirrored(ids: readonly string[], now: number): void {
    for (const id of ids) this.sql.exec("UPDATE ledger SET mirrored_at = ? WHERE id = ?", now, id);
  }

  allLines(): LedgerLine[] {
    return this.all("SELECT * FROM ledger ORDER BY created_at, id").map(lineFromRow);
  }

  getWorkspaceId(): string | null {
    return strOrNull(this.one("SELECT workspace_id FROM balance WHERE id = 1")?.workspace_id);
  }

  setWorkspaceId(id: string): void {
    this.sql.exec("UPDATE balance SET workspace_id = ? WHERE id = 1 AND workspace_id IS NULL", id);
  }

  /** Drops idempotency records and quotes nobody can use any more. Expiry markers stay. */
  purge(now: number, keepMs: number): void {
    this.sql.exec("DELETE FROM idempotency WHERE op <> 'expire' AND created_at < ?", now - keepMs);
    this.sql.exec("DELETE FROM quotes WHERE expires_at < ? AND id NOT IN (SELECT quote_id FROM holds WHERE status = 'held')", now - 2 * 86_400_000);
  }
}
