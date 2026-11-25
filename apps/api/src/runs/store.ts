/** D1 rows of the generation pipeline (migrations 0001 + 0007). */
import type { GenSpec, PlanItem } from "@rolling/core/generation";

export interface QuoteRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  items: string;
  total: number;
  expires_at: number;
  created_by: string | null;
  scope: string | null;
  created_at: number | null;
}

export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "canceled";

export interface RunRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  quote_id: string;
  scope: string;
  status: RunStatus;
  created_by: string;
  created_at: number;
  title: string | null;
  source: string;
  credits_quoted: number;
  credits_spent: number;
  credits_refunded: number;
  options: string;
  updated_at: number | null;
  finished_at: number | null;
}

export type ItemStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";

export interface RunItemRow {
  run_id: string;
  ref: string;
  node_id: string | null;
  title: string | null;
  kind: string;
  model: string;
  spec: string;
  price_request: string;
  params_hash: string | null;
  depends_on: string;
  credits: number;
  status: ItemStatus;
  job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  ord: number;
  updated_at: number;
}

export type JobStatusValue = "queued" | "submitted" | "running" | "succeeded" | "failed" | "canceled" | "unknown";

export interface JobRow {
  id: string;
  run_id: string;
  project_id: string | null;
  node_id: string | null;
  title: string | null;
  provider: string;
  model: string;
  params_summary: string | null;
  external_id: string | null;
  workflow_id: string | null;
  status: JobStatusValue;
  progress: number | null;
  cost_quote: number;
  cost_actual: number | null;
  refunded: number;
  idempotency_key: string;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
  workspace_id: string | null;
  item_ref: string | null;
  created_by: string | null;
  attempt: number;
  asset_id: string | null;
  error_message: string | null;
  updated_at: number | null;
}

/** Quote item as stored in `quotes.items` and returned by the quote route. */
export interface StoredQuoteItem extends PlanItem {
  credits: number;
}

/** Staging-only options (ignored in production). */
export interface RunOptions {
  /** Fail these item refs (or every item) without calling the provider, to test refunds. */
  forceFailure?: true | string[];
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function itemSpec(item: Pick<RunItemRow, "spec">): GenSpec {
  return JSON.parse(item.spec) as GenSpec;
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
}

export async function getItems(db: D1Database, runId: string): Promise<RunItemRow[]> {
  return (await db.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY ord").bind(runId).all<RunItemRow>()).results;
}

export async function getItem(db: D1Database, runId: string, ref: string): Promise<RunItemRow | null> {
  return db.prepare("SELECT * FROM run_items WHERE run_id = ? AND ref = ?").bind(runId, ref).first<RunItemRow>();
}

export async function getJob(db: D1Database, jobId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
}

/** One-line settings summary for Activity, e.g. `720p · 5s`. */
export function paramsSummary(spec: GenSpec): string {
  return [spec.resolution, spec.ratio, spec.kind === "video" && spec.seconds ? `${spec.seconds}s` : null, spec.n && spec.n > 1 ? `×${spec.n}` : null]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" · ");
}

/** Recomputes a run's totals and, when every item is final, its status. */
export async function refreshRun(db: D1Database, runId: string, now = Date.now()): Promise<RunRow | null> {
  const run = await getRun(db, runId);
  if (!run) return null;
  const items = await getItems(db, runId);
  const totals = await db
    .prepare(
      "SELECT COALESCE(SUM(cost_actual), 0) AS spent, COALESCE(SUM(CASE WHEN refunded > 0 THEN cost_quote ELSE 0 END), 0) AS refunded FROM jobs WHERE run_id = ?",
    )
    .bind(runId)
    .first<{ spent: number; refunded: number }>();
  const final = items.every((i) => i.status !== "pending" && i.status !== "running");
  let status: RunStatus = run.status;
  if (run.status !== "canceled") {
    if (!final) status = items.some((i) => i.status !== "pending") ? "running" : "queued";
    else {
      const ok = items.filter((i) => i.status === "succeeded").length;
      status = ok === items.length ? "succeeded" : ok > 0 ? "partial" : "failed";
    }
  }
  await db
    .prepare("UPDATE runs SET status = ?, credits_spent = ?, credits_refunded = ?, updated_at = ?, finished_at = ? WHERE id = ?")
    .bind(status, totals?.spent ?? 0, totals?.refunded ?? 0, now, final ? (run.finished_at ?? now) : null, runId)
    .run();
  return { ...run, status, credits_spent: totals?.spent ?? 0, credits_refunded: totals?.refunded ?? 0, updated_at: now };
}
