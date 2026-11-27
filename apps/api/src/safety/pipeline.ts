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
  SAFETY_BLOCKED_MESSAGE,
  SAFETY_REVIEW_MESSAGE,
  expandedPromptCheck,
  postCheck,
  preCheck,
  matureRequiredMessage,
  quickCheck,
  type MatureAccess,
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

export function jobErrorFor(v: SafetyVerdict, access?: MatureAccess): SafetyJobError {
  const codes = new Set(v.reasons.map((r) => r.code));
  if (codes.size === 1 && codes.has("MATURE_REQUIRED")) return { code: "mature_required", message: `${matureRequiredMessage(access)} No credits were charged.` };
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

/** D-005: the caller was mature-allowed when the run was quoted (snapshot on the spec). */
export function specMatureAllowed(spec: Pick<GenSpec, "matureAccess">): boolean {
  return spec.matureAccess === "allowed";
}

/**
 * `prepare`: flagged workspaces lose mature runs; then the full pre-check.
 * Returns the error to fail with, `needsMature` when a mature-allowed caller's
 * non-mature item turned out explicit (the caller re-plans it as mature), or null.
 */
export async function jobPreCheck(
  env: Env,
  job: JobRef,
  model: CatalogModel,
  prompt: string,
  negativePrompt: string | undefined,
  references: SafetyReference[],
  /** D-027: R2 keys of the references, preserved as evidence on a MINOR_SEXUAL block. */
  evidenceKeys: string[] = [],
): Promise<SafetyJobError | "needsMature" | null> {
  if (job.spec.mature && (await workspaceFlagged(env, job.workspaceId))) return SAFETY_REVIEW_ERROR;
  const matureAllowed = specMatureAllowed(job.spec);
  const verdict = await preCheck({ prompt, ...(negativePrompt && { negativePrompt }), references, mature: job.spec.mature, matureAllowed, model }, await safetyDeps(env));
  if (shouldLog(verdict)) {
    await logSafety(env, { id: `${job.jobId}:pre:${model.id}`, workspaceId: job.workspaceId, userId: job.userId, runId: job.runId, jobId: job.jobId, stage: "pre", verdict, prompt, evidenceKeys });
  }
  if (verdict.verdict === "block") return jobErrorFor(verdict, job.spec.matureAccess);
  return verdict.needsMature && !job.spec.mature ? "needsMature" : null;
}

/** `store`: the post-check over what was just stored. */
export async function jobPostCheck(env: Env, job: JobRef, outputs: SafetyOutput[], evidenceKeys: string[] = []): Promise<{ verdict: SafetyVerdict; error: SafetyJobError | null }> {
  const verdict = await postCheck({ outputs, mature: job.spec.mature, matureAllowed: specMatureAllowed(job.spec), prompt: job.spec.prompt }, await safetyDeps(env));
  if (shouldLog(verdict)) {
    await logSafety(env, { id: `${job.jobId}:post`, workspaceId: job.workspaceId, userId: job.userId, runId: job.runId, jobId: job.jobId, stage: "post", verdict, prompt: job.spec.prompt, evidenceKeys });
  }
  return { verdict, error: verdict.verdict === "block" ? jobErrorFor(verdict, job.spec.matureAccess) : null };
}

/** `store` (D-020): the text checks on the prompt the gateway's expansion rendered. */
export async function jobExpandedCheck(env: Env, job: JobRef, expandedPrompt: string): Promise<SafetyJobError | null> {
  const verdict = await expandedPromptCheck({ expandedPrompt, mature: job.spec.mature, matureAllowed: specMatureAllowed(job.spec) }, await safetyDeps(env));
  if (shouldLog(verdict)) {
    await logSafety(env, { id: `${job.jobId}:expanded`, workspaceId: job.workspaceId, userId: job.userId, runId: job.runId, jobId: job.jobId, stage: "post", verdict, prompt: expandedPrompt });
  }
  return verdict.verdict === "block" ? jobErrorFor(verdict, job.spec.matureAccess) : null;
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
  matureAccess?: MatureAccess;
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
 * run of a caller without mature access → MATURE_REQUIRED with copy for their
 * situation (`matureAccess`). Dependents of a blocked
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
    const block = (code: string, reason: string, extra: Partial<QuoteSafetyItem> = {}) => {
      Object.assign(item, { action: "blocked", code, reason, ...extra });
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
    } else if (q.explicit.length > 0 && !specMatureAllowed(spec)) {
      // D-005: mature-allowed callers never get here (the planner made the item mature). The copy fits the caller:
      // no plan → paid plan (upgrade modal reason `mature`), preference off → Settings, workspace off → the workspace.
      const access: MatureAccess = spec.matureAccess ?? (auth.isMember ? "preference_off" : "no_plan");
      block("MATURE_REQUIRED", matureRequiredMessage(access), { matureAccess: access });
    }
  }
}

/**
 * D-005 quote-time text classifier (`ExplicitCheck`) for a mature-allowed
 * caller's text-only video the rules see nothing in: explicit → the planner
 * chains it (keyframe → animation) before anything is held. Uses the same
 * cached text check as `prepare`; any error or block counts as "not explicit"
 * (the job's own pre-check still runs).
 */
/** The quote waits at most this long for the text classifier (live quotes follow typing; Auto uses the same budget). */
export const QUOTE_EXPLICIT_TIMEOUT_MS = 4000;

export function quoteExplicitCheck(env: Env): (prompt: string) => Promise<boolean> {
  return async (prompt) => {
    const deps = { ...(await safetyDeps(env)), textTimeoutMs: QUOTE_EXPLICIT_TIMEOUT_MS };
    const verdict = await preCheck({ prompt, references: [], mature: false, matureAllowed: true }, deps);
    return verdict.verdict === "allow" && verdict.needsMature === true;
  };
}
