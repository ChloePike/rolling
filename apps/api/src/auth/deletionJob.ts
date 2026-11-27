/**
 * Durable part of account deletion. `purgeAccount` (request time) records a
 * job in `account_deletions` with one `account_deletion_items` row per Durable
 * Object to wipe or pseudonymise, then starts `AccountDeletionWorkflow`, which
 * works through the items in small batches (one workflow step each, retried
 * with backoff). Every item operation is idempotent, and items are marked done
 * one by one, so a retried step, a restarted workflow or a second deletion
 * request never redoes or skips work. The daily cron restarts jobs that have
 * not finished (`resumeAccountDeletions`); together they meet
 * `ACCOUNT_DELETION_DEADLINE_DAYS`.
 *
 * Items:
 * - `project_room`: ProjectRoom of a project in a workspace that is closed → `purge()` (deleteAll + alarm cleared);
 * - `project_pseudonymize`: ProjectRoom of a project in a workspace the user leaves → `pseudonymizeUser()`;
 * - `agent_session`: AgentSession of every thread in a closed workspace and every thread the user started → `purge()`;
 * - `credit_account`: CreditAccount of every workspace the user spent in → `pseudonymizeUser()` (ledger kept);
 * - `user_hub`: the user's UserHub → `purge()`.
 */
import { ACCOUNT_DELETION_RESTART_AFTER_MS, tombstoneUserId } from "@rolling/core/privacy";

export type DeletionItemKind = "project_room" | "project_pseudonymize" | "agent_session" | "credit_account" | "user_hub";

export interface DeletionJob {
  id: string;
  user_id: string;
  tombstone: string;
  status: "pending" | "done";
  attempts: number;
}

/** Items per workflow step: well under the per-invocation subrequest limit. */
export const DELETION_BATCH = 25;
/** D1 bound-parameter budget per statement (100 max): 3 per item row. */
const INSERT_CHUNK = 30;

export function deletionIdFor(tombstone: string): string {
  return `del_${tombstone.slice(-32)}`;
}

async function ids(env: Env, query: string, ...binds: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(query).bind(...binds).all<{ id: string }>();
  return results.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/**
 * Records the job and its items (before the D1 rows they are read from go).
 * Idempotent: the job id derives from the user id, items are keyed.
 */
export async function createDeletionJob(env: Env, userId: string, plan: { remove: string[]; leave: string[] }, now = Date.now()): Promise<DeletionJob> {
  const tombstone = await tombstoneUserId(userId);
  const id = deletionIdFor(tombstone);
  await env.DB.prepare(
    `INSERT INTO account_deletions (id, user_id, tombstone, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = 'pending', user_id = excluded.user_id, updated_at = excluded.updated_at`,
  )
    .bind(id, userId, tombstone, now, now)
    .run();

  const items: Array<[DeletionItemKind, string]> = [["user_hub", ""]];
  const removed = plan.remove;
  const left = plan.leave;
  if (removed.length) {
    for (const p of await ids(env, `SELECT id FROM projects WHERE workspace_id IN (${placeholders(removed.length)})`, ...removed)) items.push(["project_room", p]);
    for (const t of await ids(env, `SELECT id FROM agent_threads WHERE workspace_id IN (${placeholders(removed.length)})`, ...removed)) items.push(["agent_session", t]);
  }
  if (left.length) {
    for (const p of await ids(env, `SELECT id FROM projects WHERE workspace_id IN (${placeholders(left.length)})`, ...left)) items.push(["project_pseudonymize", p]);
  }
  for (const t of await ids(env, "SELECT id FROM agent_threads WHERE created_by = ?", userId)) items.push(["agent_session", t]);
  const spent = new Set<string>([...removed, ...left]);
  for (const w of await ids(env, "SELECT DISTINCT workspace_id AS id FROM ledger_lines WHERE user_id = ?", userId)) spent.add(w);
  for (const w of await ids(env, "SELECT DISTINCT workspace_id AS id FROM agent_usage WHERE user_id = ?", userId)) spent.add(w);
  for (const w of spent) items.push(["credit_account", w]);

  for (let i = 0; i < items.length; i += INSERT_CHUNK) {
    const chunk = items.slice(i, i + INSERT_CHUNK);
    await env.DB.prepare(`INSERT OR IGNORE INTO account_deletion_items (deletion_id, kind, ref) VALUES ${chunk.map(() => "(?, ?, ?)").join(",")}`)
      .bind(...chunk.flatMap(([kind, ref]) => [id, kind, ref]))
      .run();
  }
  return (await loadDeletionJob(env, id))!;
}

export async function loadDeletionJob(env: Env, id: string): Promise<DeletionJob | null> {
  return env.DB.prepare("SELECT id, user_id, tombstone, status, attempts FROM account_deletions WHERE id = ?").bind(id).first<DeletionJob>();
}

/**
 * Retained D1 records keep their rows but carry the tombstone instead of the
 * user id: credit ledger mirror, safety log, agent usage, and authorship of
 * runs, jobs, quotes, exports and projects that stay with other workspaces,
 * and trial claims (D-022).
 * Run again at the end of the job for ledger lines mirrored late. Idempotent.
 */
export async function pseudonymizeD1(env: Env, userId: string, tombstone: string): Promise<void> {
  const db = env.DB;
  const set = (table: string, col: string) => db.prepare(`UPDATE ${table} SET ${col} = ?1 WHERE ${col} = ?2`).bind(tombstone, userId);
  await db.batch([
    set("ledger_lines", "user_id"),
    set("safety_events", "user_id"),
    set("agent_usage", "user_id"),
    set("runs", "created_by"),
    set("jobs", "created_by"),
    set("quotes", "created_by"),
    set("exports", "created_by"),
    set("projects", "created_by"),
    // D-022: the trial claim stays (hashes only), so deleting and signing up again gets no second trial.
    set("trial_claims", "user_id"),
  ]);
}

interface ItemRow {
  kind: DeletionItemKind;
  ref: string;
}

interface Purgeable {
  purge(): Promise<{ ok: true }>;
}
interface Pseudonymizable {
  pseudonymizeUser(userId: string, tombstone: string): Promise<{ ok: true; changed: number }>;
}

async function runItem(env: Env, job: DeletionJob, item: ItemRow): Promise<void> {
  switch (item.kind) {
    case "project_room":
      await (env.PROJECT.get(env.PROJECT.idFromName(item.ref)) as unknown as Purgeable).purge();
      return;
    case "project_pseudonymize":
      await (env.PROJECT.get(env.PROJECT.idFromName(item.ref)) as unknown as Pseudonymizable).pseudonymizeUser(job.user_id, job.tombstone);
      return;
    case "agent_session":
      await (env.AGENT.get(env.AGENT.idFromName(item.ref)) as unknown as Purgeable).purge();
      return;
    case "credit_account":
      await (env.CREDITS.get(env.CREDITS.idFromName(item.ref)) as unknown as Pseudonymizable).pseudonymizeUser(job.user_id, job.tombstone);
      return;
    case "user_hub":
      await (env.USER_HUB.get(env.USER_HUB.idFromName(job.user_id)) as unknown as Purgeable).purge();
      return;
  }
}

/** Runs up to `limit` pending items; returns how many are still pending afterwards. Throws on the first failure (the step retries). */
export async function processDeletionBatch(env: Env, deletionId: string, limit = DELETION_BATCH): Promise<{ processed: number; remaining: number }> {
  const job = await loadDeletionJob(env, deletionId);
  if (!job || job.status === "done") return { processed: 0, remaining: 0 };
  const { results } = await env.DB.prepare("SELECT kind, ref FROM account_deletion_items WHERE deletion_id = ? AND done_at IS NULL ORDER BY kind, ref LIMIT ?")
    .bind(deletionId, limit)
    .all<ItemRow>();
  let processed = 0;
  for (const item of results) {
    await runItem(env, job, item);
    await env.DB.prepare("UPDATE account_deletion_items SET done_at = ? WHERE deletion_id = ? AND kind = ? AND ref = ?").bind(Date.now(), deletionId, item.kind, item.ref).run();
    processed++;
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_deletion_items WHERE deletion_id = ? AND done_at IS NULL").bind(deletionId).first<{ n: number }>();
  return { processed, remaining: Number(left?.n ?? 0) };
}

/** Last step: pseudonymise late ledger mirror lines, then forget the raw user id. */
export async function finishDeletionJob(env: Env, deletionId: string, now = Date.now()): Promise<void> {
  const job = await loadDeletionJob(env, deletionId);
  if (!job || job.status === "done") return;
  await pseudonymizeD1(env, job.user_id, job.tombstone);
  await env.DB.prepare("UPDATE account_deletions SET status = 'done', user_id = tombstone, done_at = ?, updated_at = ?, last_error = NULL WHERE id = ?").bind(now, now, deletionId).run();
  console.log(JSON.stringify({ msg: "account deletion: storage wiped", deletionId }));
}

/** Runs the whole job inline (tests, ops). The workflow does the same, one step per batch. */
export async function runDeletionJob(env: Env, deletionId: string): Promise<void> {
  for (;;) {
    const { remaining, processed } = await processDeletionBatch(env, deletionId);
    if (remaining === 0) break;
    if (processed === 0) throw new Error("account deletion: no progress");
  }
  await finishDeletionJob(env, deletionId);
}

/** Starts the workflow for a job; instance ids are `<job>` then `<job>-r<attempt>`. Never throws (the cron retries). */
export async function startDeletionWorkflow(env: Env, job: Pick<DeletionJob, "id" | "attempts">, now = Date.now()): Promise<boolean> {
  const instanceId = job.attempts === 0 ? job.id : `${job.id}-r${job.attempts}`;
  try {
    await env.ACCOUNT_DELETION.create({ id: instanceId, params: { deletionId: job.id } });
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: "account deletion: workflow start failed", deletionId: job.id, error: String(err).slice(0, 300) }));
    await env.DB.prepare("UPDATE account_deletions SET last_error = ?, updated_at = ? WHERE id = ?").bind(String(err).slice(0, 300), now, job.id).run();
    return false;
  } finally {
    await env.DB.prepare("UPDATE account_deletions SET attempts = attempts + 1, updated_at = ? WHERE id = ?").bind(now, job.id).run();
  }
}

/** Daily cron: restarts pending jobs untouched for `ACCOUNT_DELETION_RESTART_AFTER_MS`. */
export async function resumeAccountDeletions(env: Env, now = Date.now(), limit = 50): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, attempts FROM account_deletions WHERE status = 'pending' AND updated_at <= ? ORDER BY updated_at LIMIT ?")
    .bind(now - ACCOUNT_DELETION_RESTART_AFTER_MS, limit)
    .all<{ id: string; attempts: number }>();
  let started = 0;
  for (const job of results) if (await startDeletionWorkflow(env, job, now)) started++;
  return started;
}
