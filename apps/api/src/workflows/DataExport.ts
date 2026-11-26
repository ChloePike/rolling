import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  assembleBundle,
  deliverBundle,
  loadDataExport,
  setDataExportStatus,
  writeAccountParts,
  writeAssetPage,
  writeProjectParts,
  writeThreadParts,
  type ExportPlan,
} from "../account/dataExport";

export interface DataExportParams {
  exportId: string;
}

const RETRY = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
/** Projects or threads per step (each is one Durable Object read and one R2 write). */
const PER_STEP = 20;
const MAX_ASSET_PAGES = 200;

/**
 * Settings → Account → Export my data (see `account/dataExport.ts`). One
 * instance per export (instance id = export id): account parts → projects and
 * threads in batches → asset pages → ZIP → signed link by email. A failure
 * marks the export failed, which frees the user to ask again at once.
 */
export class DataExportWorkflow extends WorkflowEntrypoint<Env, DataExportParams> {
  override async run(event: WorkflowEvent<DataExportParams>, step: WorkflowStep) {
    const env = this.env;
    const { exportId } = event.payload;
    const load = async () => {
      const row = await loadDataExport(env, exportId);
      if (!row) throw new Error(`data export ${exportId} missing`);
      return row;
    };
    const first = await step.do("load", RETRY, async () => {
      const row = await loadDataExport(env, exportId);
      return row ? { status: row.status } : null;
    });
    if (!first || first.status === "done" || first.status === "expired") return { status: "skipped" as const };
    try {
      const plan: ExportPlan = await step.do("account", RETRY, async () => {
        await setDataExportStatus(env, exportId, "running");
        return writeAccountParts(env, await load());
      });
      for (let i = 0; i < plan.projects.length; i += PER_STEP) {
        const batch = plan.projects.slice(i, i + PER_STEP);
        await step.do(`projects-${i / PER_STEP + 1}`, RETRY, async () => {
          await writeProjectParts(env, await load(), batch);
          return { n: batch.length };
        });
      }
      for (let i = 0; i < plan.threads.length; i += PER_STEP) {
        const batch = plan.threads.slice(i, i + PER_STEP);
        await step.do(`threads-${i / PER_STEP + 1}`, RETRY, async () => {
          await writeThreadParts(env, await load(), batch);
          return { n: batch.length };
        });
      }
      let after = "";
      for (let page = 1; page <= MAX_ASSET_PAGES; page++) {
        const r = await step.do(`assets-${page}`, RETRY, async () => writeAssetPage(env, await load(), page, after));
        if (!r.next) break;
        after = r.next;
      }
      const bundle = await step.do("zip", RETRY, async () => assembleBundle(env, await load(), plan.truncated, env.APP_NAME || "Rolling"));
      await step.do("deliver", RETRY, async () => {
        await deliverBundle(env, await load(), bundle);
        return { ok: true };
      });
      return { status: "done" as const, size: bundle.size };
    } catch (err) {
      await step.do("fail", RETRY, async () => {
        await setDataExportStatus(env, exportId, "failed", String(err).slice(0, 300));
        return { ok: true };
      });
      return { status: "failed" as const };
    }
  }
}
