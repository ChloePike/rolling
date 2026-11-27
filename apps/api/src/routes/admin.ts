/**
 * Admin console API (`/api/admin/*`, D-025). Every route runs `staffMiddleware`
 * (staff session or `ADMIN_TOKEN` bearer; everyone else 404, signed out 401)
 * and checks its permission with `requireStaff`. Money moves only through
 * CreditAccount; every change writes an `admin_audit` entry. `POST /grant`
 * (routes/adminGrant.ts) stays for scripts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { CaseActionBody, type CaseActionInput } from "@rolling/core/ops/trust";
import { permissionsOf, STAFF_ROLES } from "@rolling/core/ops/staff";
import { INCIDENT_MAX } from "@rolling/core/ops/status";
import type { Balance, LedgerOutcome, RefundJobResult } from "@rolling/core/credits";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit, auditStatement } from "../ops/audit";
import { backupDaysOf, restoreFromBackup } from "../ops/backup";
import { readBreaker, resetBreaker } from "../ops/breaker";
import { actOnCase, caseView, listCases } from "../ops/cases";
import { dashboard } from "../ops/metrics";
import { statusView, writeIncident } from "../ops/status";
import { requireStaff, staffMiddleware, type AdminEnv } from "../ops/staff";
import { notifyUser, suspend, unsuspend } from "../ops/suspension";
import { CompGrantFields, grantCompPlan } from "./adminGrant";

const Id = z.string().trim().min(1).max(120);
const Reason = z.string().trim().min(3).max(1000);

function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}

export const adminConsole = new Hono<AdminEnv>()
  .use("*", async (c, next) => {
    // The token-only script route keeps its own contract (404 without ADMIN_TOKEN).
    if (c.req.path.endsWith("/admin/grant")) return next();
    return staffMiddleware(c, next);
  })

  // ---------------------------------------------------------------- who

  .get("/me", (c) => {
    const s = requireStaff(c, "view");
    return c.json({ role: s.role, email: s.email, actor: s.actor.kind, permissions: permissionsOf(s.role) });
  })

  // ---------------------------------------------------------------- users and workspaces

  .get("/search", validate("query", z.object({ q: z.string().trim().min(1).max(200) })), async (c) => {
    requireStaff(c, "view");
    const q = c.req.valid("query").q.toLowerCase();
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const [users, workspaces] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?1 OR lower(email) LIKE ?2 OR lower(name) LIKE ?2 ORDER BY created_at DESC LIMIT 25").bind(q, like),
      c.env.DB.prepare("SELECT id, name, kind, safety_flag, created_at FROM workspaces WHERE lower(id) = ?1 OR lower(name) LIKE ?2 ORDER BY created_at DESC LIMIT 25").bind(q, like),
    ]);
    return c.json({ users: users?.results ?? [], workspaces: workspaces?.results ?? [] });
  })

  .get("/users/:id", validate("param", z.object({ id: Id })), async (c) => {
    requireStaff(c, "view");
    const id = c.req.valid("param").id;
    const user = await c.env.DB.prepare("SELECT id, email, name, email_verified, created_at FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    const [memberships, suspensions, notices, events, cases] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(
        `SELECT m.workspace_id, m.role, w.name, w.kind, w.safety_flag,
           (SELECT s.plan FROM subscriptions s WHERE s.workspace_id = m.workspace_id AND s.status IN ('active','trialing') AND s.current_period_end > ?2 ORDER BY s.current_period_end DESC LIMIT 1) AS plan
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?1`,
      ).bind(id, Date.now()),
      c.env.DB.prepare("SELECT * FROM suspensions WHERE subject_kind = 'user' AND subject_id = ? ORDER BY created_at DESC LIMIT 20").bind(id),
      c.env.DB.prepare("SELECT id, kind, message, created_at, read_at FROM user_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(id),
      c.env.DB.prepare("SELECT id, workspace_id, stage, codes, hard, created_at FROM safety_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
      c.env.DB.prepare("SELECT id, kind, status, priority, created_at FROM trust_cases WHERE user_id = ? AND kind <> 'child_safety' ORDER BY created_at DESC LIMIT 20").bind(id),
    ]);
    if (!user && (memberships?.results ?? []).length === 0) throw new ApiError(404, "NOT_FOUND", "User not found");
    return c.json({
      user: user ?? { id },
      memberships: memberships?.results ?? [],
      suspensions: suspensions?.results ?? [],
      notices: notices?.results ?? [],
      safetyEvents: events?.results ?? [],
      cases: cases?.results ?? [],
    });
  })

  .get("/workspaces/:id", validate("param", z.object({ id: Id })), async (c) => {
    requireStaff(c, "view");
    const id = c.req.valid("param").id;
    const ws = await c.env.DB.prepare("SELECT id, name, kind, mature_allowed, safety_flag, safety_flagged_at, created_at, deleted_at FROM workspaces WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!ws) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
    const account = creditAccount(c.env, id);
    const [summary, lines] = await Promise.all([account.summary(), account.lines(100)]);
    const [members, subs, runs, events, suspensions, cases] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare("SELECT m.user_id, m.role, u.email, u.name FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?").bind(id),
      c.env.DB.prepare("SELECT id, plan, interval, status, seats, current_period_end, cancel_at_period_end FROM subscriptions WHERE workspace_id = ? ORDER BY current_period_end DESC LIMIT 10").bind(id),
      c.env.DB.prepare("SELECT id, title, status, created_by, credits_quoted, credits_spent, credits_refunded, created_at FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
      c.env.DB.prepare("SELECT id, user_id, run_id, job_id, stage, verdict, codes, model, hard, created_at FROM safety_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
      c.env.DB.prepare("SELECT * FROM suspensions WHERE subject_kind = 'workspace' AND subject_id = ? ORDER BY created_at DESC LIMIT 20").bind(id),
      c.env.DB.prepare("SELECT id, kind, status, priority, created_at FROM trust_cases WHERE workspace_id = ? AND kind <> 'child_safety' ORDER BY created_at DESC LIMIT 20").bind(id),
    ]);
    return c.json({
      workspace: ws,
      members: members?.results ?? [],
      subscriptions: subs?.results ?? [],
      plan: summary.planId,
      balance: summary.balance,
      account: summary,
      ledger: lines,
      runs: runs?.results ?? [],
      safetyEvents: (events?.results ?? []).map((e) => ({ ...e, codes: (() => { try { return JSON.parse(String(e.codes)); } catch { return []; } })() })),
      suspensions: suspensions?.results ?? [],
      cases: cases?.results ?? [],
    });
  })

  // ---------------------------------------------------------------- plans and credits

  .post("/workspaces/:id/grant", validate("param", z.object({ id: Id })), validate("json", z.object({ ...CompGrantFields, reason: Reason })), async (c) => {
    const staff = requireStaff(c, "plans");
    const id = c.req.valid("param").id;
    const { reason, ...body } = c.req.valid("json");
    const ws = await c.env.DB.prepare("SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL").bind(id).first();
    if (!ws) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
    return c.json(await grantCompPlan(c.env, { workspaceId: id, ...body }, staff.actor, reason));
  })

  .post(
    "/workspaces/:id/credits",
    validate("param", z.object({ id: Id })),
    validate("json", z.object({ amount: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, "amount must not be 0"), reason: Reason, idemKey: z.string().trim().min(8).max(120) })),
    async (c) => {
      const staff = requireStaff(c, "credits");
      const id = c.req.valid("param").id;
      const { amount, reason, idemKey } = c.req.valid("json");
      const ws = await c.env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(id).first();
      if (!ws) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
      const result = unwrapLedger(await creditAccount(c.env, id).adjust({ amount, reason, actor: staff.actor.id ?? staff.actor.kind, idemKey: `admin-adjust:${idemKey}` }));
      const auditId = await audit(c.env, staff.actor, { action: amount > 0 ? "credits.grant" : "credits.deduct", target: { kind: "workspace", id }, reason, data: { amount, idemKey, balance: result.balance } });
      return c.json({ ...result, auditId });
    },
  )

  .post("/runs/:id/refund", validate("param", z.object({ id: Id })), validate("json", z.object({ reason: Reason })), async (c) => {
    const staff = requireStaff(c, "credits");
    const runId = c.req.valid("param").id;
    const { reason } = c.req.valid("json");
    const run = await c.env.DB.prepare("SELECT id, workspace_id FROM runs WHERE id = ?").bind(runId).first<{ id: string; workspace_id: string }>();
    if (!run) throw new ApiError(404, "NOT_FOUND", "Run not found");
    const jobs = await c.env.DB.prepare("SELECT id FROM jobs WHERE run_id = ? AND status = 'succeeded' AND COALESCE(cost_actual, 0) > 0").bind(runId).all<{ id: string }>();
    const account = creditAccount(c.env, run.workspace_id);
    const refunded: { jobId: string; credits: number }[] = [];
    const skipped: { jobId: string; reason: string }[] = [];
    let balance: Balance | null = null;
    for (const j of jobs.results) {
      const out = (await account.refundJob({ jobId: j.id, reason, actor: staff.actor.id ?? staff.actor.kind, idemKey: `admin-refund:${j.id}:${crypto.randomUUID()}` })) as LedgerOutcome<RefundJobResult>;
      if (out.ok) {
        refunded.push({ jobId: j.id, credits: out.value.refunded });
        balance = out.value.balance;
      } else skipped.push({ jobId: j.id, reason: out.error.code });
    }
    const total = refunded.reduce((s, r) => s + r.credits, 0);
    if (refunded.length === 0) throw new ApiError(409, "CONFLICT", "Nothing to refund in this run", { skipped });
    const now = Date.now();
    const { id: auditId, stmt } = auditStatement(c.env, staff.actor, { action: "credits.refund_run", target: { kind: "run", id: runId }, reason, data: { workspaceId: run.workspace_id, refunded, skipped, total } }, now);
    await c.env.DB.batch([c.env.DB.prepare("UPDATE runs SET credits_refunded = credits_refunded + ?, updated_at = ? WHERE id = ?").bind(total, now, runId), stmt]);
    return c.json({ runId, refunded, skipped, total, balance, auditId });
  })

  // ---------------------------------------------------------------- suspensions

  .post(
    "/suspensions",
    validate("json", z.object({ subjectKind: z.enum(["user", "workspace"]), subjectId: Id, action: z.enum(["suspend", "unsuspend"]), reason: Reason, message: z.string().trim().max(1000).optional() })),
    async (c) => {
      const staff = requireStaff(c, "review");
      const { subjectKind, subjectId, action, reason, message } = c.req.valid("json");
      const exists =
        subjectKind === "user"
          ? await c.env.DB.prepare("SELECT 1 AS x FROM workspace_members WHERE user_id = ? LIMIT 1").bind(subjectId).first()
          : await c.env.DB.prepare("SELECT 1 AS x FROM workspaces WHERE id = ?").bind(subjectId).first();
      if (!exists) throw new ApiError(404, "NOT_FOUND", `${subjectKind === "user" ? "User" : "Workspace"} not found`);
      const by = staff.actor.id ?? staff.actor.kind;
      let result: Record<string, unknown>;
      if (action === "suspend") {
        const s = await suspend(c.env, { kind: subjectKind, id: subjectId }, reason, by);
        result = { suspensionId: s.id, created: s.created };
        if (subjectKind === "user" && s.created) await notifyUser(c.env, { userId: subjectId, kind: "suspended", message: message || "Generation and the agent are paused on this account while we review recent activity." });
      } else {
        const lifted = await unsuspend(c.env, { kind: subjectKind, id: subjectId }, by);
        result = { lifted };
        if (subjectKind === "user" && lifted > 0) await notifyUser(c.env, { userId: subjectId, kind: "restored", message: message || "Generation and the agent are available again on this account." });
      }
      const auditId = await audit(c.env, staff.actor, { action: `account.${action}`, target: { kind: subjectKind, id: subjectId }, reason, data: result });
      return c.json({ ...result, auditId });
    },
  )

  // ---------------------------------------------------------------- review queue

  .get(
    "/cases",
    validate("query", z.object({ status: z.enum(["open", "actioned", "dismissed", "closed", "all"]).optional(), kind: z.enum(["safety", "report", "appeal", "dmca", "counter_notice", "child_safety"]).optional() })),
    async (c) => {
      const staff = requireStaff(c, "review");
      const q = c.req.valid("query");
      const rows = await listCases(c.env, staff.role, { ...(q.status && { status: q.status }), ...(q.kind && { kind: q.kind }) });
      const flagged = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE safety_flag = 1").first<{ n: number }>();
      return c.json({
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          priority: r.priority,
          category: r.category,
          workspaceId: r.workspace_id,
          userId: r.user_id,
          targetKind: r.target_kind,
          targetId: r.target_id,
          resolution: r.resolution,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        flaggedWorkspaces: num(flagged?.n),
      });
    },
  )

  .get("/cases/:id", validate("param", z.object({ id: Id })), async (c) => {
    const staff = requireStaff(c, "review");
    const view = await caseView(c.env, staff.role, c.req.valid("param").id);
    if (!view) throw new ApiError(404, "NOT_FOUND", "Case not found");
    return c.json(view);
  })

  .post("/cases/:id/actions", validate("param", z.object({ id: Id })), validate("json", CaseActionBody), async (c) => {
    const staff = requireStaff(c, "review");
    const input = c.req.valid("json") as CaseActionInput;
    return c.json(await actOnCase(c.env, staff, c.req.valid("param").id, input));
  })

  // ---------------------------------------------------------------- metrics, status, ops

  .get("/metrics", validate("query", z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })), async (c) => {
    requireStaff(c, "view");
    return c.json(await dashboard(c.env, c.req.valid("query").days));
  })

  .get("/status", async (c) => {
    requireStaff(c, "view");
    const [view, breaker, backups] = await Promise.all([
      statusView(c.env),
      readBreaker(c.env, undefined, true),
      c.env.DB.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 7").all<Record<string, unknown>>(),
    ]);
    return c.json({ ...view, breakerDetail: breaker, backups: backups.results });
  })

  .put(
    "/incident",
    validate("json", z.object({ message: z.string().trim().max(INCIDENT_MAX), level: z.enum(["info", "degraded", "outage"]).default("degraded") })),
    async (c) => {
      const staff = requireStaff(c, "ops");
      const body = c.req.valid("json");
      const incident = await writeIncident(c.env, body, staff.actor.id ?? staff.actor.kind);
      await audit(c.env, staff.actor, { action: incident ? "status.incident_set" : "status.incident_cleared", target: { kind: "status", id: "incident" }, reason: body.message || "cleared", data: { level: body.level } });
      return c.json({ incident });
    },
  )

  .post("/breaker/reset", validate("json", z.object({ reason: Reason })), async (c) => {
    const staff = requireStaff(c, "ops");
    await resetBreaker(c.env);
    await audit(c.env, staff.actor, { action: "gateway.breaker_reset", target: { kind: "gateway", id: "hyperouter" }, reason: c.req.valid("json").reason });
    return c.json({ ok: true });
  })

  .get("/backups", validate("query", z.object({ kind: z.enum(["credits", "projects"]).optional(), id: Id.optional() })), async (c) => {
    requireStaff(c, "ops");
    const q = c.req.valid("query");
    const runs = await c.env.DB.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 35").all<Record<string, unknown>>();
    return c.json({ runs: runs.results, ...(q.kind && q.id ? { days: await backupDaysOf(c.env, q.kind, q.id) } : {}) });
  })

  .post(
    "/backups/restore",
    validate("json", z.object({ kind: z.enum(["credits", "projects"]), id: Id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: Reason })),
    async (c) => {
      const staff = requireStaff(c, "ops");
      const { kind, id, date, reason } = c.req.valid("json");
      const out = await restoreFromBackup(c.env, kind, id, date);
      await audit(c.env, staff.actor, { action: "backup.restore", target: { kind: kind === "credits" ? "workspace" : "project", id }, reason, data: { date, ...out } });
      if (!out.ok) throw new ApiError(409, "CONFLICT", out.error);
      return c.json(out);
    },
  )

  .get("/audit", validate("query", z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), targetId: Id.optional() })), async (c) => {
    requireStaff(c, "view");
    const q = c.req.valid("query");
    const rows = await c.env.DB.prepare(
      "SELECT * FROM admin_audit WHERE (?1 IS NULL OR created_at < ?1) AND (?2 IS NULL OR target_id = ?2) ORDER BY created_at DESC LIMIT ?3",
    )
      .bind(q.before ?? null, q.targetId ?? null, q.limit)
      .all<Record<string, unknown>>();
    return c.json({ items: rows.results.map((r) => ({ ...r, data: (() => { try { return JSON.parse(String(r.data)); } catch { return {}; } })() })) });
  })

  // ---------------------------------------------------------------- staff

  .get("/staff", async (c) => {
    requireStaff(c, "staff");
    const rows = await c.env.DB.prepare("SELECT email, user_id, role, created_at, created_by FROM staff ORDER BY created_at").all<Record<string, unknown>>();
    return c.json({ items: rows.results });
  })

  .post("/staff", validate("json", z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(STAFF_ROLES as unknown as ["admin", "reviewer"]), reason: Reason })), async (c) => {
    const staff = requireStaff(c, "staff");
    const { email, role, reason } = c.req.valid("json");
    await c.env.DB.prepare("INSERT INTO staff (email, role, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role")
      .bind(email, role, Date.now(), staff.actor.id ?? staff.actor.kind)
      .run();
    const auditId = await audit(c.env, staff.actor, { action: "staff.upsert", target: { kind: "staff", id: email }, reason, data: { role } });
    return c.json({ email, role, auditId });
  })

  .delete("/staff/:email", validate("param", z.object({ email: z.string().trim().toLowerCase().email() })), validate("json", z.object({ reason: Reason })), async (c) => {
    const staff = requireStaff(c, "staff");
    const { email } = c.req.valid("param");
    if (staff.email === email) throw new ApiError(409, "CONFLICT", "You cannot remove yourself");
    const r = await c.env.DB.prepare("DELETE FROM staff WHERE email = ?").bind(email).run();
    if ((r.meta.changes ?? 0) === 0) throw new ApiError(404, "NOT_FOUND", "Not staff");
    const auditId = await audit(c.env, staff.actor, { action: "staff.remove", target: { kind: "staff", id: email }, reason: c.req.valid("json").reason });
    return c.json({ ok: true, auditId });
  });
