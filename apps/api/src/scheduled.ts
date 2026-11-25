/** Cron triggers (wrangler.jsonc `triggers.crons`). */
import { syncModels } from "./models/sync";
import { cleanupExpiredUploads } from "./routes/uploads";

export const MODEL_SYNC_CRON = "0 */6 * * *";

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (controller.cron === MODEL_SYNC_CRON) {
    ctx.waitUntil(
      syncModels(env).catch((err: unknown) => {
        console.error(JSON.stringify({ msg: "models: sync failed", error: String(err) }));
      }),
    );
    // D-011: abort multipart uploads past their 7-day expiry.
    ctx.waitUntil(
      cleanupExpiredUploads(env).catch((err: unknown) => {
        console.error(JSON.stringify({ msg: "uploads: cleanup failed", error: String(err) }));
      }),
    );
    return;
  }
  console.warn(JSON.stringify({ msg: "scheduled: unknown cron", cron: controller.cron }));
}
