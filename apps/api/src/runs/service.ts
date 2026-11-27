/**
 * Runs (M4): quote → start → hold per ready item → one GenerateWorkflow per job
 * → dependents start when their inputs land. Routes stay thin; the workflow
 * calls back into `advanceRun` after each job.
 *
 * Holds are taken per item when it is ready (its upstream items succeeded) and
 * a job slot is free: CreditAccount counts open holds against the plan's
 * "jobs at once" (D-006), so holding a whole run-all up front would refuse it.
 * The start route checks the balance for the whole run first.
 */
import type { LedgerErrorCode } from "@rolling/core/credits";
import { planPromptSpec, planRun, specAssetIds, specTitle, type ChainStep, type PlanItem, type PromptSpec, type RunScope, type SpecAsset } from "@rolling/core/generation";
import { newId } from "@rolling/core/ids";
import type { ImageSource } from "@rolling/core";
import { matureAccessOf, type MatureAccess } from "@rolling/core/safety";
import type { AuthContext } from "../auth/context";
import { ApiError } from "../lib/errors";
import { isRoomError, roomFailure } from "../lib/room";
import type { RoomCaller } from "../lib/access";
import { loadCatalog } from "../models/catalog";
import { gatewayFeatureEnabled } from "../models/features";
import { autoClassifier, gatewayConfigured } from "./provider";
import { guessSurface, runSurface, specRunTitle, type RunSurface } from "./surface";
import { quoteExplicitCheck, quoteSafety } from "../safety/pipeline";
import { ports, quietly } from "./ports";
import {
  getItems,
  getRun,
  parseJson,
  paramsSummary,
  refreshRun,
  itemSpec,
  type QuoteRow,
  type RunItemRow,
  type RunOptions,
  type RunRow,
  type StoredQuoteItem,
} from "./store";

/** Run options only the server sets (stored in `runs.options` with the staging ones). */
export interface ServerRunOptions {
  /**
   * D-021 Auto mode: credits the agent may still start in this turn after this run. With `turnId` and
   * `turnBudget`, what is left is recomputed when a review retry is considered: the turn's budget minus the
   * runs started in the turn and the review retries already made (D-024).
   */
  auto?: { budgetLeft: number; turnId?: string; turnBudget?: number };
  /** D-024: this run is an Auto retry of `jobId` with its review fix. */
  reviewRetryOf?: { jobId: string; budgetKey: string };
}

export interface QuoteResponseItem {
  ref: string;
  nodeId: string | null;
  title: string;
  kind: string;
  action: PlanItem["action"];
  model: string | null;
  modelName: string | null;
  credits: number;
  code?: string;
  reason?: string;
  lowestPlan?: string | null;
  /** MATURE_REQUIRED rows: the caller's D-005 access (`no_plan` → upgrade modal reason `mature`; `preference_off` → Settings). */
  matureAccess?: string;
  autoVia?: string;
  dependsOn: string[];
  /** D-005 mature text-to-video chain: `keyframe` (the first frame) or `animate`; both are priced in `total`. */
  step?: "keyframe" | "animate";
  /** D-020: the price includes prompt enhancement (its most; settled on what the gateway charges). */
  promptExpand?: true;
}

export interface QuoteResponse {
  /** Null when nothing in the plan runs (only reuse / blocked / none rows). */
  quoteId: string | null;
  items: QuoteResponseItem[];
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number | null;
  /** The user's "Confirm before running" threshold (D-006): totals below it may start without the dialog. */
  confirmThreshold: number;
  /** total >= confirmThreshold: show RunConfirm before `POST /api/runs`. */
  needsConfirm: boolean;
}

export type QuoteRequest =
  | { projectId: string; scope: RunScope; nodeIds?: string[]; caller: RoomCaller; matureAllowed: boolean; retryOf?: string; surface?: RunSurface }
  | { promptSpec: PromptSpec; projectId?: string | null; onlyRefs?: string[]; priorAssets?: Record<string, string>; retryOf?: string; surface?: RunSurface };

function toResponseItem(i: StoredQuoteItem): QuoteResponseItem {
  return {
    ref: i.ref,
    nodeId: i.nodeId,
    title: i.title,
    kind: i.kind,
    action: i.action,
    model: i.model,
    modelName: i.modelName,
    credits: i.action === "run" ? i.credits : 0,
    ...(i.code && { code: i.code }),
    ...(i.reason && { reason: i.reason }),
    ...(i.lowestPlan !== undefined && { lowestPlan: i.lowestPlan }),
    ...(i.matureAccess && { matureAccess: i.matureAccess }),
    ...(i.autoVia && { autoVia: i.autoVia }),
    dependsOn: i.dependsOn,
    ...(i.spec?.chain && { step: i.spec.chain.step }),
    ...(i.action === "run" && i.priceRequest?.promptExpandUsd !== undefined && { promptExpand: true as const }),
  };
}

const LEDGER_BLOCK: Record<string, { code: string; reason: string }> = {
  unknown_model: { code: "unknown_model", reason: "This model is not available." },
  unpriced: { code: "unpriced", reason: "This model has no price for these settings." },
  resolution_locked: { code: "resolution_locked", reason: "This resolution needs a higher plan." },
};

/**
 * Input assets of a tool spec. `ready` assets of the workspace (and builtin/public
 * ones) are usable; so are the caller's own uploads still `processing`: their
 * bytes are in R2 once the multipart upload completed, and probing only adds
 * the length (the browser-reported one stands in until then, re-checked in
 * `prepare`). `uploading` / `failed` / removed assets block the item.
 */
async function assetOrigins(env: Env, workspaceId: string, userId: string, spec: PromptSpec, matureAllowed: boolean): Promise<Map<string, SpecAsset>> {
  const ids = specAssetIds(spec);
  const out = new Map<string, SpecAsset>();
  if (ids.length === 0) return out;
  const rows = await env.DB.prepare(
    `SELECT id, kind, source, workspace_id, meta, status, mature FROM assets WHERE id IN (${ids.map(() => "?").join(",")}) AND (workspace_id = ? OR workspace_id IS NULL)
       AND (status = 'ready' OR (status = 'processing' AND created_by = ? AND kind IN ('image','video','audio')))`,
  )
    .bind(...ids, workspaceId, userId)
    .all<{ id: string; kind: string; source: string; workspace_id: string | null; meta: string | null; status: string; mature: number | null }>();
  for (const r of rows.results) {
    if (r.kind !== "image" && r.kind !== "video" && r.kind !== "audio") continue;
    // D-005: a mature shared asset (e.g. a mature public-library item) is not available to callers who may not see it.
    if (r.mature === 1 && r.workspace_id === null && !matureAllowed) continue;
    const origin: ImageSource = r.source === "generated" || r.source === "public" || r.source === "builtin" ? r.source : r.source === "team" ? "team" : "upload";
    const meta = parseJson<{ durationSec?: unknown; durationSource?: unknown; thumbKey?: unknown; sceneCuts?: unknown }>(r.meta, {});
    const cuts = Array.isArray(meta.sceneCuts) ? meta.sceneCuts.filter((c): c is number => typeof c === "number") : [];
    const hasDuration = typeof meta.durationSec === "number" && meta.durationSec > 0;
    out.set(r.id, {
      origin,
      media: r.kind,
      ...(hasDuration && { durationSec: meta.durationSec as number }),
      ...(hasDuration && meta.durationSource === "declared" && { durationDeclared: true }),
      ...(r.kind === "video" && typeof meta.thumbKey === "string" && { poster: true }),
      ...(r.kind === "video" && cuts.length > 0 && { sceneCuts: cuts }),
      // Mature shared assets (public library) make the item a mature run (D-005; only mature-allowed callers get here).
      ...(r.mature === 1 && r.workspace_id === null && { mature: true }),
    });
  }
  // Saved Characters count as platform assets (D-005).
  const chars = await env.DB.prepare(`SELECT cover_asset_id, versions FROM characters WHERE workspace_id = ?`)
    .bind(workspaceId)
    .all<{ cover_asset_id: string | null; versions: string }>();
  const characterAssets = new Set<string>();
  for (const c of chars.results) {
    if (c.cover_asset_id) characterAssets.add(c.cover_asset_id);
    for (const v of parseJson<Array<{ assetIds?: unknown }>>(c.versions, [])) {
      if (Array.isArray(v.assetIds)) for (const a of v.assetIds) if (typeof a === "string") characterAssets.add(a);
    }
  }
  for (const id of ids) {
    const a = out.get(id);
    if (a && a.media === "image" && characterAssets.has(id)) out.set(id, { ...a, origin: "character" });
  }
  return out;
}

/** Tool of a spec run, for Activity and the tool feeds. */
export function toolOf(spec: PromptSpec): "quick" | "remix" | "avatar" | "character" {
  return spec.kind === "remix" || spec.kind === "avatar" || spec.kind === "character" ? spec.kind : "quick";
}

/** The normalized request a quote/run was made from (`quotes.request`, `runs.request`). */
export type RunRequestRecord =
  | { promptSpec: PromptSpec; onlyRefs?: string[]; priorAssets?: Record<string, string>; retryOf?: string; surface?: RunSurface }
  | { scope: RunScope; nodeIds?: string[]; retryOf?: string; surface?: RunSurface };

/** D-005 access of the caller (member, preference, workspace flag); decides auto-mature routing and the MATURE_REQUIRED copy. */
export function callerMatureAccess(auth: Pick<AuthContext, "isMember" | "prefs" | "workspace">, allowed?: boolean): MatureAccess {
  const access = matureAccessOf({ isMember: auth.isMember, preference: auth.prefs.matureContent, workspaceAllowed: auth.workspace.matureAllowed });
  if (allowed === undefined) return access;
  // Canvas runs use the project's workspace: its flag decides when the caller's own context says yes.
  if (allowed) return "allowed";
  return access === "allowed" ? "workspace_off" : access;
}

/** Plans and prices a run; stores the quote (10 minutes, D-006 CreditAccount TTL). */
export async function quoteRun(env: Env, auth: AuthContext, req: QuoteRequest): Promise<QuoteResponse> {
  const catalog = await loadCatalog(env);
  const classify = await autoClassifier(env, auth.isMember);
  // D-005: mature-allowed callers' text-only videos get the text classifier at quote time (only asked when no text-to-video
  // model takes mature runs), so an explicit one is planned as keyframe → animation before anything is held.
  const explicit = gatewayConfigured(env) ? quoteExplicitCheck(env) : null;
  // D-020: "Enhance prompt" default and availability (off while the gateway refuses the feature here).
  const promptExpand = { default: auth.prefs.enhancePrompt, available: await gatewayFeatureEnabled(env, "prompt_expand") };
  let items: PlanItem[];
  let projectId: string | null = null;
  let scope: string;
  let record: RunRequestRecord;
  if ("promptSpec" in req) {
    scope = "spec";
    projectId = req.projectId ?? null;
    record = {
      promptSpec: req.promptSpec,
      ...(req.onlyRefs && { onlyRefs: req.onlyRefs }),
      ...(req.priorAssets && Object.keys(req.priorAssets).length > 0 && { priorAssets: req.priorAssets }),
      ...(req.retryOf && { retryOf: req.retryOf }),
      surface: runSurface({ promptSpec: req.promptSpec }, req.surface),
    };
    const origins = await assetOrigins(env, auth.workspaceId, auth.userId, req.promptSpec, auth.matureAllowed);
    items = (
      await planPromptSpec({
        spec: req.promptSpec,
        catalog,
        ctx: { plan: auth.plan, matureAllowed: auth.matureAllowed, matureAccess: callerMatureAccess(auth), promptExpand },
        classify,
        explicit,
        assetOrigins: origins,
        ...(req.onlyRefs && { onlyRefs: req.onlyRefs }),
        ...(req.priorAssets && { priorAssets: req.priorAssets }),
      })
    ).items;
  } else {
    scope = req.scope;
    record = { scope: req.scope, ...(req.nodeIds && { nodeIds: req.nodeIds }), ...(req.retryOf && { retryOf: req.retryOf }), surface: runSurface({ scope: req.scope }, req.surface) };
    projectId = req.projectId;
    const room = ports(env).room(req.projectId);
    const [structural, graph] = await Promise.all([room.planRun(req.caller, { scope: req.scope, ...(req.nodeIds && { nodeIds: req.nodeIds }) }), room.getGraph(req.caller)]);
    if (isRoomError(structural)) roomFailure(structural);
    if (isRoomError(graph)) roomFailure(graph);
    if (req.nodeIds?.some((id) => !graph.state.nodes.some((n) => n.id === id))) {
      throw new ApiError(404, "NOT_FOUND", "Node not found", { nodeIds: req.nodeIds });
    }
    items = (await planRun({ graph: graph.state, structural: structural.items, catalog, ctx: { plan: auth.plan, matureAllowed: req.matureAllowed, matureAccess: callerMatureAccess(auth, req.matureAllowed), promptExpand }, classify, explicit })).items;
  }

  // D-005: deterministic hard-limit rules before anything is priced or held.
  await quoteSafety(env, auth, items, catalog);

  const credits = ports(env).credits(auth.workspaceId);
  const runs = items.filter((i) => i.action === "run");
  const stored: StoredQuoteItem[] = items.map((i) => ({ ...i, credits: 0 }));
  let quoteId: string | null = null;
  let expiresAt: number | null = null;
  let balance: number;
  if (runs.length > 0) {
    const q = await credits.quote(runs.map((i) => ({ ref: i.ref, modelId: i.model!, request: i.priceRequest ?? {} })));
    quoteId = q.quoteId;
    expiresAt = q.expiresAt;
    balance = q.balance;
    const priced = new Map(q.items.map((p) => [p.ref, p]));
    const blocked = new Set<string>();
    for (const item of stored) {
      if (item.action !== "run") continue;
      const p = priced.get(item.ref);
      if (p?.blocked) {
        Object.assign(item, { action: "blocked", ...LEDGER_BLOCK[p.blocked], ...(p.lowestPlan !== undefined && { lowestPlan: p.lowestPlan }) });
        blocked.add(item.ref);
      } else if (item.dependsOn.some((d) => blocked.has(d))) {
        Object.assign(item, { action: "blocked", code: "upstream_blocked", reason: "An input can’t run." });
        blocked.add(item.ref);
      } else item.credits = p?.credits ?? 0;
    }
  } else {
    const b = await credits.balance();
    balance = b.plan + b.purchased;
  }
  const total = stored.reduce((s, i) => s + (i.action === "run" ? i.credits : 0), 0);
  if (quoteId) {
    await env.DB.prepare("INSERT INTO quotes (id, workspace_id, project_id, items, total, expires_at, created_by, scope, created_at, request) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(quoteId, auth.workspaceId, projectId, JSON.stringify(stored), total, expiresAt, auth.userId, scope, Date.now(), JSON.stringify(record))
      .run();
  }
  const confirmThreshold = auth.prefs.confirmThreshold;
  return { quoteId, items: stored.map(toResponseItem), total, balance, balanceAfter: balance - total, expiresAt, confirmThreshold, needsConfirm: total >= confirmThreshold };
}

const LEDGER_API: Partial<Record<LedgerErrorCode, [402 | 403 | 409 | 429, "NO_PLAN" | "INSUFFICIENT_CREDITS" | "MEMBER_LIMIT_REACHED" | "QUOTE_EXPIRED" | "CONCURRENCY_LIMIT"]>> = {
  NO_PLAN: [402, "NO_PLAN"],
  INSUFFICIENT_CREDITS: [402, "INSUFFICIENT_CREDITS"],
  MEMBER_LIMIT_REACHED: [403, "MEMBER_LIMIT_REACHED"],
  QUOTE_EXPIRED: [409, "QUOTE_EXPIRED"],
};

/** Starts a run from a quote. Idempotent per quote: a second start returns the same run. */
export async function startRun(
  env: Env,
  auth: AuthContext,
  quoteId: string,
  rawOptions: RunOptions = {},
  /** Set by the server only, never from a request body: Auto mode's budget and review retries (D-021, D-024). */
  serverOptions: ServerRunOptions = {},
): Promise<{ runId: string; status: RunRow["status"] }> {
  const quote = await env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND workspace_id = ?").bind(quoteId, auth.workspaceId).first<QuoteRow>();
  if (!quote) throw new ApiError(404, "NOT_FOUND", "Quote not found", { quoteId });
  const existing = await env.DB.prepare("SELECT id, status FROM runs WHERE quote_id = ?").bind(quoteId).first<{ id: string; status: RunRow["status"] }>();
  if (existing) return { runId: existing.id, status: existing.status };
  const now = Date.now();
  if (quote.expires_at <= now) throw new ApiError(409, "QUOTE_EXPIRED", "Quote expired", { quoteId, expiresAt: quote.expires_at });

  const items = parseJson<StoredQuoteItem[]>(quote.items, []).filter((i) => i.action === "run" && i.spec && i.model);
  if (items.length === 0) throw new ApiError(409, "CONFLICT", "Nothing to run in this quote", { quoteId });
  // No model gateway key (e.g. a fresh production before HYPEROUTER_API_KEY is set): refuse before any hold.
  if (!gatewayConfigured(env)) throw new ApiError(503, "INTERNAL", "Generation is not available right now", { reason: "gateway_not_configured" });
  const total = items.reduce((s, i) => s + i.credits, 0);
  const credits = ports(env).credits(auth.workspaceId);
  const b = await credits.balance();
  if (total > b.plan + b.purchased) {
    throw new ApiError(402, "INSUFFICIENT_CREDITS", "Not enough credits", { needed: total, balance: b.plan + b.purchased });
  }
  // Staging-only failure injection (canvas golden path, step 7).
  const options: RunOptions & ServerRunOptions = { ...(env.ENVIRONMENT === "production" ? {} : rawOptions), ...serverOptions };
  const runId = newId("run");
  const first = items[0]!;
  const record = parseJson<RunRequestRecord | null>(quote.request, null);
  const spec = record && "promptSpec" in record ? record.promptSpec : null;
  const itemsTitle = spec && items.length > 1 ? specTitle(spec) : items.length === 1 ? first.title : `${first.title} +${items.length - 1}`;
  // A plain image or video is named by its prompt (“Video” says nothing in Activity).
  const title = spec ? specRunTitle(spec, itemsTitle) : itemsTitle;
  const surface = record?.surface ?? (record ? runSurface(record) : quote.scope === "spec" ? "quick" : "canvas");
  const statements = [
    env.DB.prepare(
      "INSERT INTO runs (id, workspace_id, project_id, quote_id, scope, status, created_by, created_at, title, source, credits_quoted, options, updated_at, request, retry_of, tool, surface) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      runId,
      auth.workspaceId,
      quote.project_id,
      quoteId,
      quote.scope ?? "node",
      auth.userId,
      now,
      title,
      quote.scope === "spec" ? "quickCreate" : "canvas",
      total,
      JSON.stringify(options),
      now,
      quote.request,
      record?.retryOf ?? null,
      spec ? toolOf(spec) : null,
      surface,
    ),
    ...items.map((i, ord) =>
      env.DB.prepare(
        "INSERT INTO run_items (run_id, ref, node_id, title, kind, model, spec, price_request, params_hash, depends_on, credits, status, ord, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).bind(runId, i.ref, i.nodeId, i.title, i.kind, i.model, JSON.stringify(i.spec), JSON.stringify(i.priceRequest ?? {}), i.paramsHash ?? null, JSON.stringify(i.dependsOn), i.credits, ord, now),
    ),
  ];
  await env.DB.batch(statements);

  if (quote.project_id) {
    const room = ports(env).room(quote.project_id);
    await Promise.all(items.filter((i) => i.nodeId).map((i) => quietly("markRunning", () => room.markRunning({ nodeId: i.nodeId!, jobId: "", progress: 0, status: "queued" }))));
  }

  const result = await advanceRun(env, runId);
  if (result.started === 0 && result.firstError && LEDGER_API[result.firstError.code]) {
    const [status, code] = LEDGER_API[result.firstError.code]!;
    // Nothing started: surface the ledger refusal (the run is recorded as failed).
    throw new ApiError(status, code, result.firstError.message, { runId, ...result.firstError.data });
  }
  const run = await getRun(env.DB, runId);
  return { runId, status: run?.status ?? "queued" };
}

export interface AdvanceResult {
  started: number;
  firstError?: { code: LedgerErrorCode; message: string; data: Record<string, unknown> };
}

/**
 * Holds and starts every ready item of a run (inputs landed, slot free), skips
 * items whose inputs failed, and refreshes the run. Safe to call concurrently:
 * holds are idempotent per (run, item) and workflow ids are the job ids.
 */
export async function advanceRun(env: Env, runId: string): Promise<AdvanceResult> {
  const out: AdvanceResult = { started: 0 };
  const run = await getRun(env.DB, runId);
  if (!run || run.status === "canceled") return out;
  const items = await getItems(env.DB, runId);
  const status = new Map(items.map((i) => [i.ref, i.status]));
  const p = ports(env);
  const room = run.project_id ? p.room(run.project_id) : null;
  const credits = p.credits(run.workspace_id);
  const limit = await env.DB.prepare("SELECT monthly_credit_limit FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .bind(run.workspace_id, run.created_by)
    .first<{ monthly_credit_limit: number | null }>();
  const now = () => Date.now();
  let changed = false;

  for (const item of items) {
    if (item.status !== "pending") continue;
    const deps = parseJson<string[]>(item.depends_on, []).filter((d) => status.has(d));
    if (deps.some((d) => ["failed", "skipped", "canceled"].includes(status.get(d)!))) {
      await env.DB.prepare("UPDATE run_items SET status = 'skipped', error_code = 'upstream_failed', error_message = ?, updated_at = ? WHERE run_id = ? AND ref = ? AND status = 'pending'")
        .bind("An input failed.", now(), runId, item.ref)
        .run();
      status.set(item.ref, "skipped");
      changed = true;
      // A chain's animation was held with its keyframe: that hold goes back now.
      if (item.job_id) {
        const b = await releasePrepaid(env, run, item, "upstream_failed");
        if (b) await pushCredits(env, run, b);
      }
      if (room && item.node_id) await quietly("markFailed", () => room.markFailed({ nodeId: item.node_id!, jobId: "", refunded: 0, reason: "An input failed." }));
      continue;
    }
    if (!deps.every((d) => status.get(d) === "succeeded")) continue;

    // D-005 chain: the animation was held together with its keyframe (one hold for the run's one price); it starts on that hold.
    if (item.job_id) {
      await startJob(env, run, item, item.job_id, item.credits);
      status.set(item.ref, "running");
      out.started++;
      changed = true;
      continue;
    }
    const chain = chainOf(item);
    const next = chain?.step === "keyframe" && status.get(chain.with) === "pending" ? chain.with : null;
    const held = await credits.hold({
      quoteId: run.quote_id,
      runId,
      userId: run.created_by,
      idemKey: `hold:${runId}:${item.ref}`,
      refs: next ? [item.ref, next] : [item.ref],
      ...(limit?.monthly_credit_limit != null && { memberMonthlyLimit: limit.monthly_credit_limit }),
    });
    if (!held.ok) {
      if (held.error.code === "CONCURRENCY_LIMIT") break; // A finishing job advances again.
      out.firstError ??= held.error;
      await env.DB.prepare("UPDATE run_items SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ? AND ref = ? AND status = 'pending'")
        .bind(held.error.code, held.error.message, now(), runId, item.ref)
        .run();
      status.set(item.ref, "failed");
      changed = true;
      if (room && item.node_id) await quietly("markFailed", () => room.markFailed({ nodeId: item.node_id!, jobId: "", refunded: 0, reason: held.error.message }));
      continue;
    }
    const job = held.value.jobs.find((j) => j.ref === item.ref) ?? held.value.jobs[0];
    if (!job) continue;
    const prepaid = next ? held.value.jobs.find((j) => j.ref === next) : undefined;
    if (prepaid) {
      // Recorded before the keyframe starts: the animation starts on this hold once the keyframe lands (or it is released).
      await env.DB.prepare("UPDATE run_items SET job_id = ?, updated_at = ? WHERE run_id = ? AND ref = ? AND status = 'pending' AND job_id IS NULL")
        .bind(prepaid.jobId, now(), runId, next)
        .run();
    }
    await startJob(env, run, item, job.jobId, job.credits);
    status.set(item.ref, "running");
    out.started++;
    changed = true;
    await pushCredits(env, run, held.value.balance);
  }
  if (changed || items.every((i) => i.status !== "pending")) await refreshRun(env.DB, runId);
  if (run.tool === "character") {
    try {
      if (await saveCharacterOf(env, runId)) changed = true;
    } catch (err) {
      console.error(JSON.stringify({ msg: "runs: character save failed", runId, error: String(err) }));
    }
  }
  if (changed) await quietly("activity", () => p.hub(run.created_by).broadcast("activity.updated", { runId }));
  return out;
}

/** The D-005 chain step of a run item, if any. */
function chainOf(item: Pick<RunItemRow, "spec">): ChainStep | null {
  try {
    return itemSpec(item).chain ?? null;
  } catch {
    return null;
  }
}

/**
 * Releases the hold of a chain animation that never started (its keyframe
 * failed, or the run was canceled first) and records it as a refunded,
 * canceled job so the run's totals show the refund. Idempotent.
 */
async function releasePrepaid(env: Env, run: RunRow, item: RunItemRow, reason: string): Promise<{ plan: number; purchased: number; held: number } | null> {
  if (!item.job_id) return null;
  const r = await ports(env).credits(run.workspace_id).release(item.job_id, reason, `release:${item.job_id}`);
  if (!r.ok && r.error.code !== "JOB_CLOSED") return null;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO jobs (id, run_id, project_id, node_id, title, provider, model, params_summary, workflow_id, status, progress, cost_quote, refunded, idempotency_key, error_code, created_at, workspace_id, item_ref, created_by, attempt, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hyperouter', ?, ?, NULL, 'canceled', 0, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
  )
    .bind(item.job_id, run.id, run.project_id, item.node_id, item.title, item.model, paramsSummary(itemSpec(item)), item.credits, item.job_id, reason, now, run.workspace_id, item.ref, run.created_by, now, now)
    .run();
  await refreshRun(env.DB, run.id, now);
  return r.ok ? r.value.balance : null;
}

async function startJob(env: Env, run: RunRow, item: RunItemRow, jobId: string, credits: number): Promise<void> {
  const now = Date.now();
  const spec = itemSpec(item);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO jobs (id, run_id, project_id, node_id, title, provider, model, params_summary, workflow_id, status, progress, cost_quote, idempotency_key, created_at, workspace_id, item_ref, created_by, attempt, updated_at) VALUES (?, ?, ?, ?, ?, 'hyperouter', ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).bind(jobId, run.id, run.project_id, item.node_id, item.title, item.model, paramsSummary(spec), jobId, credits, jobId, now, run.workspace_id, item.ref, run.created_by, now),
    env.DB.prepare("UPDATE run_items SET status = 'running', job_id = ?, updated_at = ? WHERE run_id = ? AND ref = ? AND status = 'pending'").bind(jobId, now, run.id, item.ref),
  ]);
  try {
    await env.GENERATE.create({ id: jobId, params: { jobId, runId: run.id, ref: item.ref, workspaceId: run.workspace_id } });
  } catch (err) {
    if (!/already exists|already_exists|duplicate/i.test(String(err))) throw err;
  }
}

/** Advances every run of the workspace that still has pending items (a job slot may have freed). */
export async function advanceWorkspace(env: Env, workspaceId: string, except?: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT r.id FROM runs r JOIN run_items i ON i.run_id = r.id WHERE r.workspace_id = ? AND r.status IN ('queued','running') AND i.status = 'pending' ORDER BY r.created_at LIMIT 20",
  )
    .bind(workspaceId)
    .all<{ id: string }>();
  for (const r of rows.results) if (r.id !== except) await advanceRun(env, r.id);
}

/** Pending items untouched this long are re-advanced by the cron safety net. */
export const STALLED_PENDING_MS = 2 * 60 * 1000;

/**
 * Cron safety net: a slot freed while nothing advanced (a crashed workflow
 * step, a lost `advanceWorkspace` after settle) would leave items waiting on
 * CONCURRENCY_LIMIT forever. Advances every workspace with pending items of an
 * active run untouched for 2 minutes. Idempotent like `advanceRun`.
 */
export async function advanceStalledRuns(env: Env, now = Date.now()): Promise<{ workspaces: number }> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT r.workspace_id FROM run_items i JOIN runs r ON r.id = i.run_id
     WHERE i.status = 'pending' AND i.updated_at < ? AND r.status IN ('queued','running') LIMIT 200`,
  )
    .bind(now - STALLED_PENDING_MS)
    .all<{ workspace_id: string }>();
  for (const r of rows.results) {
    try {
      await advanceWorkspace(env, r.workspace_id);
    } catch (err) {
      console.error(JSON.stringify({ msg: "runs: stalled advance failed", workspaceId: r.workspace_id, error: String(err) }));
    }
  }
  return { workspaces: rows.results.length };
}

/** Live balance push (D-003): the user socket and, for canvas runs, the project socket. */
export async function pushCredits(env: Env, run: Pick<RunRow, "created_by" | "project_id" | "workspace_id">, balance: { plan: number; purchased: number; held: number }): Promise<void> {
  // workspaceId lets clients with several workspaces apply the balance to the right one.
  const payload = { workspaceId: run.workspace_id, balance: balance.plan + balance.purchased, held: balance.held, plan: balance.plan, purchased: balance.purchased };
  const p = ports(env);
  await quietly("credits.changed hub", () => p.hub(run.created_by).broadcast("credits.changed", payload));
  if (run.project_id) await quietly("credits.changed room", () => p.room(run.project_id!).broadcast("credits.changed", payload));
}

/** Cancels a run: pending items stop, running jobs are terminated and their holds released. */
export async function cancelRun(env: Env, auth: AuthContext, runId: string): Promise<{ runId: string; refunded: number; canceled: number }> {
  const run = await getRun(env.DB, runId);
  if (!run || run.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Run not found", { runId });
  if (["succeeded", "partial", "failed", "canceled"].includes(run.status)) return { runId, refunded: 0, canceled: 0 };
  const now = Date.now();
  await env.DB.prepare("UPDATE runs SET status = 'canceled', updated_at = ? WHERE id = ?").bind(now, runId).run();
  // D-036 / D-037: a canceled extend or lip-sync takes its planned clip back off the timeline.
  await quietly("placement", async () => (await import("../post/placements")).dropPlacements(env, runId));
  const items = await getItems(env.DB, runId);
  const p = ports(env);
  const room = run.project_id ? p.room(run.project_id) : null;
  const credits = p.credits(run.workspace_id);
  let refunded = 0;
  let canceled = 0;
  let balance: { plan: number; purchased: number; held: number } | null = null;
  for (const item of items) {
    if (item.status !== "pending" && item.status !== "running") continue;
    canceled++;
    let itemRefund = 0;
    if (item.status === "pending" && item.job_id) {
      // A chain animation held with its keyframe: its hold goes back too.
      const b = await releasePrepaid(env, run, item, "canceled");
      if (b) {
        balance = b;
        itemRefund = item.credits;
        refunded += itemRefund;
      }
    }
    if (item.status === "running" && item.job_id) {
      try {
        await (await env.GENERATE.get(item.job_id)).terminate();
      } catch {
        // Already finished or never started.
      }
      const r = await credits.release(item.job_id, "canceled", `release:${item.job_id}`);
      if (r.ok) {
        itemRefund = r.value.refunded;
        refunded += itemRefund;
        balance = r.value.balance;
        await env.DB.prepare("UPDATE jobs SET status = 'canceled', refunded = 1, finished_at = ?, updated_at = ? WHERE id = ?").bind(now, now, item.job_id).run();
      } else if (r.error.code === "JOB_CLOSED") {
        // Settled or released already: the job finished first.
        continue;
      }
    }
    await env.DB.prepare("UPDATE run_items SET status = 'canceled', updated_at = ? WHERE run_id = ? AND ref = ?").bind(now, runId, item.ref).run();
    if (room && item.node_id) await quietly("markFailed", () => room.markFailed({ nodeId: item.node_id!, jobId: item.job_id ?? "", refunded: itemRefund, reason: "Canceled" }));
  }
  await refreshRun(env.DB, runId, now);
  if (balance) await pushCredits(env, run, balance);
  await quietly("activity", () => p.hub(run.created_by).broadcast("activity.updated", { runId }));
  await advanceWorkspace(env, run.workspace_id, runId);
  return { runId, refunded, canceled };
}

const RETRY_ITEM = new Set(["failed", "canceled", "skipped"]);

/**
 * `POST /api/runs/:id/retry`: quotes the failed, canceled and skipped items of
 * a finished run again with the same request (tool `promptSpec` or canvas
 * nodes), so the client confirms a fresh quote (threshold, paywalls and plan
 * caps apply as for any quote). Items that succeeded are not run again; a
 * tool run's later items use their outputs (`priorAssets`).
 */
export async function retryRun(
  env: Env,
  auth: AuthContext,
  runId: string,
  canvas: (projectId: string) => Promise<{ caller: RoomCaller; matureAllowed: boolean }>,
): Promise<QuoteResponse & { retryOf: string }> {
  const run = await getRun(env.DB, runId);
  if (!run || run.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Run not found", { runId });
  if (run.status === "queued" || run.status === "running") throw new ApiError(409, "CONFLICT", "The run is still running", { runId, reason: "RUNNING" });
  const items = await getItems(env.DB, runId);
  const again = items.filter((i) => RETRY_ITEM.has(i.status));
  if (again.length === 0) throw new ApiError(409, "CONFLICT", "Nothing to retry in this run", { runId, reason: "NOTHING_TO_RETRY" });
  const record = parseJson<RunRequestRecord | null>(run.request, null);

  if (record && "promptSpec" in record) {
    const jobs = (await env.DB.prepare("SELECT item_ref, asset_id FROM jobs WHERE run_id = ? AND status = 'succeeded' AND asset_id IS NOT NULL").bind(runId).all<{ item_ref: string; asset_id: string }>()).results;
    const priorAssets: Record<string, string> = { ...(record.priorAssets ?? {}) };
    for (const j of jobs) priorAssets[j.item_ref] = j.asset_id;
    const q = await quoteRun(env, auth, { promptSpec: record.promptSpec, projectId: run.project_id, onlyRefs: again.map((i) => i.ref), priorAssets, retryOf: runId, surface: guessSurface(run) });
    return { ...q, retryOf: runId };
  }
  if (!run.project_id || run.source !== "canvas") throw new ApiError(409, "CONFLICT", "This run can't be retried", { runId, reason: "NOT_RETRYABLE" });
  const access = await canvas(run.project_id);
  const graph = await ports(env).room(run.project_id).getGraph(access.caller);
  if (isRoomError(graph)) roomFailure(graph);
  const nodeIds = again.map((i) => i.node_id).filter((id): id is string => !!id && graph.state.nodes.some((n) => n.id === id));
  if (nodeIds.length === 0) throw new ApiError(409, "CONFLICT", "The nodes of this run were removed", { runId, reason: "NODES_REMOVED" });
  const q = await quoteRun(env, auth, { projectId: run.project_id, scope: "selection", nodeIds, caller: access.caller, matureAllowed: access.matureAllowed, retryOf: runId, surface: guessSurface(run) });
  return { ...q, retryOf: runId };
}

/** Deterministic Character id of a character run (saving twice is a no-op). */
export function characterIdFor(runId: string): string {
  return `chr_${runId.replace(/^run_/, "")}`;
}

/**
 * Character runs: once every item is final and at least one picture was made,
 * the pictures are saved to the workspace's Characters (cover = the face, else
 * the full body). Idempotent; a retry run completes the set with the earlier
 * run's pictures.
 */
export async function saveCharacterOf(env: Env, runId: string): Promise<string | null> {
  const run = await getRun(env.DB, runId);
  if (!run || run.tool !== "character" || run.character_id) return null;
  const items = await getItems(env.DB, runId);
  if (items.some((i) => i.status === "pending" || i.status === "running")) return null;
  const record = parseJson<RunRequestRecord | null>(run.request, null);
  if (!record || !("promptSpec" in record)) return null;
  const jobs = (await env.DB.prepare("SELECT item_ref, asset_id FROM jobs WHERE run_id = ? AND status = 'succeeded' AND asset_id IS NOT NULL").bind(runId).all<{ item_ref: string; asset_id: string }>()).results;
  if (jobs.length === 0) return null;
  const byRef: Record<string, string> = { ...(record.priorAssets ?? {}) };
  for (const j of jobs) byRef[j.item_ref] = j.asset_id;
  const assetIds = ["body", "face"].map((r) => byRef[r]).filter((x): x is string => !!x);
  const spec = record.promptSpec;
  // A retry adds a version to the Character its run saved (if it saved one).
  const previous = record.retryOf ? await getRun(env.DB, record.retryOf) : null;
  const id = previous?.character_id ?? characterIdFor(runId);
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT versions FROM characters WHERE id = ? AND workspace_id = ?").bind(id, run.workspace_id).first<{ versions: string }>();
  if (existing) {
    // A retry of the same character: add the completed set as a new version.
    const versions = parseJson<Array<{ n: number; assetIds: string[]; createdAt: number }>>(existing.versions, []);
    versions.push({ n: versions.length + 1, assetIds, createdAt: now });
    await env.DB.prepare("UPDATE characters SET versions = ?, cover_asset_id = ? WHERE id = ?").bind(JSON.stringify(versions), byRef.face ?? byRef.body ?? null, id).run();
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO characters (id, workspace_id, name, meta, cover_asset_id, versions, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        id,
        run.workspace_id,
        (spec.name ?? spec.title ?? "Character").slice(0, 80),
        JSON.stringify({ prompt: spec.prompt, runId, bodyAssetId: byRef.body ?? null, faceAssetId: byRef.face ?? null }),
        byRef.face ?? byRef.body ?? null,
        JSON.stringify([{ n: 1, assetIds, createdAt: now }]),
        now,
        run.created_by,
      )
      .run();
  }
  await env.DB.prepare("UPDATE runs SET character_id = ? WHERE id = ?").bind(id, runId).run();
  return id;
}
