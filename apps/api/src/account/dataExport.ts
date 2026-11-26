/**
 * Self-serve data export (Settings → Account → Export my data, GDPR access and
 * portability). `POST /api/account/export` records a `data_exports` row (one
 * per `DATA_EXPORT_COOLDOWN_HOURS` per user) and starts `DataExportWorkflow`,
 * which builds the bundle piece by piece into private R2 and emails a signed
 * download link valid for `DATA_EXPORT_LINK_TTL_DAYS`.
 *
 * Bundle (ZIP, stored entries, JSON files):
 * - `README.txt`;
 * - `profile.json`: account, preferences, sign-in methods, sessions (no tokens);
 * - `workspaces.json`: workspaces the user belongs to and their role;
 * - `projects/<id>.json`: graph and timeline from each ProjectRoom (projects the user made, and every project of workspaces they own);
 * - `assets/page-<n>.json`: asset list with signed URLs valid as long as the link;
 * - `agent-threads/<id>.json`: the user's agent threads (messages, proposals);
 * - `runs.json`: generation history the user started, with their requests;
 * - `credit-ledger.json`: ledger lines the user made, and every line of workspaces they own.
 *
 * Parts are written to `<dir>/parts/` by separate workflow steps (step results
 * stay small) and zipped at the end; the bundle lives under the user's
 * personal workspace prefix, so account deletion sweeps it too.
 */
import { newId } from "@rolling/core/ids";
import { keyBelongsTo } from "@rolling/core/media";
import { DATA_EXPORT_COOLDOWN_HOURS, DATA_EXPORT_LINK_TTL_DAYS } from "@rolling/core/privacy";
import { zipStore, type ZipEntry } from "@rolling/core/zip";
import { enqueueEmail } from "../auth/email";
import { personalWorkspaceId } from "../auth/workspace";
import { ApiError } from "../lib/errors";
import { signMediaUrl } from "../lib/mediaUrls";
import { publicMediaUrl } from "../routes/media";

const HOUR_MS = 3_600_000;
const LINK_TTL_SECONDS = DATA_EXPORT_LINK_TTL_DAYS * 86_400;
/** Caps that keep each step and the final ZIP within Worker memory. */
export const EXPORT_MAX_PROJECTS = 2000;
export const EXPORT_MAX_THREADS = 2000;
export const EXPORT_ASSET_PAGE = 1000;
const EXPORT_MAX_LEDGER = 50_000;
const EXPORT_MAX_RUNS = 20_000;

export type DataExportStatus = "queued" | "running" | "done" | "failed" | "expired";

export interface DataExportRow {
  id: string;
  user_id: string;
  status: DataExportStatus;
  r2_key: string | null;
  size: number | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  expires_at: number | null;
}

export interface DataExportView {
  id: string;
  status: DataExportStatus;
  createdAt: number;
  finishedAt: number | null;
  /** When the emailed link stops working (done exports). */
  expiresAt: number | null;
  /** When the user may ask for the next export. */
  nextAvailableAt: number;
}

export function dataExportView(row: DataExportRow): DataExportView {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    nextAvailableAt: row.status === "failed" ? row.created_at : row.created_at + DATA_EXPORT_COOLDOWN_HOURS * HOUR_MS,
  };
}

export async function loadDataExport(env: Env, id: string): Promise<DataExportRow | null> {
  return env.DB.prepare("SELECT * FROM data_exports WHERE id = ?").bind(id).first<DataExportRow>();
}

export async function latestDataExport(env: Env, userId: string): Promise<DataExportRow | null> {
  return env.DB.prepare("SELECT * FROM data_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(userId).first<DataExportRow>();
}

/**
 * Records a new export unless one (not failed) was asked for in the last
 * `DATA_EXPORT_COOLDOWN_HOURS` (atomic: concurrent requests cannot both pass),
 * then starts the workflow. 429 `RATE_LIMITED` with `retryAfter` (seconds) and `nextAvailableAt`.
 */
export async function requestDataExport(env: Env, userId: string, now = Date.now()): Promise<DataExportRow> {
  const id = newId("dataExport");
  const inserted = await env.DB.prepare(
    `INSERT INTO data_exports (id, user_id, status, created_at) SELECT ?1, ?2, 'queued', ?3
     WHERE NOT EXISTS (SELECT 1 FROM data_exports WHERE user_id = ?2 AND status <> 'failed' AND created_at > ?4) RETURNING id`,
  )
    .bind(id, userId, now, now - DATA_EXPORT_COOLDOWN_HOURS * HOUR_MS)
    .first<{ id: string }>();
  if (!inserted) {
    const last = await latestDataExport(env, userId);
    const next = last ? dataExportView(last).nextAvailableAt : now;
    throw new ApiError(429, "RATE_LIMITED", `You can export your data once every ${DATA_EXPORT_COOLDOWN_HOURS} hours`, {
      retryAfter: Math.max(1, Math.ceil((next - now) / 1000)),
      nextAvailableAt: next,
    });
  }
  try {
    await env.DATA_EXPORT.create({ id, params: { exportId: id } });
  } catch (err) {
    console.error(JSON.stringify({ msg: "data export: workflow start failed", exportId: id, error: String(err).slice(0, 300) }));
    await env.DB.prepare("UPDATE data_exports SET status = 'failed', error = 'start_failed', finished_at = ? WHERE id = ?").bind(now, id).run();
    throw new ApiError(500, "INTERNAL", "We couldn't start your export. Try again in a minute.");
  }
  return (await loadDataExport(env, id))!;
}

// ---------------------------------------------------------------- bundle parts

export function exportDir(row: Pick<DataExportRow, "id" | "user_id">): string {
  return `ws/${personalWorkspaceId(row.user_id)}/account-exports/${row.id}`;
}

async function putPart(env: Env, row: DataExportRow, name: string, value: unknown): Promise<void> {
  await env.MEDIA.put(`${exportDir(row)}/parts/${name}`, JSON.stringify(value, null, 2), { httpMetadata: { contentType: "application/json" } });
}

interface Membership {
  workspace_id: string;
  name: string;
  kind: "personal" | "team";
  role: string;
}

async function memberships(env: Env, userId: string): Promise<Membership[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.workspace_id, w.name, w.kind, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND w.deleted_at IS NULL ORDER BY w.created_at`,
  )
    .bind(userId)
    .all<Membership>();
  return results;
}

const owned = (ms: Membership[]) => ms.filter((m) => m.role === "owner").map((m) => m.workspace_id);
const qs = (n: number) => Array.from({ length: n }, () => "?").join(",");

export interface ExportPlan {
  projects: Array<{ id: string; workspaceId: string }>;
  threads: Array<{ id: string; workspaceId: string }>;
  truncated: { projects: boolean; threads: boolean };
}

/** Profile, workspaces, runs and ledger parts; returns the projects and threads to export in later steps. */
export async function writeAccountParts(env: Env, row: DataExportRow): Promise<ExportPlan> {
  const userId = row.user_id;
  const db = env.DB;
  const ms = await memberships(env, userId);
  const own = owned(ms);
  const user = await db.prepare("SELECT id, name, email, email_verified, image, created_at, updated_at FROM users WHERE id = ?").bind(userId).first();
  const prefs = await db.prepare("SELECT * FROM user_prefs WHERE user_id = ?").bind(userId).first<Record<string, unknown>>();
  const accounts = await db.prepare("SELECT provider_id, account_id, created_at FROM accounts WHERE user_id = ?").bind(userId).all();
  const sessions = await db.prepare("SELECT created_at, updated_at, expires_at, ip_address, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at").bind(userId).all();
  await putPart(env, row, "profile.json", {
    exportedAt: new Date().toISOString(),
    user,
    preferences: prefs ? { ...prefs, notifications: safeJson(prefs.notifications) } : null,
    signInMethods: accounts.results,
    sessions: sessions.results,
  });
  await putPart(env, row, "workspaces.json", ms.map((m) => ({ id: m.workspace_id, name: m.name, kind: m.kind, role: m.role })));

  const memberIds = ms.map((m) => m.workspace_id);
  const projects = memberIds.length
    ? (
        await db
          .prepare(
            `SELECT id, workspace_id FROM projects WHERE workspace_id IN (${qs(memberIds.length)})
             AND (created_by = ? ${own.length ? `OR workspace_id IN (${qs(own.length)})` : ""}) ORDER BY updated_at DESC LIMIT ?`,
          )
          .bind(...memberIds, userId, ...own, EXPORT_MAX_PROJECTS + 1)
          .all<{ id: string; workspace_id: string }>()
      ).results
    : [];
  const threads = memberIds.length
    ? (
        await db
          .prepare(`SELECT id, workspace_id FROM agent_threads WHERE created_by = ? AND workspace_id IN (${qs(memberIds.length)}) ORDER BY updated_at DESC LIMIT ?`)
          .bind(userId, ...memberIds, EXPORT_MAX_THREADS + 1)
          .all<{ id: string; workspace_id: string }>()
      ).results
    : [];

  const runs = await db
    .prepare("SELECT id, workspace_id, project_id, title, source, tool, status, credits_quoted, credits_spent, credits_refunded, request, created_at, finished_at FROM runs WHERE created_by = ? ORDER BY created_at LIMIT ?")
    .bind(userId, EXPORT_MAX_RUNS)
    .all<Record<string, unknown>>();
  await putPart(env, row, "runs.json", runs.results.map((r) => ({ ...r, request: safeJson(r.request) })));

  const ledger = await db
    .prepare(
      `SELECT id, workspace_id, user_id, kind, bucket, amount, run_id, job_id, stripe_ref, note, created_at FROM ledger_lines
       WHERE user_id = ? ${own.length ? `OR workspace_id IN (${qs(own.length)})` : ""} ORDER BY created_at LIMIT ?`,
    )
    .bind(userId, ...own, EXPORT_MAX_LEDGER)
    .all();
  await putPart(env, row, "credit-ledger.json", ledger.results);

  return {
    projects: projects.slice(0, EXPORT_MAX_PROJECTS).map((p) => ({ id: p.id, workspaceId: p.workspace_id })),
    threads: threads.slice(0, EXPORT_MAX_THREADS).map((t) => ({ id: t.id, workspaceId: t.workspace_id })),
    truncated: { projects: projects.length > EXPORT_MAX_PROJECTS, threads: threads.length > EXPORT_MAX_THREADS },
  };
}

interface SnapshotApi {
  getSnapshot(caller: { userId: string; workspaceId: string; canEdit: boolean }): Promise<unknown>;
}
interface ThreadApi {
  get(workspaceId: string): Promise<unknown>;
}

/** One part per project: the ProjectRoom snapshot (canvases, nodes, edges, groups, timeline). */
export async function writeProjectParts(env: Env, row: DataExportRow, projects: ExportPlan["projects"]): Promise<void> {
  for (const p of projects) {
    const room = env.PROJECT.get(env.PROJECT.idFromName(p.id)) as unknown as SnapshotApi;
    const snapshot = await room.getSnapshot({ userId: row.user_id, workspaceId: p.workspaceId, canEdit: false });
    await putPart(env, row, `projects/${p.id}.json`, snapshot);
  }
}

/** One part per agent thread: messages and proposals from the AgentSession. */
export async function writeThreadParts(env: Env, row: DataExportRow, threads: ExportPlan["threads"]): Promise<void> {
  for (const t of threads) {
    const view = await (env.AGENT.get(env.AGENT.idFromName(t.id)) as unknown as ThreadApi).get(t.workspaceId);
    await putPart(env, row, `agent-threads/${t.id}.json`, view);
  }
}

interface AssetExportRow {
  id: string;
  workspace_id: string | null;
  kind: string;
  source: string;
  name: string;
  r2_key: string;
  meta: string;
  project_id: string | null;
  created_by: string | null;
  created_at: number;
  status: string;
  mature: number;
  rating: string | null;
  size: number | null;
  content_type: string | null;
}

/**
 * One page of assets (the user's own, and every asset of workspaces they own),
 * keyset-paged by id. URLs are signed for the link's lifetime; mature items
 * get a URL only when the user has mature content turned on (D-005).
 */
export async function writeAssetPage(env: Env, row: DataExportRow, page: number, after: string): Promise<{ next: string | null }> {
  const ms = await memberships(env, row.user_id);
  const own = owned(ms);
  const prefs = await env.DB.prepare("SELECT mature_content FROM user_prefs WHERE user_id = ?").bind(row.user_id).first<{ mature_content: number }>();
  const mayViewMature = prefs?.mature_content === 1;
  const { results } = await env.DB.prepare(
    `SELECT id, workspace_id, kind, source, name, r2_key, meta, project_id, created_by, created_at, status, mature, rating, size, content_type FROM assets
     WHERE id > ? AND (created_by = ? ${own.length ? `OR workspace_id IN (${qs(own.length)})` : ""}) ORDER BY id LIMIT ?`,
  )
    .bind(after, row.user_id, ...own, EXPORT_ASSET_PAGE)
    .all<AssetExportRow>();
  if (!results.length && page > 1) return { next: null };
  const items = [];
  for (const a of results) {
    let url: string | null = null;
    if (a.status === "ready" && (a.mature !== 1 || mayViewMature)) {
      if (a.r2_key.startsWith("public/") && a.mature !== 1) url = publicMediaUrl(a.r2_key, env.PUBLIC_MEDIA_BASE_URL);
      else if (a.workspace_id && keyBelongsTo(a.r2_key, a.workspace_id)) url = await signMediaUrl(env, a.r2_key, { workspaceId: a.workspace_id, expiresIn: LINK_TTL_SECONDS, absolute: true });
    }
    items.push({
      id: a.id,
      workspaceId: a.workspace_id,
      kind: a.kind,
      source: a.source,
      name: a.name,
      projectId: a.project_id,
      createdBy: a.created_by,
      createdAt: a.created_at,
      status: a.status,
      rating: a.rating,
      mature: a.mature === 1,
      size: a.size,
      contentType: a.content_type,
      meta: safeJson(a.meta),
      url,
      urlExpiresAt: url ? Date.now() + LINK_TTL_SECONDS * 1000 : null,
    });
  }
  await putPart(env, row, `assets/page-${String(page).padStart(3, "0")}.json`, items);
  return { next: results.length === EXPORT_ASSET_PAGE ? results[results.length - 1]!.id : null };
}

function readme(appName: string, truncated: ExportPlan["truncated"]): string {
  return [
    `${appName} data export`,
    "",
    "profile.json         Your account, preferences, sign-in methods and sessions.",
    "workspaces.json      Workspaces you belong to and your role in each.",
    "projects/            One file per project: canvas graph, versions and timeline.",
    "assets/              Your uploads and generated media, with download links.",
    `                     The links work for ${DATA_EXPORT_LINK_TTL_DAYS} days.`,
    "agent-threads/       Your conversations with the agent and its proposals.",
    "runs.json            Generations you started and what you asked for.",
    "credit-ledger.json   Credits granted, bought, spent and refunded.",
    ...(truncated.projects || truncated.threads ? ["", "This export was capped; email privacy@rolling.actor for the rest."] : []),
    "",
  ].join("\n");
}

/** Zips every part into the bundle and removes the parts. Returns the bundle key and size. */
export async function assembleBundle(env: Env, row: DataExportRow, truncated: ExportPlan["truncated"], appName = "Rolling"): Promise<{ key: string; size: number }> {
  const dir = exportDir(row);
  const prefix = `${dir}/parts/`;
  const entries: ZipEntry[] = [{ name: "README.txt", data: new TextEncoder().encode(readme(appName, truncated)) }];
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const o of list.objects) keys.push(o.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  keys.sort();
  for (const key of keys) {
    const obj = await env.MEDIA.get(key);
    if (obj) entries.push({ name: key.slice(prefix.length), data: new Uint8Array(await obj.arrayBuffer()) });
  }
  const zip = zipStore(entries);
  const date = new Date(row.created_at).toISOString().slice(0, 10);
  const key = `${dir}/rolling-data-${date}.zip`;
  await env.MEDIA.put(key, zip, { httpMetadata: { contentType: "application/zip", contentDisposition: `attachment; filename="rolling-data-${date}.zip"` } });
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
  return { key, size: zip.byteLength };
}

/** Marks the export done and emails the signed link (idempotent per export: the email queue dedupes by message). */
export async function deliverBundle(env: Env, row: DataExportRow, bundle: { key: string; size: number }, now = Date.now()): Promise<string> {
  const url = await signMediaUrl(env, bundle.key, { workspaceId: personalWorkspaceId(row.user_id), expiresIn: LINK_TTL_SECONDS, absolute: true });
  await env.DB.prepare("UPDATE data_exports SET status = 'done', r2_key = ?, size = ?, finished_at = ?, expires_at = ? WHERE id = ?")
    .bind(bundle.key, bundle.size, now, now + LINK_TTL_SECONDS * 1000, row.id)
    .run();
  await enqueueEmail(env, { userId: row.user_id, template: "data-export-ready", data: { downloadUrl: url, expiresInDays: DATA_EXPORT_LINK_TTL_DAYS } });
  return url;
}

export async function setDataExportStatus(env: Env, id: string, status: DataExportStatus, error: string | null = null): Promise<void> {
  const finished = status === "failed" ? Date.now() : null;
  await env.DB.prepare("UPDATE data_exports SET status = ?, error = COALESCE(?, error), finished_at = COALESCE(?, finished_at) WHERE id = ?").bind(status, error, finished, id).run();
}

/** Whole export inline (tests, ops); the workflow runs the same functions one step at a time. */
export async function runDataExport(env: Env, exportId: string): Promise<string | null> {
  const row = await loadDataExport(env, exportId);
  if (!row || row.status === "done") return null;
  await setDataExportStatus(env, row.id, "running");
  const plan = await writeAccountParts(env, row);
  await writeProjectParts(env, row, plan.projects);
  await writeThreadParts(env, row, plan.threads);
  let after = "";
  for (let page = 1; ; page++) {
    const r = await writeAssetPage(env, row, page, after);
    if (!r.next) break;
    after = r.next;
  }
  return deliverBundle(env, row, await assembleBundle(env, row, plan.truncated, env.APP_NAME || "Rolling"));
}

/** Daily purge: bundles past their link lifetime are deleted from R2 and marked expired. */
export async function expireDataExports(env: Env, before: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, user_id, r2_key FROM data_exports WHERE status = 'done' AND created_at < ? LIMIT 200").bind(before).all<{ id: string; user_id: string; r2_key: string | null }>();
  for (const r of results) {
    const dir = exportDir(r);
    const list = await env.MEDIA.list({ prefix: `${dir}/`, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (r.r2_key && !keys.includes(r.r2_key)) keys.push(r.r2_key);
    if (keys.length) await env.MEDIA.delete(keys);
    await env.DB.prepare("UPDATE data_exports SET status = 'expired', r2_key = NULL WHERE id = ?").bind(r.id).run();
  }
  return results.length;
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
