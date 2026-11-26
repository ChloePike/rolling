import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { DELETION_BATCH, finishDeletionJob, loadDeletionJob, processDeletionBatch } from "../auth/deletionJob";

export interface AccountDeletionParams {
  deletionId: string;
}

const RETRY = { retries: { limit: 6, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
/** Upper bound on batches per instance (DELETION_BATCH items each); the daily cron restarts a job that needs more. */
const MAX_BATCHES = 900;

/**
 * Account deletion, durable part (see `auth/deletionJob.ts`). One step per
 * batch of Durable Object items, so a large account never runs into request
 * limits; failed steps retry with backoff, and a failed instance is restarted
 * by the daily cron. Idempotent end to end.
 */
export class AccountDeletionWorkflow extends WorkflowEntrypoint<Env, AccountDeletionParams> {
  override async run(event: WorkflowEvent<AccountDeletionParams>, step: WorkflowStep) {
    const env = this.env;
    const { deletionId } = event.payload;
    const job = await step.do("load", RETRY, async () => {
      const j = await loadDeletionJob(env, deletionId);
      return j ? { status: j.status } : null;
    });
    if (!job || job.status === "done") return { status: "skipped" as const };
    let remaining = 1;
    for (let i = 1; i <= MAX_BATCHES && remaining > 0; i++) {
      const r = await step.do(`batch-${i}`, RETRY, async () => {
        const out = await processDeletionBatch(env, deletionId, DELETION_BATCH);
        await env.DB.prepare("UPDATE account_deletions SET updated_at = ? WHERE id = ?").bind(Date.now(), deletionId).run();
        return out;
      });
      remaining = r.remaining;
    }
    if (remaining > 0) return { status: "partial" as const, remaining };
    await step.do("finish", RETRY, async () => {
      await finishDeletionJob(env, deletionId);
      return { ok: true };
    });
    return { status: "done" as const };
  }
}
