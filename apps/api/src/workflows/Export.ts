import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type ExportWorkflowParams = Record<string, unknown>;

/** Timeline EDL to FfmpegRenderer, output to R2, notify (M7). M0 stub: one no-op step. */
export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  override async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    return step.do("noop", async () => ({ ok: true, instanceId: event.instanceId }));
  }
}
