/** Cron triggers (wrangler.jsonc `triggers.crons`, repeated in each env). */
import { syncModels } from "./models/sync";
import { reconcileLedgers } from "./ops/reconcile";
import { requeuePendingMedia } from "./queues/mediaProcess";
import { cleanupExpiredUploads } from "./routes/uploads";
import { advanceStalledRuns } from "./runs/service";
import { failStalledJobs } from "./runs/sweep";
import { runR2Cleanup } from "./auth/deleteAccount";
import { resumeAccountDeletions } from "./auth/deletionJob";
import { runRetentionPurge } from "./ops/retention";
import { runStatusProbes } from "./ops/status";
import { scheduleNightlyBackup } from "./ops/backup";

/** Model catalog sync (D-002) and expired upload cleanup (D-011). */
export const MODEL_SYNC_CRON = "0 */6 * * *";
/**
 * Safety net: stalled runs (items waiting on CONCURRENCY_LIMIT > 2 min), running jobs whose Workflow instance
 * is gone or that never reached the gateway (failed and refunded, runs/sweep.ts), and uploads left `processing: pending`.
 */
export const SWEEP_CRON = "*/5 * * * *";
/**
 * Nightly ledger reconcile: CreditAccount vs. the D1 `ledger_lines` mirror for workspaces touched in the last day.
 * Also the retention purge (`@rolling/core/privacy`), restarting unfinished account deletion jobs and the
 * nightly Durable Object backup (D-030).
 */
export const RECONCILE_CRON = "17 3 * * *";

function run(ctx: ExecutionContext, name: string, task: () => Promise<unknown>): void {
  ctx.waitUntil(
    task().catch((err: unknown) => {
      console.error(JSON.stringify({ msg: `${name} failed`, error: String(err) }));
    }),
  );
}

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (controller.cron) {
    case MODEL_SYNC_CRON:
      run(ctx, "models: sync", () => syncModels(env));
      // D-011: abort multipart uploads past their 7-day expiry.
      run(ctx, "uploads: cleanup", () => cleanupExpiredUploads(env));
      return;
    case SWEEP_CRON:
      run(ctx, "runs: stalled sweep", () => advanceStalledRuns(env));
      run(ctx, "runs: stalled jobs", () => failStalledJobs(env));
      run(ctx, "media: requeue pending", () => requeuePendingMedia(env));
      // Account deletion: private media of removed workspaces.
      run(ctx, "r2: cleanup", () => runR2Cleanup(env));
      // Status page probes (D-029): API, gateway (free listing), media, auth.
      run(ctx, "status: probes", () => runStatusProbes(env));
      return;
    case RECONCILE_CRON:
      run(ctx, "ledger: reconcile", () => reconcileLedgers(env));
      run(ctx, "privacy: retention purge", () => runRetentionPurge(env));
      run(ctx, "privacy: resume account deletions", () => resumeAccountDeletions(env));
      // Nightly Durable Object backups to the private R2 prefix (D-030).
      run(ctx, "backup: nightly", () => scheduleNightlyBackup(env));
      return;
    default:
      console.warn(JSON.stringify({ msg: "scheduled: unknown cron", cron: controller.cron }));
  }
}
