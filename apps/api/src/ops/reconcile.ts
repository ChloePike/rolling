/**
 * Nightly ledger reconcile (ops). For every workspace with ledger activity in
 * the last day, compares the CreditAccount DO (balance vs. its own lines, and
 * the totals of lines older than the cutoff) with the D1 `ledger_lines`
 * mirror. Lines newer than the cutoff may still be in the `ledger-mirror`
 * queue, so they are left out. Mismatches are logged and written to Analytics
 * Engine (`blobs: ['ledger_reconcile', status]`, index workspace); they never
 * change a balance (credits only change inside CreditAccount).
 */
import { reconcile } from "@rolling/core/credits";
import { creditAccount } from "../billing/credits";

/** Lines younger than this are skipped (mirror lag). */
export const RECONCILE_LAG_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WORKSPACES = 2000;

export type ReconcileStatus = "ok" | "balance_mismatch" | "mirror_mismatch";

export interface ReconcileRow {
  workspaceId: string;
  status: ReconcileStatus;
  doLines: number;
  d1Lines: number;
  diff: { plan: number; purchased: number; held: number };
}

interface AuditApi {
  audit(before?: number): Promise<{
    ok: boolean;
    unmirrored: number;
    before?: { cutoff: number; lines: number; totals: { plan: number; purchased: number; held: number } };
  }>;
}

interface AnalyticsLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

export async function reconcileWorkspace(env: Env, workspaceId: string, cutoff: number): Promise<ReconcileRow> {
  const audit = await (creditAccount(env, workspaceId) as unknown as AuditApi).audit(cutoff);
  const rows = await env.DB.prepare("SELECT kind, bucket, amount FROM ledger_lines WHERE workspace_id = ? AND created_at < ?")
    .bind(workspaceId, cutoff)
    .all<{ kind: string; bucket: string; amount: number }>();
  const d1 = reconcile(rows.results as Parameters<typeof reconcile>[0]);
  const doTotals = audit.before?.totals ?? { plan: 0, purchased: 0, held: 0 };
  const diff = { plan: doTotals.plan - d1.plan, purchased: doTotals.purchased - d1.purchased, held: doTotals.held - d1.held };
  const doLines = audit.before?.lines ?? 0;
  // Trial bucket (D-022): checked too, kept out of `diff` (the report shape stays the same).
  const trialDiff = ((audit.before?.totals as { trial?: number } | undefined)?.trial ?? 0) - d1.trial;
  const mirrorOk = doLines === rows.results.length && diff.plan === 0 && diff.purchased === 0 && diff.held === 0 && trialDiff === 0;
  const status: ReconcileStatus = !audit.ok ? "balance_mismatch" : mirrorOk ? "ok" : "mirror_mismatch";
  return { workspaceId, status, doLines, d1Lines: rows.results.length, diff };
}

export async function reconcileLedgers(env: Env, now = Date.now()): Promise<{ checked: number; mismatches: ReconcileRow[] }> {
  const cutoff = now - RECONCILE_LAG_MS;
  const touched = await env.DB.prepare("SELECT DISTINCT workspace_id FROM ledger_lines WHERE created_at >= ? LIMIT ?")
    .bind(now - DAY_MS, MAX_WORKSPACES)
    .all<{ workspace_id: string }>();
  const ae = (env as { AE?: AnalyticsLike }).AE;
  const mismatches: ReconcileRow[] = [];
  for (const { workspace_id } of touched.results) {
    let row: ReconcileRow;
    try {
      row = await reconcileWorkspace(env, workspace_id, cutoff);
    } catch (err) {
      console.error(JSON.stringify({ msg: "ledger reconcile: workspace failed", workspaceId: workspace_id, error: String(err) }));
      continue;
    }
    if (row.status === "ok") continue;
    mismatches.push(row);
    console.error(JSON.stringify({ msg: "ledger reconcile: mismatch", ...row }));
    ae?.writeDataPoint({
      indexes: [workspace_id],
      blobs: ["ledger_reconcile", row.status],
      doubles: [row.diff.plan, row.diff.purchased, row.diff.held, row.doLines - row.d1Lines],
    });
  }
  console.log(JSON.stringify({ msg: "ledger reconcile: done", checked: touched.results.length, mismatches: mismatches.length }));
  return { checked: touched.results.length, mismatches };
}
