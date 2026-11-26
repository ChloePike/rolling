import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { GenerateRequest, JobError, JobStatus } from "@rolling/core";
import {
  JobFailure,
  advanceAfter,
  commitJob,
  failJob,
  loadJobContext,
  nextFallback,
  pollJob,
  prepareJob,
  reportProgress,
  storeOutputs,
  submitJob,
  type GenerateParams,
  type JobContext,
} from "../runs/jobs";

export type GenerateWorkflowParams = GenerateParams;

/** Event sent by `POST /api/hooks/hyperouter` to the job's instance (id = job id). */
export interface ProviderDoneEvent {
  externalId: string;
  status: JobStatus | null;
}

export const PROVIDER_DONE = "provider-done";

/** Wait schedule: the first waits are short (images finish in seconds), then back off to a minute. */
const FIRST_WAIT_S = { image: 3, video: 10 } as const;
const MAX_WAIT_S = 60;
/** Give up after this many waits (≈ 1 h for images, ≈ 3 h for video). */
const MAX_WAITS = { image: 70, video: 190 } as const;

const RETRY = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

/** Wraps a step body so job failures end the job instead of being retried. */
function guard<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof JobFailure) throw new NonRetryableError(JSON.stringify(err.error), "JobFailure");
      throw err;
    }
  };
}

/** The JobError carried by a failed step, or a generic retryable one. */
function jobErrorOf(err: unknown): JobError {
  const message = err instanceof Error ? err.message : String(err);
  const start = message.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(message.slice(start)) as Partial<JobError>;
      if (typeof parsed.code === "string" && typeof parsed.message === "string") {
        return { code: parsed.code, message: parsed.message, retryable: parsed.retryable === true, refundable: true };
      }
    } catch {
      // Not ours.
    }
  }
  return { code: "internal", message: "The job failed. No credits were charged.", retryable: true, refundable: true };
}

const FORCED: JobError = { code: "forced_failure", message: "Forced failure for testing. No credits were charged.", retryable: false, refundable: true };

/**
 * One instance per job (instance id = job id = CreditAccount hold = provider
 * idempotency key). Steps: load → prepare (signed input URLs) → submit → wait
 * (`provider-done` event from the webhook, else poll with backoff) → store (R2,
 * thumbnails) → commit (addVersion + settle). Any failure releases the hold and
 * marks the node failed with the refund. Transient provider failures (retryable
 * codes such as upstream_error) are resubmitted to the same model up to
 * SAME_MODEL_RETRIES times with backoff (each attempt has its own idempotency
 * key); after that the job tries one fallback model under the same hold: Auto's
 * next candidate (D-009), or a same-family sibling of an explicitly chosen model
 * (never costing more than the hold). Failures after the provider succeeded (storing) are not
 * resubmitted. Dependents start afterwards.
 */
/** Resubmissions of the same model after a transient provider failure, and their backoff. */
const SAME_MODEL_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_SECONDS = [5, 20, 60];

function retryBackoff(env: Env): number[] {
  const parsed = (env.GENERATE_RETRY_BACKOFF ?? "").split(",").map((v) => Number(v.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : DEFAULT_RETRY_BACKOFF_SECONDS;
}

export class GenerateWorkflow extends WorkflowEntrypoint<Env, GenerateWorkflowParams> {
  override async run(event: WorkflowEvent<GenerateWorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const ctx = await step.do("load", RETRY, async () => loadJobContext(env, event.payload));
    if (!ctx) return { status: "missing" as const };
    if (ctx.canceled) return { status: "canceled" as const };

    const tried: string[] = [];
    let modelId = ctx.modelId;
    let sameModelRetries = 0;
    let fellBack = false;
    for (let attempt = 1; ; attempt++) {
      if (!tried.includes(modelId)) tried.push(modelId);
      let status: JobStatus;
      // True when the provider itself reported the failure (safe to resubmit).
      let providerFailure = true;
      let digest = "";
      let request: GenerateRequest | null = null;
      let forced = false;
      try {
        // The request crosses the step boundary as JSON (it has free-form `extra`).
        const prepared = await step.do(`prepare-${attempt}`, RETRY, guard(async () => {
          const p = await prepareJob(env, ctx, modelId);
          return { request: JSON.stringify(p.request), digest: p.digest, ...(p.replanned && { replanned: JSON.stringify(p.replanned) }) };
        }));
        if (prepared.replanned) {
          // D-005: re-planned as a mature run in prepare (explicit content of a mature-allowed caller): later steps,
          // retries and fallbacks use the mature spec and its model. Deterministic on replay (the step result is stored).
          const r = JSON.parse(prepared.replanned) as { spec: JobContext["spec"]; modelId: string };
          ctx.spec = r.spec;
          modelId = r.modelId;
          if (!tried.includes(modelId)) tried.push(modelId);
        }
        digest = prepared.digest;
        const req = JSON.parse(prepared.request) as GenerateRequest;
        request = req;
        const sub = await step.do(`submit-${attempt}`, RETRY, guard(() => submitJob(env, ctx, modelId, req, attempt)));
        forced = sub.forced;
        status = forced ? failedStatus(sub.externalId, FORCED) : await this.waitForJob(step, ctx, modelId, sub.externalId, attempt);
      } catch (err) {
        status = failedStatus("", jobErrorOf(err));
      }

      if (status.state === "succeeded" && request) {
        const prepared = { request, digest };
        const done = status;
        const usedModel = modelId;
        try {
          const stored = await step.do(`store-${attempt}`, RETRY, guard(() => storeOutputs(env, ctx, done, usedModel)));
          const committed = await step.do("commit", RETRY, async () => commitJob(env, ctx, stored, prepared, done, usedModel));
          await step.do("advance-after-commit", RETRY, async () => advanceAfter(env, ctx));
          return { status: "succeeded" as const, model: usedModel, attempt, ...committed };
        } catch (err) {
          status = failedStatus(status.externalId, jobErrorOf(err));
          providerFailure = false;
        }
      }

      const error = status.error ?? { code: "unknown_error", message: "The job failed.", retryable: false, refundable: true };
      if (!forced && error.retryable && providerFailure && sameModelRetries < SAME_MODEL_RETRIES) {
        const wait = retryBackoff(env)[sameModelRetries] ?? 60;
        if (wait > 0) await step.sleep(`backoff-${attempt}`, `${wait} seconds` as const);
        sameModelRetries++;
        continue;
      }
      if (!forced && error.retryable && providerFailure && !fellBack && ctx.spec.fallbacks.length > 0) {
        const next = await step.do("fallback", RETRY, async () => nextFallback(env, ctx, tried));
        if (next) {
          fellBack = true;
          sameModelRetries = 0;
          modelId = next;
          continue;
        }
      }
      const failed = await step.do("fail", RETRY, async () => failJob(env, ctx, error));
      await step.do("advance-after-failure", RETRY, async () => advanceAfter(env, ctx));
      return { status: "failed" as const, code: error.code, refunded: failed.refunded, attempt };
    }
  }

  /**
   * Waits for the job: each round waits for the `provider-done` event up to the
   * current interval; on timeout it polls the provider (fallback when webhooks
   * are not delivered). Intervals grow ×1.5 up to a minute.
   */
  private async waitForJob(step: WorkflowStep, ctx: JobContext, modelId: string, externalId: string, attempt: number): Promise<JobStatus> {
    const kind = ctx.spec.kind;
    let interval: number = FIRST_WAIT_S[kind];
    for (let i = 1; i <= MAX_WAITS[kind]; i++) {
      let status: JobStatus | null = null;
      try {
        const ev = await step.waitForEvent<ProviderDoneEvent>(`wait-${attempt}-${i}`, { type: PROVIDER_DONE, timeout: `${interval} seconds` });
        const payload = ev.payload;
        if (payload && payload.externalId === externalId && payload.status) status = payload.status;
      } catch {
        // Timed out: poll below.
      }
      if (status && (status.state === "succeeded" || status.state === "failed")) return status;
      if (status) await step.do(`progress-${attempt}-${i}`, RETRY, async () => reportProgress(this.env, ctx, status!));
      else {
        status = await step.do(`poll-${attempt}-${i}`, RETRY, async () => pollJob(this.env, ctx, modelId, externalId));
        if (status.state === "succeeded" || status.state === "failed") return status;
      }
      interval = Math.min(MAX_WAIT_S, Math.ceil(interval * 1.5));
    }
    return failedStatus(externalId, { code: "timeout", message: "The provider did not finish in time. No credits were charged.", retryable: true, refundable: true });
  }
}

function failedStatus(externalId: string, error: JobError): JobStatus {
  return { externalId, state: "failed", progress: 0, outputs: [], costUsd: null, error };
}
