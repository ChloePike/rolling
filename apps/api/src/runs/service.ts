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
import { planPromptSpec, planRun, type PlanItem, type PromptSpec, type RunScope } from "@rolling/core/generation";
import { newId } from "@rolling/core/ids";
import type { ImageSource } from "@rolling/core";
import type { AuthContext } from "../auth/context";
import { ApiError } from "../lib/errors";
import { isRoomError, roomFailure } from "../lib/room";
import type { RoomCaller } from "../lib/access";
import { loadCatalog } from "../models/catalog";
import { autoClassifier } from "./provider";
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
  autoVia?: string;
  dependsOn: string[];
}

export interface QuoteResponse {
  /** Null when nothing in the plan runs (only reuse / blocked / none rows). */
  quoteId: string | null;
  items: QuoteResponseItem[];
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number | null;
}

export type QuoteRequest =
  | { projectId: string; scope: RunScope; nodeIds?: string[]; caller: RoomCaller; matureAllowed: boolean }
  | { promptSpec: PromptSpec; projectId?: string | null };

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
    ...(i.autoVia && { autoVia: i.autoVia }),
    dependsOn: i.dependsOn,
  };
}

const LEDGER_BLOCK: Record<string, { code: string; reason: string }> = {
  unknown_model: { code: "unknown_model", reason: "This model is not available." },
  unpriced: { code: "unpriced", reason: "This model has no price for these settings." },
  resolution_locked: { code: "resolution_locked", reason: "This resolution needs a higher plan." },
};

async function assetOrigins(env: Env, workspaceId: string, spec: PromptSpec) {
  const ids = [
    spec.inputs.firstFrameAssetId,
    spec.inputs.lastFrameAssetId,
    spec.inputs.audioAssetId,
    ...(spec.inputs.referenceAssetIds ?? []),
    ...(spec.inputs.inputAssetIds ?? []),
  ].filter((x): x is string => !!x);
  const out = new Map<string, { origin: ImageSource; media: "image" | "video" | "audio" }>();
  if (ids.length === 0) return out;
  const rows = await env.DB.prepare(
    `SELECT id, kind, source, workspace_id FROM assets WHERE id IN (${ids.map(() => "?").join(",")}) AND (workspace_id = ? OR workspace_id IS NULL) AND status = 'ready'`,
  )
    .bind(...ids, workspaceId)
    .all<{ id: string; kind: string; source: string; workspace_id: string | null }>();
  for (const r of rows.results) {
    if (r.kind !== "image" && r.kind !== "video" && r.kind !== "audio") continue;
    const origin: ImageSource = r.source === "generated" || r.source === "public" || r.source === "builtin" ? r.source : r.source === "team" ? "team" : "upload";
    out.set(r.id, { origin, media: r.kind });
  }
  // Saved Characters count as platform assets (D-005).
  const chars = await env.DB.prepare(`SELECT cover_asset_id FROM characters WHERE workspace_id = ? AND cover_asset_id IN (${ids.map(() => "?").join(",")})`)
    .bind(workspaceId, ...ids)
    .all<{ cover_asset_id: string }>();
  for (const c of chars.results) {
    const a = out.get(c.cover_asset_id);
    if (a) out.set(c.cover_asset_id, { ...a, origin: "character" });
  }
  return out;
}

/** Plans and prices a run; stores the quote (10 minutes, D-006 CreditAccount TTL). */
export async function quoteRun(env: Env, auth: AuthContext, req: QuoteRequest): Promise<QuoteResponse> {
  const catalog = await loadCatalog(env);
  const classify = await autoClassifier(env, auth.isMember);
  let items: PlanItem[];
  let projectId: string | null = null;
  let scope: string;
  if ("promptSpec" in req) {
    scope = "spec";
    projectId = req.projectId ?? null;
    const origins = await assetOrigins(env, auth.workspaceId, req.promptSpec);
    items = (await planPromptSpec({ spec: req.promptSpec, catalog, ctx: { plan: auth.plan, matureAllowed: auth.matureAllowed }, classify, assetOrigins: origins })).items;
  } else {
    scope = req.scope;
    projectId = req.projectId;
    const room = ports(env).room(req.projectId);
    const [structural, graph] = await Promise.all([room.planRun(req.caller, { scope: req.scope, ...(req.nodeIds && { nodeIds: req.nodeIds }) }), room.getGraph(req.caller)]);
    if (isRoomError(structural)) roomFailure(structural);
    if (isRoomError(graph)) roomFailure(graph);
    if (req.nodeIds?.some((id) => !graph.state.nodes.some((n) => n.id === id))) {
      throw new ApiError(404, "NOT_FOUND", "Node not found", { nodeIds: req.nodeIds });
    }
    items = (await planRun({ graph: graph.state, structural: structural.items, catalog, ctx: { plan: auth.plan, matureAllowed: req.matureAllowed }, classify })).items;
  }

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
    await env.DB.prepare("INSERT INTO quotes (id, workspace_id, project_id, items, total, expires_at, created_by, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(quoteId, auth.workspaceId, projectId, JSON.stringify(stored), total, expiresAt, auth.userId, scope, Date.now())
      .run();
  }
  return { quoteId, items: stored.map(toResponseItem), total, balance, balanceAfter: balance - total, expiresAt };
}

const LEDGER_API: Partial<Record<LedgerErrorCode, [402 | 403 | 409 | 429, "NO_PLAN" | "INSUFFICIENT_CREDITS" | "MEMBER_LIMIT_REACHED" | "QUOTE_EXPIRED" | "CONCURRENCY_LIMIT"]>> = {
  NO_PLAN: [402, "NO_PLAN"],
  INSUFFICIENT_CREDITS: [402, "INSUFFICIENT_CREDITS"],
  MEMBER_LIMIT_REACHED: [403, "MEMBER_LIMIT_REACHED"],
  QUOTE_EXPIRED: [409, "QUOTE_EXPIRED"],
};

/** Starts a run from a quote. Idempotent per quote: a second start returns the same run. */
export async function startRun(env: Env, auth: AuthContext, quoteId: string, rawOptions: RunOptions = {}): Promise<{ runId: string; status: RunRow["status"] }> {
  const quote = await env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND workspace_id = ?").bind(quoteId, auth.workspaceId).first<QuoteRow>();
  if (!quote) throw new ApiError(404, "NOT_FOUND", "Quote not found", { quoteId });
  const existing = await env.DB.prepare("SELECT id, status FROM runs WHERE quote_id = ?").bind(quoteId).first<{ id: string; status: RunRow["status"] }>();
  if (existing) return { runId: existing.id, status: existing.status };
  const now = Date.now();
  if (quote.expires_at <= now) throw new ApiError(409, "QUOTE_EXPIRED", "Quote expired", { quoteId, expiresAt: quote.expires_at });

  const items = parseJson<StoredQuoteItem[]>(quote.items, []).filter((i) => i.action === "run" && i.spec && i.model);
  if (items.length === 0) throw new ApiError(409, "CONFLICT", "Nothing to run in this quote", { quoteId });
  const total = items.reduce((s, i) => s + i.credits, 0);
  const credits = ports(env).credits(auth.workspaceId);
  const b = await credits.balance();
  if (total > b.plan + b.purchased) {
    throw new ApiError(402, "INSUFFICIENT_CREDITS", "Not enough credits", { needed: total, balance: b.plan + b.purchased });
  }
  // Staging-only failure injection (canvas golden path, step 7).
  const options: RunOptions = env.ENVIRONMENT === "production" ? {} : rawOptions;
  const runId = newId("run");
  const first = items[0]!;
  const title = items.length === 1 ? first.title : `${first.title} +${items.length - 1}`;
  const statements = [
    env.DB.prepare(
      "INSERT INTO runs (id, workspace_id, project_id, quote_id, scope, status, created_by, created_at, title, source, credits_quoted, options, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
    ).bind(runId, auth.workspaceId, quote.project_id, quoteId, quote.scope ?? "node", auth.userId, now, title, quote.scope === "spec" ? "quickCreate" : "canvas", total, JSON.stringify(options), now),
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
      if (room && item.node_id) await quietly("markFailed", () => room.markFailed({ nodeId: item.node_id!, jobId: "", refunded: 0, reason: "An input failed." }));
      continue;
    }
    if (!deps.every((d) => status.get(d) === "succeeded")) continue;

    const held = await credits.hold({
      quoteId: run.quote_id,
      runId,
      userId: run.created_by,
      idemKey: `hold:${runId}:${item.ref}`,
      refs: [item.ref],
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
    await startJob(env, run, item, job.jobId, job.credits);
    status.set(item.ref, "running");
    out.started++;
    changed = true;
    await pushCredits(env, run, held.value.balance);
  }
  if (changed || items.every((i) => i.status !== "pending")) await refreshRun(env.DB, runId);
  if (changed) await quietly("activity", () => p.hub(run.created_by).broadcast("activity.updated", { runId }));
  return out;
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

/** Live balance push (D-003): the user socket and, for canvas runs, the project socket. */
export async function pushCredits(env: Env, run: Pick<RunRow, "created_by" | "project_id">, balance: { plan: number; purchased: number; held: number }): Promise<void> {
  const payload = { balance: balance.plan + balance.purchased, held: balance.held, plan: balance.plan, purchased: balance.purchased };
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
