import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type BillingWorkflowParams = Record<string, unknown>;

/** Period grants, expiries and auto top-up (M2). M0 stub: one no-op step. */
export class BillingWorkflow extends WorkflowEntrypoint<Env, BillingWorkflowParams> {
  override async run(event: WorkflowEvent<BillingWorkflowParams>, step: WorkflowStep) {
    return step.do("noop", async () => ({ ok: true, instanceId: event.instanceId }));
  }
}
