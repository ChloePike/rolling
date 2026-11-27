import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { backupBatch, finishBackupRun, pruneBackups, startBackupRun, type BackupKind } from "../ops/backup";

export interface BackupParams {
  /** UTC day (`YYYY-MM-DD`), also the instance id suffix. */
  date: string;
}

const RETRY = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
/** Safety stop: 25 objects per step × 4000 steps = 100k objects per kind. */
const MAX_STEPS = 4000;

/**
 * Nightly DO backup (D-030, `ops/backup.ts`): CreditAccount ledgers, then
 * ProjectRoom graphs, in batches (each batch is a durable step, so a restart
 * resumes where it stopped), then the 30-day prune and the manifest.
 */
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  override async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
    const env = this.env;
    const { date } = event.payload;
    await step.do("start", RETRY, async () => startBackupRun(env, date));
    const totals = { credits: 0, projects: 0, bytes: 0 };
    try {
      for (const kind of ["credits", "projects"] as BackupKind[]) {
        let cursor = "";
        for (let i = 0; i < MAX_STEPS; i++) {
          const r = await step.do(`${kind}-${i}`, RETRY, async () => backupBatch(env, date, kind, cursor));
          totals[kind] += r.objects;
          totals.bytes += r.bytes;
          if (!r.next) break;
          cursor = r.next;
        }
      }
      const pruned = await step.do("prune", RETRY, async () => pruneBackups(env));
      await step.do("finish", RETRY, async () => finishBackupRun(env, date, { creditAccounts: totals.credits, projectRooms: totals.projects, bytes: totals.bytes, pruned }));
      return { status: "done" as const, ...totals, pruned };
    } catch (err) {
      await step.do("failed", RETRY, async () => finishBackupRun(env, date, { creditAccounts: totals.credits, projectRooms: totals.projects, bytes: totals.bytes, pruned: 0, error: String(err).slice(0, 500) }));
      throw err;
    }
  }
}
