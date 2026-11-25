/** Activity (M4): runs with cost and refunds, for `GET /api/runs` and GraphQL `runs`. */
import { z } from "zod";
import { MODEL_OVERLAY } from "@rolling/core";
import { itemSpec, paramsSummary, parseJson, type RunRow, type JobRow, type RunItemRow } from "./store";

export const RunsFilter = z.object({
  status: z.enum(["queued", "running", "done", "partial", "failed", "canceled"]).optional(),
  projectId: z.string().max(80).optional(),
  model: z.string().max(128).optional(),
  /** Epoch ms bounds on `createdAt`. */
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  first: z.coerce.number().int().min(1).max(100).default(30),
  after: z.string().max(200).optional(),
});
export type RunsFilter = z.infer<typeof RunsFilter>;

export type ActivityStatus = "queued" | "running" | "done" | "partial" | "failed" | "canceled";

export interface RunItemView {
  ref: string;
  nodeId: string | null;
  title: string | null;
  kind: string;
  model: string;
  modelName: string;
  status: RunItemRow["status"];
  jobId: string | null;
  progress: number | null;
  /** Quoted (held) credits. */
  credits: number;
  /** Charged credits once settled. */
  spent: number | null;
  refunded: number;
  assetId: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface RunView {
  id: string;
  /** Short reference shown under the name, e.g. `T-90412`. */
  ref: string;
  name: string;
  source: string;
  projectId: string | null;
  projectTitle: string | null;
  /** e.g. `Seedance 2.5 · 720p · 9:16 · 5s` (first item). */
  params: string;
  status: ActivityStatus;
  /** 0..1 while running. */
  progress: number | null;
  /** Quoted credits while queued/running, charged credits after. */
  credits: number;
  quoted: number;
  spent: number;
  refunded: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  items: RunItemView[];
  /** The normalized request it was quoted from: a tool `promptSpec` or a canvas scope (null for runs before 0015). */
  request: { promptSpec: unknown } | { scope: string; nodeIds?: string[] } | null;
  /** Tool of a spec run (`quick` = image/video), null for canvas runs. */
  tool: "quick" | "remix" | "avatar" | "character" | null;
  /** The run this one retried. */
  retryOf: string | null;
  /** Character runs: the Character saved from the outputs. */
  characterId: string | null;
  /** Failed, canceled or skipped items can be quoted again (`POST /api/runs/:id/retry`). */
  retryable: boolean;
}

export interface ActivityStats {
  usedThisMonth: number;
  usedLastMonth: number;
  running: number;
  successRate: number | null;
  runsLast7Days: number;
  refundedThisMonth: number;
}

export function activityStatus(s: RunRow["status"]): ActivityStatus {
  return s === "succeeded" ? "done" : s;
}

const STATUS_DB: Record<ActivityStatus, RunRow["status"]> = { queued: "queued", running: "running", done: "succeeded", partial: "partial", failed: "failed", canceled: "canceled" };

function modelName(id: string): string {
  return MODEL_OVERLAY[id]?.displayName ?? id;
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`);
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const [t, id] = atob(cursor).split(":");
    const createdAt = Number(t);
    return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

function monthStart(now: number, offset = 0): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
}

export async function activityStats(env: Env, workspaceId: string, now = Date.now()): Promise<ActivityStats> {
  const thisMonth = monthStart(now);
  const lastMonth = monthStart(now, -1);
  const week = now - 7 * 86_400_000;
  const r = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= ?2 THEN credits_spent END), 0) AS used,
       COALESCE(SUM(CASE WHEN created_at >= ?3 AND created_at < ?2 THEN credits_spent END), 0) AS used_last,
       COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 END), 0) AS running,
       COALESCE(SUM(CASE WHEN created_at >= ?4 THEN 1 END), 0) AS week_runs,
       COALESCE(SUM(CASE WHEN created_at >= ?2 THEN credits_refunded END), 0) AS refunded
     FROM runs WHERE workspace_id = ?1`,
  )
    .bind(workspaceId, thisMonth, lastMonth, week)
    .first<{ used: number; used_last: number; running: number; week_runs: number; refunded: number }>();
  const jobs = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 END), 0) AS ok, COALESCE(SUM(CASE WHEN status IN ('succeeded','failed') THEN 1 END), 0) AS done FROM jobs WHERE workspace_id = ? AND created_at >= ?",
  )
    .bind(workspaceId, week)
    .first<{ ok: number; done: number }>();
  return {
    usedThisMonth: r?.used ?? 0,
    usedLastMonth: r?.used_last ?? 0,
    running: r?.running ?? 0,
    successRate: jobs && jobs.done > 0 ? jobs.ok / jobs.done : null,
    runsLast7Days: r?.week_runs ?? 0,
    refundedThisMonth: r?.refunded ?? 0,
  };
}


type RunRowWithProject = RunRow & { project_title: string | null };

const TOOLS = new Set(["quick", "remix", "avatar", "character"]);

function requestOf(raw: string | null): RunView["request"] {
  const v = parseJson<Record<string, unknown> | null>(raw, null);
  if (!v) return null;
  if ("promptSpec" in v) return { promptSpec: v.promptSpec };
  if (typeof v.scope === "string") return { scope: v.scope, ...(Array.isArray(v.nodeIds) && { nodeIds: v.nodeIds as string[] }) };
  return null;
}

/** One run as Activity shows it. */
export function toRunView(r: RunRowWithProject, rows: RunItemRow[], jobs: ReadonlyMap<string, JobRow>): RunView {
  const its = rows.map((i): RunItemView => {
    const job = i.job_id ? jobs.get(i.job_id) : undefined;
    return {
      ref: i.ref,
      nodeId: i.node_id,
      title: i.title,
      kind: i.kind,
      model: job?.model ?? i.model,
      modelName: modelName(job?.model ?? i.model),
      status: i.status,
      jobId: i.job_id,
      progress: job?.progress ?? null,
      credits: i.credits,
      spent: job?.cost_actual ?? null,
      refunded: job && job.refunded > 0 ? job.cost_quote : 0,
      assetId: job?.asset_id ?? null,
      error: job?.error_message ?? i.error_message,
      errorCode: job?.error_code ?? i.error_code,
    };
  });
  const status = activityStatus(r.status);
  const firstRow = rows[0];
  const first = its[0];
  let settings = "";
  try {
    settings = firstRow ? paramsSummary(itemSpec(firstRow)) : "";
  } catch {
    settings = "";
  }
  const summary = first ? [first.modelName, settings].filter((x) => x !== "").join(" · ") : "";
  return {
    id: r.id,
    ref: `T-${r.id.slice(-5)}`,
    name: r.title ?? "Run",
    source: r.source,
    projectId: r.project_id,
    projectTitle: r.project_title,
    params: summary,
    status,
    progress: status === "running" || status === "queued" ? (its.length ? its.reduce((s, i) => s + (i.status === "succeeded" ? 1 : i.status === "running" ? (i.progress ?? 0) : 0), 0) / its.length : 0) : null,
    credits: status === "running" || status === "queued" ? r.credits_quoted : r.credits_spent,
    quoted: r.credits_quoted,
    spent: r.credits_spent,
    refunded: r.credits_refunded,
    error: its.find((i) => i.status === "failed")?.error ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    items: its,
    request: requestOf(r.request),
    tool: r.tool && TOOLS.has(r.tool) ? (r.tool as RunView["tool"]) : r.source === "quickCreate" ? "quick" : null,
    retryOf: r.retry_of,
    characterId: r.character_id,
    retryable:
      (status === "failed" || status === "partial" || status === "canceled") &&
      its.some((i) => i.status === "failed" || i.status === "canceled" || i.status === "skipped") &&
      (r.request !== null || r.source === "canvas"),
  };
}

/** `GET /api/runs/:id`: one run of the workspace, or null. */
export async function getRunView(env: Env, workspaceId: string, runId: string): Promise<RunView | null> {
  const r = await env.DB.prepare("SELECT r.*, p.title AS project_title FROM runs r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND r.workspace_id = ?")
    .bind(runId, workspaceId)
    .first<RunRowWithProject>();
  if (!r) return null;
  const rows = (await env.DB.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY ord").bind(runId).all<RunItemRow>()).results;
  const jobs = new Map((await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).all<JobRow>()).results.map((j) => [j.id, j]));
  return toRunView(r, rows, jobs);
}

export async function listRuns(env: Env, workspaceId: string, filter: RunsFilter): Promise<{ stats: ActivityStats; runs: RunView[]; nextCursor: string | null }> {
  const where: string[] = ["r.workspace_id = ?"];
  const binds: unknown[] = [workspaceId];
  if (filter.status) {
    where.push("r.status = ?");
    binds.push(STATUS_DB[filter.status]);
  }
  if (filter.projectId) {
    where.push("r.project_id = ?");
    binds.push(filter.projectId);
  }
  if (filter.model) {
    where.push("EXISTS (SELECT 1 FROM run_items i WHERE i.run_id = r.id AND i.model = ?)");
    binds.push(filter.model);
  }
  if (filter.from !== undefined) {
    where.push("r.created_at >= ?");
    binds.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("r.created_at < ?");
    binds.push(filter.to);
  }
  const cursor = filter.after ? decodeCursor(filter.after) : null;
  if (cursor) {
    where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = (
    await env.DB.prepare(
      `SELECT r.*, p.title AS project_title FROM runs r LEFT JOIN projects p ON p.id = r.project_id WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
      .bind(...binds, filter.first + 1)
      .all<RunRow & { project_title: string | null }>()
  ).results;
  const page = rows.slice(0, filter.first);
  const ids = page.map((r) => r.id);
  const items = new Map<string, RunItemRow[]>();
  const jobs = new Map<string, JobRow>();
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    for (const it of (await env.DB.prepare(`SELECT * FROM run_items WHERE run_id IN (${marks}) ORDER BY ord`).bind(...ids).all<RunItemRow>()).results) {
      const list = items.get(it.run_id) ?? [];
      list.push(it);
      items.set(it.run_id, list);
    }
    for (const j of (await env.DB.prepare(`SELECT * FROM jobs WHERE run_id IN (${marks})`).bind(...ids).all<JobRow>()).results) jobs.set(j.id, j);
  }
  const runs = page.map((r) => toRunView(r, items.get(r.id) ?? [], jobs));
  const last = page[page.length - 1];
  return {
    stats: await activityStats(env, workspaceId),
    runs,
    nextCursor: rows.length > filter.first && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
