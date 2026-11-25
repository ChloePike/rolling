import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type GenerateWorkflowParams = Record<string, unknown>;

/** One instance per provider job: submit, wait (webhook or poll), store, commit, settle or release (M4). M0 stub: one no-op step. */
export class GenerateWorkflow extends WorkflowEntrypoint<Env, GenerateWorkflowParams> {
  override async run(event: WorkflowEvent<GenerateWorkflowParams>, step: WorkflowStep) {
    return step.do("noop", async () => ({ ok: true, instanceId: event.instanceId }));
  }
}
