/**
 * Nightly Durable Object backups (D-030). The 03:17 UTC cron starts one
 * `BackupWorkflow` per day; it dumps every CreditAccount (ledger, holds,
 * balance, idempotency) and every ProjectRoom (graph, timeline, revisions)
 * into the private R2 prefix `backups/<YYYY-MM-DD>/{credits,projects}/<id>.json`,
 * writes a manifest, and deletes days older than 30 (the bucket's lifecycle
 * rule on `backups/` is the backstop, docs/deploy.md). D1 is covered by Time Travel.
 *
 * Restore (`POST /api/admin/backups/restore`, admin only, audited) replaces
 * one object's state from a chosen day.
 */
import type { DoDump } from "@rolling/db/do/backup";
import { creditAccount } from "../billing/credits";
import { BACKUP_PREFIX } from "./restricted";

export const BACKUP_RETENTION_DAYS = 30;
export const BACKUP_BATCH = 25;
const DAY = 86_400_000;

export type BackupKind = "credits" | "projects";

interface BackupStub {
  exportBackup(): Promise<DoDump | null>;
  restoreBackup(dump: DoDump): Promise<{ ok: true; rows: number } | { ok: false; error: string }>;
}

function stubFor(env: Env, kind: BackupKind, id: string): BackupStub {
  if (kind === "credits") return creditAccount(env, id) as unknown as BackupStub;
  return env.PROJECT.get(env.PROJECT.idFromName(id)) as unknown as BackupStub;
}

export function backupKey(date: string, kind: BackupKind, id: string): string {
  return `${BACKUP_PREFIX}${date}/${kind}/${id}.json`;
}

export function backupDate(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Ids to back up after `after` (workspaces for ledgers, projects for rooms), in id order. */
async function idsAfter(env: Env, kind: BackupKind, after: string, limit: number): Promise<string[]> {
  const sql = kind === "credits" ? "SELECT id FROM workspaces WHERE id > ? ORDER BY id LIMIT ?" : "SELECT id FROM projects WHERE id > ? ORDER BY id LIMIT ?";
  return (await env.DB.prepare(sql).bind(after, limit).all<{ id: string }>()).results.map((r) => r.id);
}

/** Dumps one batch. Returns the cursor for the next batch (null when done). */
export async function backupBatch(env: Env, date: string, kind: BackupKind, after: string, limit = BACKUP_BATCH): Promise<{ next: string | null; objects: number; bytes: number }> {
  const ids = await idsAfter(env, kind, after, limit);
  let objects = 0;
  let bytes = 0;
  for (const id of ids) {
    const dump = await stubFor(env, kind, id).exportBackup();
    if (!dump) continue;
    const body = JSON.stringify(dump);
    await env.MEDIA.put(backupKey(date, kind, id), body, { httpMetadata: { contentType: "application/json" }, customMetadata: { kind, id, schemaVersion: String(dump.schemaVersion) } });
    objects++;
    bytes += body.length;
  }
  return { next: ids.length === limit ? ids[ids.length - 1]! : null, objects, bytes };
}

/** Deletes backup days older than the retention period. Returns objects deleted. */
export async function pruneBackups(env: Env, now = Date.now()): Promise<number> {
  const cutoff = backupDate(now - BACKUP_RETENTION_DAYS * DAY);
  let deleted = 0;
  const days = await env.MEDIA.list({ prefix: BACKUP_PREFIX, delimiter: "/" });
  for (const prefix of days.delimitedPrefixes) {
    const day = prefix.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix, ...(cursor && { cursor }) });
      if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return deleted;
}

export async function startBackupRun(env: Env, date: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO backup_runs (id, status, started_at) VALUES (?, 'running', ?)").bind(date, Date.now()).run();
}

export async function finishBackupRun(env: Env, date: string, r: { creditAccounts: number; projectRooms: number; bytes: number; pruned: number; error?: string | null }): Promise<void> {
  await env.MEDIA.put(`${BACKUP_PREFIX}${date}/manifest.json`, JSON.stringify({ date, ...r, finishedAt: Date.now() }), { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare("UPDATE backup_runs SET status = ?, credit_accounts = ?, project_rooms = ?, bytes = ?, pruned = ?, error = ?, finished_at = ? WHERE id = ?")
    .bind(r.error ? "failed" : "done", r.creditAccounts, r.projectRooms, r.bytes, r.pruned, r.error ?? null, Date.now(), date)
    .run();
}

/** Cron: one workflow instance per day (the id makes a second start a no-op). */
export async function scheduleNightlyBackup(env: Env, now = Date.now()): Promise<void> {
  const date = backupDate(now);
  try {
    await env.BACKUP.create({ id: `backup-${date}`, params: { date } });
  } catch (e) {
    if (!/already exists|duplicate/i.test(String(e))) throw e;
  }
}

/** Restores one object from a day's backup. */
export async function restoreFromBackup(env: Env, kind: BackupKind, id: string, date: string): Promise<{ ok: true; rows: number } | { ok: false; error: string }> {
  const obj = await env.MEDIA.get(backupKey(date, kind, id));
  if (!obj) return { ok: false, error: "No backup for that object and day." };
  const dump = (await obj.json()) as DoDump;
  return stubFor(env, kind, id).restoreBackup(dump);
}

/** Days with a backup of an object, newest first. */
export async function backupDaysOf(env: Env, kind: BackupKind, id: string, limit = BACKUP_RETENTION_DAYS + 2): Promise<string[]> {
  const days = await env.MEDIA.list({ prefix: BACKUP_PREFIX, delimiter: "/" });
  const out: string[] = [];
  for (const p of days.delimitedPrefixes.sort().reverse()) {
    const day = p.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    if (await env.MEDIA.head(backupKey(day, kind, id))) out.push(day);
    if (out.length >= limit) break;
  }
  return out;
}
