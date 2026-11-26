/**
 * Cron safety net for jobs that will never finish on their own (SWEEP_CRON).
 *
 * `advanceStalledRuns` only re-advances *pending* items. A *running* item whose
 * GenerateWorkflow is gone (the instance was never created, errored after its
 * step retries, was terminated, or returned early on a missing row) kept its
 * hold and sat "running" forever. This sweep fails and refunds those jobs:
 *
 * - the Workflow instance is missing, `errored` or `terminated` (or `complete`
 *   while the job row is still open) and the job is older than the grace period;
 * - the job never got a gateway id (`external_id`) within NO_EXTERNAL_ID_MS,
 *   whatever the instance says (prepare/submit retries are long done by then).
 *
 * The instance is terminated first (best effort) so it cannot settle afterwards;
 * `failJob` releases the hold idempotently (`release:<jobId>`) and dependents are
 * skipped by `advanceAfter`.
 */
import type { JobError } from "@rolling/core";
import { advanceAfter, failJob, loadJobContext } from "./jobs";

/** A job younger than this is never touched (the instance may still be starting). */
export const STALLED_JOB_GRACE_MS = 2 * 60 * 1000;
/** A job without a gateway id after this long is failed. */
export const NO_EXTERNAL_ID_MS = 10 * 60 * 1000;

const DEAD_INSTANCE = new Set(["errored", "terminated", "complete", "unknown"]);

export const STALLED_JOB_ERROR: JobError = {
  code: "stalled",
  message: "The job stopped before the provider started it. No credits were charged.",
  retryable: true,
  refundable: true,
};

interface OpenJob {
  id: string;
  run_id: string;
  item_ref: string;
  workspace_id: string;
  workflow_id: string | null;
  external_id: string | null;
  created_at: number;
}

/** The instance status, or "missing" when the Workflow has no such instance. */
async function instanceStatus(env: Env, id: string): Promise<string> {
  let instance: WorkflowInstance;
  try {
    instance = await env.GENERATE.get(id);
  } catch {
    return "missing";
  }
  try {
    return (await instance.status()).status;
  } catch {
    return "unknown";
  }
}

export async function failStalledJobs(env: Env, now = Date.now()): Promise<{ checked: number; failed: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT j.id, j.run_id, i.ref AS item_ref, r.workspace_id, j.workflow_id, j.external_id, j.created_at
       FROM jobs j
       JOIN run_items i ON i.run_id = j.run_id AND i.job_id = j.id
       JOIN runs r ON r.id = j.run_id
      WHERE j.status IN ('queued','submitted','running') AND i.status = 'running'
        AND r.status IN ('queued','running') AND j.created_at < ?
      ORDER BY j.created_at LIMIT 100`,
  )
    .bind(now - STALLED_JOB_GRACE_MS)
    .all<OpenJob>();
  const failed: string[] = [];
  for (const job of rows.results) {
    try {
      const instanceId = job.workflow_id ?? job.id;
      const status = await instanceStatus(env, instanceId);
      const noGatewayJob = !job.external_id && job.created_at < now - NO_EXTERNAL_ID_MS;
      if (!noGatewayJob && status !== "missing" && !DEAD_INSTANCE.has(status)) continue;
      if (status !== "missing" && status !== "terminated" && status !== "errored" && status !== "complete") {
        try {
          await (await env.GENERATE.get(instanceId)).terminate();
        } catch {
          // Finished in the meantime or already gone.
        }
      }
      const ctx = await loadJobContext(env, { jobId: job.id, runId: job.run_id, ref: job.item_ref, workspaceId: job.workspace_id });
      if (!ctx) continue;
      await failJob(env, ctx, STALLED_JOB_ERROR);
      await advanceAfter(env, ctx);
      failed.push(job.id);
      console.warn(JSON.stringify({ msg: "runs: stalled job failed and refunded", jobId: job.id, runId: job.run_id, instance: status, externalId: job.external_id }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "runs: stalled job sweep failed", jobId: job.id, error: String(err) }));
    }
  }
  return { checked: rows.results.length, failed };
}
