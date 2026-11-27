/**
 * The trust & safety queue (D-026): safety cases from hard-limit events,
 * user reports, appeals, DMCA notices and counter-notices, and restricted
 * child-safety cases (D-027). Reviewer actions change content, accounts and
 * case status; every action writes an `admin_audit` row in the same batch.
 */
import { newId } from "@rolling/core/ids";
import {
  actionAllowed,
  addBusinessDays,
  COUNTER_NOTICE_WAIT_BUSINESS_DAYS,
  DEFAULT_NOTICE,
  PRIORITY,
  reportPriority,
  type AppealInput,
  type CaseActionInput,
  type CounterNoticeInput,
  type DmcaNoticeInput,
  type ReportInput,
} from "@rolling/core/ops/trust";
import { staffCan, type StaffRole } from "@rolling/core/ops/staff";
import { ApiError } from "../lib/errors";
import { auditStatement, type Actor } from "./audit";
import { evidenceRefs, openChildSafetyCase, refreshPacket } from "./childSafety";
import { notifyUser, suspend, unsuspend } from "./suspension";

export interface CaseRow {
  id: string;
  kind: "safety" | "report" | "appeal" | "dmca" | "counter_notice" | "child_safety";
  status: "open" | "actioned" | "dismissed" | "closed";
  priority: number;
  workspace_id: string | null;
  user_id: string | null;
  target_kind: string | null;
  target_id: string | null;
  target_url: string | null;
  category: string | null;
  details: string | null;
  reporter_user_id: string | null;
  reporter_email: string | null;
  data: string;
  dedupe_key: string | null;
  related_case_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

function parse(data: string | null): Record<string, unknown> {
  try {
    return JSON.parse(data || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------- creation

/**
 * A hard-limit event lands in the workspace's open safety case (one per
 * workspace). Flagged workspaces (SAFETY_REVIEW) are high priority.
 */
export async function noteSafetyEvent(env: Env, input: { workspaceId: string; userId: string | null; eventId: string; codes: string[]; flagged: boolean }): Promise<void> {
  const now = Date.now();
  const priority = input.flagged ? PRIORITY.high : PRIORITY.normal;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO trust_cases (id, kind, status, priority, workspace_id, user_id, category, data, dedupe_key, created_at, updated_at)
     VALUES (?, 'safety', 'open', ?, ?, ?, 'hard_limit', ?, ?, ?, ?)`,
  )
    .bind(newId("case"), priority, input.workspaceId, input.userId, JSON.stringify({ lastEventId: input.eventId, codes: input.codes }), `safety:${input.workspaceId}`, now, now)
    .run();
  await env.DB.prepare(
    "UPDATE trust_cases SET priority = MAX(priority, ?), updated_at = ?, user_id = COALESCE(user_id, ?), data = json_set(data, '$.lastEventId', ?) WHERE dedupe_key = ? AND status = 'open'",
  )
    .bind(priority, now, input.userId, input.eventId, `safety:${input.workspaceId}`)
    .run();
}

/** The owner of a share link or profile, for a report's subject. */
async function subjectOf(env: Env, kind: string, id: string | undefined): Promise<{ workspaceId: string | null; userId: string | null; found: boolean }> {
  if (!id) return { workspaceId: null, userId: null, found: false };
  if (kind === "share") {
    const r = await env.DB.prepare("SELECT workspace_id, created_by FROM share_links WHERE id = ?").bind(id).first<{ workspace_id: string | null; created_by: string | null }>();
    return { workspaceId: r?.workspace_id ?? null, userId: r?.created_by ?? null, found: !!r };
  }
  if (kind === "profile") {
    const r = await env.DB.prepare("SELECT user_id FROM user_prefs WHERE lower(handle) = ?").bind(id.toLowerCase()).first<{ user_id: string }>();
    return { workspaceId: null, userId: r?.user_id ?? null, found: !!r };
  }
  return { workspaceId: null, userId: null, found: false };
}

/** `share` and `profile` ids from a pasted app URL (`/share/<id>`, `/u/<handle>`). */
export function targetFromUrl(raw: string): { kind: "share" | "profile"; id: string } | null {
  try {
    const u = new URL(raw);
    const share = /^\/share\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    if (share) return { kind: "share", id: share[1]! };
    const profile = /^\/u\/([A-Za-z0-9_.-]+)\/?$/.exec(u.pathname);
    if (profile) return { kind: "profile", id: profile[1]! };
  } catch {
    // not a URL
  }
  return null;
}

export async function createReport(env: Env, input: ReportInput, reporter: { userId: string | null; email: string | null }): Promise<{ caseId: string }> {
  const parsed = input.targetKind === "url" && input.url ? targetFromUrl(input.url) : null;
  const kind = parsed?.kind ?? input.targetKind;
  const targetId = parsed?.id ?? input.targetId;
  const subject = await subjectOf(env, kind, targetId);
  const id = newId("case");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO trust_cases (id, kind, status, priority, workspace_id, user_id, target_kind, target_id, target_url, category, details, reporter_user_id, reporter_email, data, created_at, updated_at)
     VALUES (?, 'report', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      reportPriority(input.category),
      subject.workspaceId,
      subject.userId,
      kind,
      targetId ?? null,
      input.url ?? null,
      input.category,
      input.details || null,
      reporter.userId,
      reporter.email ?? input.email ?? null,
      JSON.stringify({ targetFound: subject.found }),
      now,
      now,
    )
    .run();
  return { caseId: id };
}

export async function createAppeal(env: Env, auth: { userId: string; workspaceId: string; email: string | null }, input: AppealInput): Promise<{ caseId: string }> {
  let suspensionId = input.suspensionId ?? null;
  if (input.subject === "suspension") {
    const s = suspensionId
      ? await env.DB.prepare("SELECT id, subject_kind, subject_id FROM suspensions WHERE id = ? AND lifted_at IS NULL").bind(suspensionId).first<{ id: string; subject_kind: string; subject_id: string }>()
      : await env.DB.prepare(
          "SELECT id, subject_kind, subject_id FROM suspensions WHERE lifted_at IS NULL AND ((subject_kind = 'user' AND subject_id = ?1) OR (subject_kind = 'workspace' AND subject_id = ?2)) ORDER BY created_at DESC LIMIT 1",
        )
          .bind(auth.userId, auth.workspaceId)
          .first<{ id: string; subject_kind: string; subject_id: string }>();
    if (!s || (s.subject_kind === "user" && s.subject_id !== auth.userId) || (s.subject_kind === "workspace" && s.subject_id !== auth.workspaceId)) {
      throw new ApiError(404, "NOT_FOUND", "No active suspension to appeal");
    }
    suspensionId = s.id;
  }
  if (input.subject === "block" && input.runId) {
    const run = await env.DB.prepare("SELECT workspace_id FROM runs WHERE id = ?").bind(input.runId).first<{ workspace_id: string }>();
    if (!run || run.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Run not found");
  }
  const id = newId("case");
  const now = Date.now();
  const dedupe = `appeal:${auth.userId}:${suspensionId ?? input.jobId ?? input.runId ?? "general"}`;
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO trust_cases (id, kind, status, priority, workspace_id, user_id, target_kind, target_id, category, details, reporter_user_id, reporter_email, data, dedupe_key, created_at, updated_at)
     VALUES (?, 'appeal', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.subject === "suspension" ? PRIORITY.high : PRIORITY.normal,
      auth.workspaceId,
      auth.userId,
      input.subject === "suspension" ? "suspension" : input.jobId ? "job" : "run",
      suspensionId ?? input.jobId ?? input.runId ?? null,
      input.subject,
      input.message,
      auth.userId,
      auth.email,
      JSON.stringify({ suspensionId, runId: input.runId ?? null, jobId: input.jobId ?? null }),
      dedupe,
      now,
      now,
    )
    .run();
  if ((r.meta.changes ?? 0) === 0) {
    // One open appeal per subject: the new message is added to it.
    const open = await env.DB.prepare("SELECT id FROM trust_cases WHERE dedupe_key = ? AND status = 'open'").bind(dedupe).first<{ id: string }>();
    if (open) {
      await env.DB.prepare("UPDATE trust_cases SET details = substr(COALESCE(details, '') || char(10) || char(10) || ?, 1, 8000), updated_at = ? WHERE id = ?").bind(input.message, now, open.id).run();
      return { caseId: open.id };
    }
  }
  return { caseId: id };
}

export async function createDmcaNotice(env: Env, input: DmcaNoticeInput): Promise<{ caseId: string }> {
  const targets = input.infringingUrls.map((u) => ({ url: u, target: targetFromUrl(u) }));
  const first = targets.find((t) => t.target)?.target ?? null;
  const subject = first ? await subjectOf(env, first.kind, first.id) : { workspaceId: null, userId: null, found: false };
  const id = newId("case");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO trust_cases (id, kind, status, priority, workspace_id, user_id, target_kind, target_id, target_url, category, details, reporter_email, data, created_at, updated_at)
     VALUES (?, 'dmca', 'open', ?, ?, ?, ?, ?, ?, 'copyright', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      PRIORITY.normal,
      subject.workspaceId,
      subject.userId,
      first?.kind ?? "url",
      first?.id ?? null,
      input.infringingUrls[0] ?? null,
      input.workDescription,
      input.email,
      JSON.stringify({ notice: input, targets: targets.map((t) => ({ url: t.url, kind: t.target?.kind ?? null, id: t.target?.id ?? null })), receivedAt: now }),
      now,
      now,
    )
    .run();
  return { caseId: id };
}

export async function createCounterNotice(env: Env, auth: { userId: string; workspaceId: string }, input: CounterNoticeInput): Promise<{ caseId: string }> {
  const dmca = await env.DB.prepare("SELECT * FROM trust_cases WHERE id = ? AND kind = 'dmca'").bind(input.caseId).first<CaseRow>();
  // Only the person whose content was removed may counter (404 otherwise: case ids are not secrets, but they are not shared).
  if (!dmca || dmca.user_id !== auth.userId || dmca.resolution !== "takedown") throw new ApiError(404, "NOT_FOUND", "No removal to counter");
  const id = newId("case");
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO trust_cases (id, kind, status, priority, workspace_id, user_id, target_kind, target_id, category, details, reporter_user_id, reporter_email, data, dedupe_key, related_case_id, created_at, updated_at)
     VALUES (?, 'counter_notice', 'open', ?, ?, ?, ?, ?, 'copyright', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      PRIORITY.high,
      dmca.workspace_id,
      auth.userId,
      dmca.target_kind,
      dmca.target_id,
      input.materialDescription,
      auth.userId,
      input.email,
      JSON.stringify({ counter: input, receivedAt: now }),
      `counter:${dmca.id}`,
      dmca.id,
      now,
      now,
    )
    .run();
  if ((r.meta.changes ?? 0) === 0) throw new ApiError(409, "CONFLICT", "A counter-notice for this removal is already open");
  return { caseId: id };
}

// ----------------------------------------------------------------------------- reads

export interface QueueFilter {
  status?: "open" | "actioned" | "dismissed" | "closed" | "all";
  kind?: CaseRow["kind"];
  limit?: number;
}

/** Child-safety cases are listed only for roles with `child_safety`. */
export async function listCases(env: Env, role: StaffRole, filter: QueueFilter = {}): Promise<CaseRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = filter.status ?? "open";
  if (status !== "all") {
    where.push("status = ?");
    binds.push(status);
  }
  if (filter.kind) {
    where.push("kind = ?");
    binds.push(filter.kind);
  }
  if (!staffCan(role, "child_safety")) where.push("kind <> 'child_safety'");
  const sql = `SELECT * FROM trust_cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY priority DESC, created_at ASC LIMIT ?`;
  const rows = await env.DB.prepare(sql)
    .bind(...binds, Math.min(200, filter.limit ?? 100))
    .all<CaseRow>();
  return rows.results;
}

export async function caseRow(env: Env, id: string): Promise<CaseRow | null> {
  return env.DB.prepare("SELECT * FROM trust_cases WHERE id = ?").bind(id).first<CaseRow>();
}

/** A case for a reviewer: details, related events and history. Evidence: the manifest only (ids, hashes, sizes). */
export async function caseView(env: Env, role: StaffRole, id: string) {
  const c = await caseRow(env, id);
  if (!c || (c.kind === "child_safety" && !staffCan(role, "child_safety"))) return null;
  const data = parse(c.data);
  const [events, history, user, workspace] = await Promise.all([
    c.workspace_id && (c.kind === "safety" || c.kind === "child_safety")
      ? env.DB.prepare("SELECT id, user_id, run_id, job_id, stage, verdict, codes, model, excerpt, hard, created_at FROM safety_events WHERE workspace_id = ? AND hard = 1 ORDER BY created_at DESC LIMIT 50")
          .bind(c.workspace_id)
          .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    env.DB.prepare("SELECT id, actor_kind, actor_id, action, reason, created_at FROM admin_audit WHERE target_kind = 'case' AND target_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all<Record<string, unknown>>(),
    c.user_id ? env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(c.user_id).first<{ id: string; email: string; name: string }>() : Promise.resolve(null),
    c.workspace_id ? env.DB.prepare("SELECT id, name, kind, safety_flag FROM workspaces WHERE id = ?").bind(c.workspace_id).first<Record<string, unknown>>() : Promise.resolve(null),
  ]);
  const childSafety = c.kind === "child_safety";
  return {
    case: {
      id: c.id,
      kind: c.kind,
      status: c.status,
      priority: c.priority,
      workspaceId: c.workspace_id,
      userId: c.user_id,
      targetKind: c.target_kind,
      targetId: c.target_id,
      targetUrl: c.target_url,
      category: c.category,
      // Child-safety cases never show reporter text or excerpts beyond the minimum: the packet and the manifest.
      details: childSafety ? null : c.details,
      reporterEmail: childSafety ? null : c.reporter_email,
      relatedCaseId: c.related_case_id,
      resolution: c.resolution,
      resolvedBy: c.resolved_by,
      resolvedAt: c.resolved_at,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      data: childSafety ? { submission: data.submission ?? { status: "pending" }, packet: data.packet ?? null } : publicData(c.kind, data),
    },
    user,
    workspace,
    events: childSafety
      ? events.results.map((e) => ({ ...e, excerpt: null }))
      : events.results.map((e) => ({ ...e, codes: (() => { try { return JSON.parse(String(e.codes)); } catch { return []; } })() })),
    evidence: childSafety ? await evidenceRefs(env, id) : [],
    history: history.results,
    actions: actionsFor(c),
  };
}

function publicData(kind: CaseRow["kind"], data: Record<string, unknown>): Record<string, unknown> {
  if (kind === "dmca" || kind === "counter_notice") return data;
  return data;
}

function actionsFor(c: CaseRow): string[] {
  if (c.status !== "open" && c.kind !== "counter_notice" && c.kind !== "child_safety") return [];
  const map: Record<CaseRow["kind"], string[]> = {
    safety: ["dismiss", "warn", "suspend", "escalate_child_safety", "close"],
    report: ["dismiss", "warn", "suspend", "delete_content", "escalate_child_safety"],
    appeal: ["uphold", "overturn"],
    dmca: ["takedown", "dismiss"],
    counter_notice: c.status === "open" ? ["forward_counter", "dismiss"] : c.resolution === "forwarded" ? ["restore", "close"] : [],
    child_safety: c.status === "closed" ? [] : ["suspend", "delete_content", "mark_submitted", "close"],
  };
  return map[c.kind];
}

// ----------------------------------------------------------------------------- content

/** Revokes a share link; `purge` also deletes its snapshot and the assets it shows. Returns R2 keys touched. */
async function removeShare(env: Env, shareId: string, purge: boolean, stmts: D1PreparedStatement[]): Promise<string[]> {
  const link = await env.DB.prepare("SELECT id, snapshot_key FROM share_links WHERE id = ?").bind(shareId).first<{ id: string; snapshot_key: string }>();
  if (!link) return [];
  stmts.push(env.DB.prepare("UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?), show_on_profile = 0 WHERE id = ?").bind(Date.now(), shareId));
  if (!purge) return [];
  const keys = [link.snapshot_key];
  try {
    const doc = (await (await env.MEDIA.get(link.snapshot_key))?.json()) as { assets?: Record<string, unknown> } | undefined;
    const ids = Object.keys(doc?.assets ?? {});
    for (const id of ids.slice(0, 100)) {
      const a = await env.DB.prepare("SELECT r2_key, meta FROM assets WHERE id = ?").bind(id).first<{ r2_key: string; meta: string }>();
      if (!a) continue;
      keys.push(a.r2_key);
      const thumb = parse(a.meta).thumbKey;
      if (typeof thumb === "string") keys.push(thumb);
      stmts.push(env.DB.prepare("UPDATE assets SET status = 'failed', meta = json_set(COALESCE(meta, '{}'), '$.removed', 1) WHERE id = ?").bind(id));
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "trust: snapshot read failed", shareId, error: String(err) }));
  }
  return keys;
}

/** Keys of what a case points at (for evidence before removal). */
async function targetKeys(env: Env, c: CaseRow): Promise<string[]> {
  if (c.target_kind !== "share" || !c.target_id) return [];
  const link = await env.DB.prepare("SELECT snapshot_key FROM share_links WHERE id = ?").bind(c.target_id).first<{ snapshot_key: string }>();
  if (!link) return [];
  const keys = [link.snapshot_key];
  try {
    const doc = (await (await env.MEDIA.get(link.snapshot_key))?.json()) as { assets?: Record<string, { r2Key?: string }> } | undefined;
    for (const a of Object.values(doc?.assets ?? {})) if (a.r2Key) keys.push(a.r2Key);
  } catch {
    // keep the snapshot only
  }
  return keys;
}

// ----------------------------------------------------------------------------- actions

export interface ActionResult {
  caseId: string;
  status: CaseRow["status"];
  resolution: string | null;
  auditId: string;
  childSafetyCaseId?: string;
}

export async function actOnCase(env: Env, staff: { actor: Actor; role: StaffRole }, caseId: string, input: CaseActionInput): Promise<ActionResult> {
  const c = await caseRow(env, caseId);
  if (!c || (c.kind === "child_safety" && !staffCan(staff.role, "child_safety"))) throw new ApiError(404, "NOT_FOUND", "Case not found");
  if (!actionAllowed(c.kind, input.action)) throw new ApiError(400, "BAD_REQUEST", `“${input.action}” does not apply to a ${c.kind} case`);
  if (!actionsFor(c).includes(input.action)) throw new ApiError(409, "CONFLICT", "This case is not open for that action", { status: c.status, resolution: c.resolution });
  if (input.action === "escalate_child_safety" && !staffCan(staff.role, "child_safety")) {
    // Reviewers may escalate (it only preserves and restricts); the case then belongs to admins.
  }
  const now = Date.now();
  const by = staff.actor.id ?? staff.actor.kind;
  const stmts: D1PreparedStatement[] = [];
  let status: CaseRow["status"] = c.status;
  let resolution: string | null = c.resolution;
  const data = parse(c.data);
  const extra: Record<string, unknown> = {};
  let childSafetyCaseId: string | undefined;
  const toDelete: string[] = [];

  const resolve = (s: CaseRow["status"], r: string) => {
    status = s;
    resolution = r;
  };

  switch (input.action) {
    case "dismiss":
    case "uphold": {
      resolve("dismissed", input.action === "uphold" ? "upheld" : "dismissed");
      if (c.kind === "safety" && c.workspace_id) {
        // Review cleared: mature runs resume (D-005 SAFETY_REVIEW).
        stmts.push(env.DB.prepare("UPDATE workspaces SET safety_flag = 0, safety_flagged_at = NULL WHERE id = ?").bind(c.workspace_id));
        extra.flagCleared = true;
      }
      break;
    }
    case "close":
      if (c.kind === "child_safety" && (data.submission as { status?: string } | undefined)?.status !== "submitted") {
        throw new ApiError(409, "CONFLICT", "Record the CyberTipline report number before closing this case");
      }
      resolve("closed", c.resolution ?? "closed");
      if (c.kind === "safety" && c.workspace_id) stmts.push(env.DB.prepare("UPDATE workspaces SET safety_flag = 0, safety_flagged_at = NULL WHERE id = ?").bind(c.workspace_id));
      break;
    case "warn": {
      if (!c.user_id) throw new ApiError(409, "CONFLICT", "This case has no user to warn");
      await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "warning", message: input.message || DEFAULT_NOTICE.warn, caseId });
      resolve("actioned", "warned");
      break;
    }
    case "suspend": {
      const scope = input.scope ?? "user";
      const subjectId = scope === "user" ? c.user_id : c.workspace_id;
      if (!subjectId) throw new ApiError(409, "CONFLICT", `This case has no ${scope} to suspend`);
      const s = await suspend(env, { kind: scope, id: subjectId }, input.reason, by, caseId);
      if (c.user_id) await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "suspended", message: input.message || DEFAULT_NOTICE.suspend, caseId });
      extra.suspensionId = s.id;
      extra.scope = scope;
      if (c.kind !== "child_safety") resolve("actioned", "suspended");
      break;
    }
    case "delete_content": {
      if (c.kind === "report" && c.category === "child_safety") {
        throw new ApiError(409, "CONFLICT", "Escalate child-safety reports first: the evidence must be preserved before removal");
      }
      if (c.target_kind === "share" && c.target_id) toDelete.push(...(await removeShare(env, c.target_id, true, stmts)));
      else if (c.target_kind === "profile" && c.user_id) {
        stmts.push(env.DB.prepare("UPDATE share_links SET show_on_profile = 0 WHERE created_by = ?").bind(c.user_id));
        stmts.push(env.DB.prepare("UPDATE user_prefs SET bio = NULL WHERE user_id = ?").bind(c.user_id));
      } else throw new ApiError(409, "CONFLICT", "This case has no content to remove");
      if (c.user_id) await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "content_removed", message: input.message || DEFAULT_NOTICE.delete_content, caseId });
      if (c.kind !== "child_safety") resolve("actioned", "content_removed");
      else extra.contentRemoved = true;
      break;
    }
    case "escalate_child_safety": {
      const keys = await targetKeys(env, c);
      const out = await openChildSafetyCase(
        env,
        {
          source: c.kind === "report" ? "user_report" : "staff",
          workspaceId: c.workspace_id,
          userId: c.user_id,
          shareId: c.target_kind === "share" ? c.target_id : null,
          relatedCaseId: c.id,
          objectKeys: keys,
          codes: ["MINOR_SEXUAL"],
          dedupeKey: `cs:case:${c.id}`,
        },
        staff.actor,
      );
      childSafetyCaseId = out.caseId;
      extra.childSafetyCaseId = out.caseId;
      extra.preserved = out.preserved;
      // Evidence first, then the public surface goes away (the snapshot stays in the evidence prefix).
      if (c.target_kind === "share" && c.target_id) await removeShare(env, c.target_id, false, stmts);
      resolve("actioned", "escalated");
      break;
    }
    case "takedown": {
      const targets = ((data.targets as { kind: string | null; id: string | null }[] | undefined) ?? []).filter((t) => t.kind === "share" && t.id);
      if (targets.length === 0) throw new ApiError(409, "CONFLICT", "No Rolling share link in this notice");
      // Disabled, not deleted: a valid counter-notice can restore it.
      for (const t of targets) await removeShare(env, t.id!, false, stmts);
      if (c.user_id) await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "content_removed", message: `${input.message || DEFAULT_NOTICE.takedown} Case ${caseId}.`, caseId });
      extra.removed = targets.map((t) => t.id);
      resolve("actioned", "takedown");
      break;
    }
    case "forward_counter": {
      // The complainant gets the counter-notice; content may come back after the waiting period unless they sue.
      const restoreAfter = addBusinessDays(now, COUNTER_NOTICE_WAIT_BUSINESS_DAYS);
      stmts.push(env.DB.prepare("UPDATE trust_cases SET data = json_set(data, '$.forwardedAt', ?, '$.restoreAfter', ?) WHERE id = ?").bind(now, restoreAfter, caseId));
      extra.restoreAfter = restoreAfter;
      resolve("actioned", "forwarded");
      break;
    }
    case "restore": {
      const restoreAfter = Number(data.restoreAfter ?? Infinity);
      if (now < restoreAfter) throw new ApiError(409, "CONFLICT", "The counter-notice waiting period has not passed", { restoreAfter });
      const dmca = c.related_case_id ? await caseRow(env, c.related_case_id) : null;
      const removed = (parse(dmca?.data ?? "{}").targets as { kind: string | null; id: string | null }[] | undefined) ?? [];
      for (const t of removed) if (t.kind === "share" && t.id) stmts.push(env.DB.prepare("UPDATE share_links SET revoked_at = NULL WHERE id = ?").bind(t.id));
      if (c.user_id) await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "restored", message: DEFAULT_NOTICE.restore, caseId });
      resolve("closed", "restored");
      break;
    }
    case "overturn": {
      const suspensionId = (data.suspensionId as string | null) ?? null;
      if (suspensionId) {
        const s = await env.DB.prepare("SELECT subject_kind, subject_id FROM suspensions WHERE id = ?").bind(suspensionId).first<{ subject_kind: "user" | "workspace"; subject_id: string }>();
        if (s) extra.lifted = await unsuspend(env, { kind: s.subject_kind, id: s.subject_id }, by);
      }
      if (c.workspace_id) stmts.push(env.DB.prepare("UPDATE workspaces SET safety_flag = 0, safety_flagged_at = NULL WHERE id = ?").bind(c.workspace_id));
      if (c.user_id) await notifyUser(env, { userId: c.user_id, workspaceId: c.workspace_id, kind: "restored", message: input.message || "We reviewed your appeal and lifted the restriction.", caseId });
      resolve("actioned", "overturned");
      break;
    }
    case "mark_submitted": {
      if (!input.reportId) throw new ApiError(400, "VALIDATION_FAILED", "The CyberTipline report number is required");
      stmts.push(
        env.DB.prepare("UPDATE trust_cases SET data = json_set(data, '$.submission', json(?)) WHERE id = ?").bind(
          JSON.stringify({ status: "submitted", reportId: input.reportId, submittedBy: by, submittedAt: now }),
          caseId,
        ),
      );
      extra.reportId = input.reportId;
      resolve("actioned", "reported_to_ncmec");
      break;
    }
  }

  stmts.push(
    env.DB.prepare("UPDATE trust_cases SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?").bind(
      status,
      resolution,
      status === "open" ? null : by,
      status === "open" ? null : now,
      now,
      caseId,
    ),
  );
  const { id: auditId, stmt } = auditStatement(env, staff.actor, {
    action: `case.${input.action}`,
    target: { kind: "case", id: caseId },
    reason: input.reason,
    data: { kind: c.kind, workspaceId: c.workspace_id, userId: c.user_id, ...extra },
  }, now);
  stmts.push(stmt);
  await env.DB.batch(stmts);
  if (toDelete.length) await env.MEDIA.delete(toDelete);
  if (c.kind === "child_safety" && input.action === "mark_submitted") await refreshPacket(env, caseId);
  return { caseId, status, resolution, auditId, ...(childSafetyCaseId && { childSafetyCaseId }) };
}
