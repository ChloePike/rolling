/**
 * D-005 checks in the generation pipeline (GenerateWorkflow steps and the
 * quote). `prepare` runs `preCheck`, `store` runs `postCheck` before anything
 * is committed; the quote runs the deterministic rules only, before credits
 * are held.
 */
import type { CatalogModel, ImageSource } from "@rolling/core";
import type { Catalog } from "@rolling/core";
import type { GenInput, GenSpec } from "@rolling/core/generation";
import {
  MATURE_JOIN_MESSAGE,
  MATURE_REQUIRED_MESSAGE,
  SAFETY_BLOCKED_MESSAGE,
  SAFETY_REVIEW_MESSAGE,
  postCheck,
  preCheck,
  quickCheck,
  type ReferenceSource,
  type SafetyOutput,
  type SafetyReference,
  type SafetyVerdict,
} from "@rolling/core/safety";
import { logSafety, safetyDeps, shouldLog, workspaceFlagged } from "./service";

export function referenceSource(origin: ImageSource): ReferenceSource {
  if (origin === "generated" || origin === "character" || origin === "public") return origin;
  if (origin === "builtin") return "public";
  return "upload";
}

/** Job error for a blocked check (neutral copy; codes stay internal). */
export interface SafetyJobError {
  code: "safety_blocked" | "mature_required" | "safety_unavailable" | "safety_review";
  message: string;
}

export function jobErrorFor(v: SafetyVerdict): SafetyJobError {
  const codes = new Set(v.reasons.map((r) => r.code));
  if (codes.size === 1 && codes.has("MATURE_REQUIRED")) return { code: "mature_required", message: `${MATURE_REQUIRED_MESSAGE} No credits were charged.` };
  if (codes.size === 1 && codes.has("SAFETY_UNAVAILABLE")) {
    return { code: "safety_unavailable", message: "Content checks are unavailable right now. Try again in a few minutes. No credits were charged." };
  }
  return { code: "safety_blocked", message: `${SAFETY_BLOCKED_MESSAGE} No credits were charged.` };
}

export const SAFETY_REVIEW_ERROR: SafetyJobError = { code: "safety_review", message: `${SAFETY_REVIEW_MESSAGE} No credits were charged.` };

export interface JobRef {
  jobId: string;
  runId: string;
  workspaceId: string;
  userId: string;
  spec: GenSpec;
}

/** `prepare`: flagged workspaces lose mature runs; then the full pre-check. Returns the error to fail with, or null. */
export async function jobPreCheck(env: Env, job: JobRef, model: CatalogModel, prompt: string, negativePrompt: string | undefined, references: SafetyReference[]): Promise<SafetyJobError | null> {
  if (job.spec.mature && (await workspaceFlagged(env, job.workspaceId))) return SAFETY_REVIEW_ERROR;
  const verdict = await preCheck({ prompt, ...(negativePrompt && { negativePrompt }), references, mature: job.spec.mature, model }, await safetyDeps(env));
  if (shouldLog(verdict)) {
    await logSafety(env, { id: `${job.jobId}:pre:${model.id}`, workspaceId: job.workspaceId, userId: job.userId, runId: job.runId, jobId: job.jobId, stage: "pre", verdict, prompt });
  }
  return verdict.verdict === "block" ? jobErrorFor(verdict) : null;
}

/** `store`: the post-check over what was just stored. */
export async function jobPostCheck(env: Env, job: JobRef, outputs: SafetyOutput[]): Promise<{ verdict: SafetyVerdict; error: SafetyJobError | null }> {
  const verdict = await postCheck({ outputs, mature: job.spec.mature, prompt: job.spec.prompt }, await safetyDeps(env));
  if (shouldLog(verdict)) {
    await logSafety(env, { id: `${job.jobId}:post`, workspaceId: job.workspaceId, userId: job.userId, runId: job.runId, jobId: job.jobId, stage: "post", verdict, prompt: job.spec.prompt });
  }
  return { verdict, error: verdict.verdict === "block" ? jobErrorFor(verdict) : null };
}

/** The quote's view of a plan item (structural subset of PlanItem). */
export interface QuoteSafetyItem {
  ref: string;
  action: string;
  dependsOn: string[];
  spec?: GenSpec;
  model: string | null;
  code?: string;
  reason?: string;
}

function inputSources(inputs: readonly GenInput[]): SafetyReference[] {
  return inputs
    .filter((i) => i.media !== "text")
    .map((i) => ({
      kind: i.media as SafetyReference["kind"],
      source: "node" in i.from ? "generated" : "assetId" in i.from ? referenceSource(i.from.origin) : "generated",
    }));
}

/**
 * Quote-time checks (cheap, deterministic): hard-limit rules → SAFETY_BLOCKED,
 * flagged workspace + mature → SAFETY_REVIEW, explicit terms on a non-mature
 * run → MATURE_REQUIRED (or NO_PLAN for non-members). Dependents of a blocked
 * item become `upstream_blocked`. Mutates `items` in place (planner order).
 */
export async function quoteSafety(
  env: Env,
  auth: { workspaceId: string; userId: string; isMember: boolean },
  items: QuoteSafetyItem[],
  catalog: Catalog,
): Promise<void> {
  const blocked = new Set<string>();
  let flagged: boolean | null = null;
  for (const item of items) {
    if (item.action !== "run" || !item.spec) {
      if (item.action === "blocked") blocked.add(item.ref);
      continue;
    }
    const block = (code: string, reason: string) => {
      Object.assign(item, { action: "blocked", code, reason });
      blocked.add(item.ref);
    };
    if (item.dependsOn.some((d) => blocked.has(d))) {
      block("upstream_blocked", "An input can’t run.");
      continue;
    }
    const spec = item.spec;
    const model = item.model ? catalog.get(item.model) : undefined;
    const q = quickCheck({ prompt: spec.prompt, references: inputSources(spec.inputs), mature: spec.mature, ...(model && { model }) });
    if (q.verdict === "block") {
      block("SAFETY_BLOCKED", SAFETY_BLOCKED_MESSAGE);
      await logSafety(env, { workspaceId: auth.workspaceId, userId: auth.userId, stage: "quote", verdict: q, prompt: spec.prompt });
      continue;
    }
    if (spec.mature) {
      flagged ??= await workspaceFlagged(env, auth.workspaceId);
      if (flagged) block("SAFETY_REVIEW", SAFETY_REVIEW_MESSAGE);
    } else if (q.explicit.length > 0) {
      if (auth.isMember) block("MATURE_REQUIRED", MATURE_REQUIRED_MESSAGE);
      else block("NO_PLAN", MATURE_JOIN_MESSAGE);
    }
  }
}
