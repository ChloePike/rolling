/**
 * Daily retention purge (runs from the `17 3 * * *` reconcile cron). Periods
 * live in `@rolling/core/privacy` and are quoted by the privacy policy:
 * - safety log rows older than `SAFETY_LOG_RETENTION_DAYS` are deleted, and
 *   their excerpts are cleared after `SAFETY_EXCERPT_RETENTION_DAYS`;
 * - agent usage rows older than `AGENT_USAGE_RETENTION_DAYS` are deleted;
 * - data export bundles past their link lifetime are removed from R2.
 * Deletes go in bounded chunks so one run stays within D1 limits; whatever is
 * left is picked up the next day.
 */
import { retentionCutoffs } from "@rolling/core/privacy";
import { expireDataExports } from "../account/dataExport";

const CHUNK = 5000;
const MAX_CHUNKS = 40;

async function chunked(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const r = await env.DB.prepare(sql).bind(...binds, CHUNK).run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < CHUNK) break;
  }
  return total;
}

export interface RetentionResult {
  safetyEventsDeleted: number;
  safetyExcerptsCleared: number;
  agentUsageDeleted: number;
  dataExportsExpired: number;
}

export async function runRetentionPurge(env: Env, now = Date.now()): Promise<RetentionResult> {
  const cut = retentionCutoffs(now);
  const safetyEventsDeleted = await chunked(env, "DELETE FROM safety_events WHERE rowid IN (SELECT rowid FROM safety_events WHERE created_at < ? LIMIT ?)", cut.safetyEvents);
  const safetyExcerptsCleared = await chunked(
    env,
    "UPDATE safety_events SET excerpt = NULL WHERE rowid IN (SELECT rowid FROM safety_events WHERE excerpt IS NOT NULL AND created_at < ? LIMIT ?)",
    cut.safetyExcerpts,
  );
  const agentUsageDeleted = await chunked(env, "DELETE FROM agent_usage WHERE rowid IN (SELECT rowid FROM agent_usage WHERE created_at < ? LIMIT ?)", cut.agentUsage);
  const dataExportsExpired = await expireDataExports(env, cut.dataExports);
  const result = { safetyEventsDeleted, safetyExcerptsCleared, agentUsageDeleted, dataExportsExpired };
  console.log(JSON.stringify({ msg: "retention purge", ...result }));
  return result;
}
