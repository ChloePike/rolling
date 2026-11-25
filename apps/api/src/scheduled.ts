/** Cron triggers (wrangler.jsonc `triggers.crons`, repeated in each env). */
import { syncModels } from "./models/sync";
import { requeuePendingMedia } from "./queues/mediaProcess";
import { cleanupExpiredUploads } from "./routes/uploads";
import { advanceStalledRuns } from "./runs/service";

/** Model catalog sync (D-002) and expired upload cleanup (D-011). */
export const MODEL_SYNC_CRON = "0 */6 * * *";
/** Safety net: stalled runs (items waiting on CONCURRENCY_LIMIT > 2 min) and uploads left `processing: pending`. */
export const SWEEP_CRON = "*/5 * * * *";

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
      run(ctx, "media: requeue pending", () => requeuePendingMedia(env));
      return;
    default:
      console.warn(JSON.stringify({ msg: "scheduled: unknown cron", cron: controller.cron }));
  }
}
