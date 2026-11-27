/**
 * Operations (D-025 .. D-030) in the workers pool: admin authz on every route, the audit log,
 * credit adjustments and refunds through CreditAccount, suspension enforcement, reports,
 * appeals, DMCA and counter-notices, child-safety escalation with locked evidence, status
 * probes and the incident banner, DO backup and restore, and the gateway circuit breaker.
 */
import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { DEFAULT_BREAKER } from "@rolling/core/ops/breaker";
import { personalWorkspaceId } from "../src/auth/workspace";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { logSafety } from "../src/safety/service";
import { breakerOpen, readBreaker, recordGatewayFailure, resetBreaker, setBreakerConfigForTests } from "../src/ops/breaker";
import { resetProbesForTests, runStatusProbes, setProbeForTests } from "../src/ops/status";
import { backupBatch, backupDate, backupKey, pruneBackups } from "../src/ops/backup";
import { projectRoom } from "../src/lib/access";

const BASE = "https://example.com";
const DAY = 86_400_000;
const TOKEN = "ops-admin-token";

let seq = 0;
const uid = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown; token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function user(tag: string): Promise<{ user: string; ws: string }> {
  const u = uid(tag);
  expect((await api(u, "/api/projects")).status).toBe(200);
  return { user: u, ws: personalWorkspaceId(u) };
}

async function member(tag: string): Promise<{ user: string; ws: string }> {
  const m = await user(tag);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
    .bind(`sub_${m.user}`, m.ws, now + 30 * DAY, now)
    .run();
  const stub = env.CREDITS.get(env.CREDITS.idFromName(m.ws));
  expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${m.user}`)).ok).toBe(true);
  return m;
}

async function staff(role: "admin" | "reviewer"): Promise<string> {
  const u = uid(role);
  await env.DB.prepare("INSERT INTO staff (email, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(`${u}@staff.test`, u, role, Date.now()).run();
  return u;
}

async function auditRows(action: string, targetId?: string): Promise<any[]> {
  return (await env.DB.prepare("SELECT * FROM admin_audit WHERE action = ? AND (?2 IS NULL OR target_id = ?2) ORDER BY created_at").bind(action, targetId ?? null).all()).results;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

let gatewayStatus = 200;
beforeAll(async () => {
  (env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN = TOKEN;
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
  setGatewayFetchForTests(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/models")) return gatewayStatus === 200 ? json(listing) : json({ error: { message: "down", code: "upstream_error" } }, gatewayStatus);
    return json({ error: { message: "unavailable", type: "server_error", code: "upstream_error" } }, 503);
  });
});

afterAll(() => {
  setGatewayFetchForTests(null);
  setBreakerConfigForTests(null);
  resetProbesForTests();
});

afterEach(async () => {
  gatewayStatus = 200;
  await resetBreaker(env);
  setBreakerConfigForTests(null);
});

// ---------------------------------------------------------------------------

const ROUTES: { method: string; path: string; json?: unknown; perm: "view" | "review" | "credits" | "plans" | "ops" | "staff" }[] = [
  { method: "GET", path: "/api/admin/me", perm: "view" },
  { method: "GET", path: "/api/admin/search?q=x", perm: "view" },
  { method: "GET", path: "/api/admin/users/usr_x", perm: "view" },
  { method: "GET", path: "/api/admin/workspaces/ws_x", perm: "view" },
  { method: "GET", path: "/api/admin/metrics", perm: "view" },
  { method: "GET", path: "/api/admin/status", perm: "view" },
  { method: "GET", path: "/api/admin/audit", perm: "view" },
  { method: "GET", path: "/api/admin/cases", perm: "review" },
  { method: "GET", path: "/api/admin/cases/case_x", perm: "review" },
  { method: "POST", path: "/api/admin/cases/case_x/actions", json: { action: "dismiss", reason: "test" }, perm: "review" },
  { method: "POST", path: "/api/admin/suspensions", json: { subjectKind: "user", subjectId: "u_x", action: "suspend", reason: "test" }, perm: "review" },
  { method: "POST", path: "/api/admin/workspaces/ws_x/credits", json: { amount: 1, reason: "test", idemKey: "authz-0001" }, perm: "credits" },
  { method: "POST", path: "/api/admin/runs/run_x/refund", json: { reason: "test" }, perm: "credits" },
  { method: "POST", path: "/api/admin/workspaces/ws_x/grant", json: { planId: "pro", reason: "test" }, perm: "plans" },
  { method: "PUT", path: "/api/admin/incident", json: { message: "", level: "info" }, perm: "ops" },
  { method: "POST", path: "/api/admin/breaker/reset", json: { reason: "test" }, perm: "ops" },
  { method: "GET", path: "/api/admin/backups", perm: "ops" },
  { method: "POST", path: "/api/admin/backups/restore", json: { kind: "credits", id: "ws_x", date: "2026-01-01", reason: "test" }, perm: "ops" },
  { method: "GET", path: "/api/admin/staff", perm: "staff" },
  { method: "POST", path: "/api/admin/staff", json: { email: "x@y.test", role: "reviewer", reason: "test" }, perm: "staff" },
  { method: "DELETE", path: "/api/admin/staff/x@y.test", json: { reason: "test" }, perm: "staff" },
];

describe("admin authz (every route)", () => {
  it("signed out 401, non-staff 404, reviewer 403 outside view/review, admin and the token pass the gate", async () => {
    const { user: plain } = await user("plain");
    const reviewer = await staff("reviewer");
    const admin = await staff("admin");
    for (const r of ROUTES) {
      const init = { method: r.method, ...(r.json !== undefined && { json: r.json }) };
      expect((await api(null, r.path, init)).status, `${r.method} ${r.path} signed out`).toBe(401);
      expect((await api(plain, r.path, init)).status, `${r.method} ${r.path} non-staff`).toBe(404);
      const rev = await api(reviewer, r.path, init);
      if (r.perm === "view" || r.perm === "review") expect(rev.status, `${r.method} ${r.path} reviewer`).not.toBe(403);
      else expect(rev.status, `${r.method} ${r.path} reviewer`).toBe(403);
      for (const who of [{ u: admin }, { u: null, token: TOKEN }]) {
        const res = await api(who.u, r.path, { ...init, ...(who.token && { token: who.token }) });
        expect([401, 403].includes(res.status), `${r.method} ${r.path} admin → ${res.status}`).toBe(false);
      }
    }
    expect((await api(null, "/api/admin/me", { token: "wrong" })).status).toBe(401);
  });

  it("the owner's seeded email becomes admin on sign-in only when verified and bound once", async () => {
    // Seeded by migration 0027; dev identities have no email, so bind through the users table.
    const owner = uid("owner");
    await env.DB.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Owner', 'phd.chloepike@gmail.com', 1, ?, ?)").bind(owner, new Date().toISOString(), new Date().toISOString()).run();
    const { staffOf } = await import("../src/ops/staff");
    const s = await staffOf(env, { userId: owner, user: { email: "phd.chloepike@gmail.com", emailVerified: true } });
    expect(s?.role).toBe("admin");
    // Bound: another account with the same (unverified or not) email does not match.
    expect(await staffOf(env, { userId: "someone-else", user: { email: "phd.chloepike@gmail.com", emailVerified: true } })).toBeNull();
    expect(await staffOf(env, { userId: "unverified", user: { email: "nobody@staff.test", emailVerified: false } })).toBeNull();
  });

  it("audit rows cannot be changed or deleted", async () => {
    const admin = await staff("admin");
    expect((await api(admin, "/api/admin/incident", { method: "PUT", json: { message: "Slow renders", level: "degraded" } })).status).toBe(200);
    const [row] = await auditRows("status.incident_set");
    expect(row).toMatchObject({ actor_kind: "staff", actor_id: admin });
    await expect(env.DB.prepare("UPDATE admin_audit SET reason = 'x' WHERE id = ?").bind(row.id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM admin_audit WHERE id = ?").bind(row.id).run()).rejects.toThrow(/append-only/);
    expect((await api(admin, "/api/admin/incident", { method: "PUT", json: { message: "", level: "info" } })).status).toBe(200);
  });
});

describe("credits and plans through CreditAccount", () => {
  it("grants and deducts with a reason, mirrors an adjust line, and audits", async () => {
    const admin = await staff("admin");
    const { ws } = await member("adj");
    const res = await api(admin, `/api/admin/workspaces/${ws}/credits`, { method: "POST", json: { amount: 250, reason: "Goodwill for a slow week", idemKey: `k-${ws}-1` } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).balance).toMatchObject({ plan: 800, purchased: 250 });
    // Same key replays without a second grant.
    const again = (await (await api(admin, `/api/admin/workspaces/${ws}/credits`, { method: "POST", json: { amount: 250, reason: "Goodwill for a slow week", idemKey: `k-${ws}-1` } })).json()) as any;
    expect(again.balance.purchased).toBe(250);
    const deduct = await api(admin, `/api/admin/workspaces/${ws}/credits`, { method: "POST", json: { amount: -300, reason: "Chargeback", idemKey: `k-${ws}-2` } });
    expect(((await deduct.json()) as any).balance).toMatchObject({ plan: 750, purchased: 0 });
    const tooMuch = await api(admin, `/api/admin/workspaces/${ws}/credits`, { method: "POST", json: { amount: -999_999, reason: "Too much", idemKey: `k-${ws}-3` } });
    expect(tooMuch.status).toBe(402);
    const lines = (await env.CREDITS.get(env.CREDITS.idFromName(ws)).lines(10)).filter((l) => l.kind === "adjust");
    expect(lines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([-250, -50, 250]);
    expect(lines.every((l) => l.note?.startsWith(`staff:${admin}:`))).toBe(true);
    expect((await auditRows("credits.grant", ws)).length).toBe(2);
    expect((await auditRows("credits.deduct", ws)).length).toBe(1);
    const view = (await (await api(admin, `/api/admin/workspaces/${ws}`)).json()) as any;
    expect(view.balance.purchased).toBe(0);
    expect(view.ledger.some((l: any) => l.kind === "adjust")).toBe(true);
  });

  it("refunds a run's settled jobs once", async () => {
    const admin = await staff("admin");
    const { user: u, ws } = await member("refund");
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    const catalog = (await env.DB.prepare("SELECT data, price FROM models WHERE id = 'bytedance/seedream-5.0-lite'").first<{ data: string; price: string }>())!;
    const model = { ...JSON.parse(catalog.data), price: JSON.parse(catalog.price) };
    const q = await stub.quote([{ ref: "n1", modelId: "bytedance/seedream-5.0-lite", request: { n: 1 } }], [model]);
    expect(q.ok, JSON.stringify(q)).toBe(true);
    const runId = `run_${uid("r")}`;
    const h = await stub.hold({ quoteId: (q as any).value.quoteId, runId, userId: u, idemKey: `h-${runId}` });
    expect(h.ok).toBe(true);
    const job = (h as any).value.jobs[0];
    expect((await stub.settle(job.jobId, job.credits, `s-${job.jobId}`)).ok).toBe(true);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO runs (id, workspace_id, quote_id, scope, status, created_by, created_at, credits_spent) VALUES (?, ?, 'qt_x', 'spec', 'succeeded', ?, ?, ?)").bind(runId, ws, u, now, job.credits),
      env.DB.prepare("INSERT INTO jobs (id, run_id, provider, model, status, cost_quote, cost_actual, idempotency_key, created_at, workspace_id) VALUES (?, ?, 'hyperouter', 'bytedance/seedream-5.0-lite', 'succeeded', ?, ?, ?, ?, ?)").bind(job.jobId, runId, job.credits, job.credits, job.jobId, now, ws),
    ]);
    const before = await stub.balance();
    const res = await api(admin, `/api/admin/runs/${runId}/refund`, { method: "POST", json: { reason: "Broken output" } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).total).toBe(job.credits);
    expect((await stub.balance()).purchased).toBe(before.purchased + job.credits);
    expect((await api(admin, `/api/admin/runs/${runId}/refund`, { method: "POST", json: { reason: "Broken output" } })).status).toBe(409);
    expect((await auditRows("credits.refund_run", runId)).length).toBe(1);
    expect((await env.DB.prepare("SELECT credits_refunded FROM runs WHERE id = ?").bind(runId).first<{ credits_refunded: number }>())!.credits_refunded).toBe(job.credits);
  });

  it("grants a comp plan through the adminGrant logic, from the console and the token", async () => {
    const admin = await staff("admin");
    const { user: u, ws } = await user("comp");
    const res = await api(admin, `/api/admin/workspaces/${ws}/grant`, { method: "POST", json: { planId: "pro", months: 2, extraCredits: 100, reason: "Creator program" } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await (await api(u, "/api/me")).json()) as any).isMember).toBe(true);
    expect((await auditRows("plan.comp_grant", ws))[0]).toMatchObject({ actor_kind: "staff", reason: "Creator program" });
  });
});

describe("suspensions", () => {
  it("a suspended user can browse but not generate or use the agent; lifting restores", async () => {
    const reviewer = await staff("reviewer");
    const { user: u } = await member("susp");
    const s = await api(reviewer, "/api/admin/suspensions", { method: "POST", json: { subjectKind: "user", subjectId: u, action: "suspend", reason: "Repeated violations" } });
    expect(s.status, await s.clone().text()).toBe(200);
    expect((await api(u, "/api/me")).status).toBe(200);
    expect((await api(u, "/api/projects")).status).toBe(200);
    const run = await api(u, "/api/runs", { method: "POST", json: { quoteId: "qt_x" } });
    expect(run.status).toBe(403);
    expect(((await run.json()) as any).error).toMatchObject({ code: "SUSPENDED", message: expect.stringContaining("You can appeal") });
    expect(((await (await api(u, "/api/agent/threads", { method: "POST", json: { surface: "home" } })).json()) as any).error.code).toBe("SUSPENDED");
    const me = (await (await api(u, "/api/trust/me")).json()) as any;
    expect(me.suspension).toMatchObject({ scope: "user" });
    expect(me.notices[0]).toMatchObject({ kind: "suspended" });
    // Appeal from the block message lands in the queue; overturning lifts it.
    const appeal = await api(u, "/api/trust/appeals", { method: "POST", json: { subject: "suspension", message: "This was a mistake." } });
    expect(appeal.status, await appeal.clone().text()).toBe(201);
    const { caseId } = (await appeal.json()) as any;
    const queue = (await (await api(reviewer, "/api/admin/cases?kind=appeal")).json()) as any;
    expect(queue.items.some((i: any) => i.id === caseId)).toBe(true);
    const act = await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "overturn", reason: "Classifier false positive" } });
    expect(act.status, await act.clone().text()).toBe(200);
    expect(((await (await api(u, "/api/trust/me")).json()) as any).suspension).toBeNull();
    expect((await api(u, "/api/runs", { method: "POST", json: { quoteId: "qt_x" } })).status).toBe(404);
    expect((await auditRows("case.overturn", caseId)).length).toBe(1);
  });

  it("a suspended workspace stops every member", async () => {
    const admin = await staff("admin");
    const { user: u, ws } = await member("wsusp");
    expect((await api(admin, "/api/admin/suspensions", { method: "POST", json: { subjectKind: "workspace", subjectId: ws, action: "suspend", reason: "Fraud" } })).status).toBe(200);
    expect((await api(u, "/api/runs", { method: "POST", json: { quoteId: "qt_x" } })).status).toBe(403);
    expect((await api(admin, "/api/admin/suspensions", { method: "POST", json: { subjectKind: "workspace", subjectId: ws, action: "unsuspend", reason: "Cleared" } })).status).toBe(200);
    expect((await api(u, "/api/runs", { method: "POST", json: { quoteId: "qt_x" } })).status).toBe(404);
    expect((await auditRows("account.suspend", ws)).length).toBe(1);
    expect((await auditRows("account.unsuspend", ws)).length).toBe(1);
  });
});

async function shareFor(owner: string, ws: string): Promise<{ shareId: string; assetKey: string }> {
  const shareId = `shr_${uid("s")}`;
  const assetId = `ast_${uid("a")}`;
  const assetKey = `ws/${ws}/gen/${assetId}.png`;
  await env.MEDIA.put(assetKey, new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: "image/png" } });
  const snapshotKey = `ws/${ws}/shares/${shareId}.json`;
  await env.MEDIA.put(snapshotKey, JSON.stringify({ shareId, title: "T", revision: 1, createdAt: 1, nodes: [], edges: [], groups: [], assets: { [assetId]: { kind: "image", r2Key: assetKey, workspaceId: ws } } }));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (id, workspace_id, title, updated_at, created_by) VALUES (?, ?, 'P', 0, ?)").bind(`prj_${shareId}`, ws, owner),
    env.DB.prepare("INSERT INTO share_links (id, project_id, snapshot_key, workspace_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(shareId, `prj_${shareId}`, snapshotKey, ws, owner, Date.now()),
    env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'generated', 'x', ?, '{}', ?, ?, 'ready', 0)").bind(assetId, ws, assetKey, owner, Date.now()),
  ]);
  return { shareId, assetKey };
}

describe("reports, DMCA and counter-notices", () => {
  it("a signed-out report of a share lands in the queue; removal revokes the link and the media", async () => {
    const reviewer = await staff("reviewer");
    const { user: owner, ws } = await user("rep");
    const { shareId, assetKey } = await shareFor(owner, ws);
    const r = await api(null, "/api/trust/reports", { method: "POST", json: { targetKind: "share", targetId: shareId, category: "harassment", details: "Targets a classmate", email: "Reporter@Example.com" } });
    expect(r.status, await r.clone().text()).toBe(201);
    const { caseId } = (await r.json()) as any;
    const view = (await (await api(reviewer, `/api/admin/cases/${caseId}`)).json()) as any;
    expect(view.case).toMatchObject({ kind: "report", userId: owner, workspaceId: ws, reporterEmail: "reporter@example.com" });
    expect(view.actions).toContain("delete_content");
    const del = await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "delete_content", reason: "Harassment confirmed" } });
    expect(del.status, await del.clone().text()).toBe(200);
    expect((await env.DB.prepare("SELECT revoked_at FROM share_links WHERE id = ?").bind(shareId).first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();
    expect(await env.MEDIA.head(assetKey)).toBeNull();
    expect((await api(null, `/api/share/${shareId}`)).status).toBe(404);
    expect((await auditRows("case.delete_content", caseId)).length).toBe(1);
    // Closed cases take no more actions.
    expect((await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "warn", reason: "again" } })).status).toBe(409);
  });

  it("a report via the abuse form URL resolves the profile owner; warn notifies them", async () => {
    const reviewer = await staff("reviewer");
    const { user: owner } = await user("prof");
    const handle = `h${uid("x")}`.slice(0, 20);
    await env.DB.prepare("UPDATE user_prefs SET handle = ? WHERE user_id = ?").bind(handle, owner).run();
    const r = await api(null, "/api/trust/reports", { method: "POST", json: { targetKind: "url", url: `https://rolling.actor/u/${handle}`, category: "impersonation" } });
    const { caseId } = (await r.json()) as any;
    expect((await (await api(reviewer, `/api/admin/cases/${caseId}`)).json()) as any).toMatchObject({ case: { targetKind: "profile", userId: owner } });
    expect((await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "warn", reason: "Impersonation" } })).status).toBe(200);
    expect(((await (await api(owner, "/api/trust/me")).json()) as any).notices[0]).toMatchObject({ kind: "warning" });
  });

  it("DMCA notice → takedown (disabled, restorable) → counter-notice → forwarded → restore after the wait", async () => {
    const reviewer = await staff("reviewer");
    const { user: owner, ws } = await user("dmca");
    const { shareId } = await shareFor(owner, ws);
    const notice = {
      fullName: "Rights Holder",
      email: "rights@example.com",
      phone: "+1 555 0100",
      address: "1 Main St, Springfield",
      workDescription: "My photo series",
      infringingUrls: [`https://rolling.actor/share/${shareId}`],
      goodFaith: true,
      accuracyUnderPenalty: true,
      signature: "Rights Holder",
    };
    expect((await api(null, "/api/trust/dmca", { method: "POST", json: { ...notice, accuracyUnderPenalty: false } })).status).toBe(400);
    const n = await api(null, "/api/trust/dmca", { method: "POST", json: notice });
    expect(n.status, await n.clone().text()).toBe(201);
    const { caseId } = (await n.json()) as any;
    expect((await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "takedown", reason: "Valid notice" } })).status).toBe(200);
    expect((await api(null, `/api/share/${shareId}`)).status).toBe(404);
    const counter = { caseId, fullName: "Owner", email: "owner@example.com", phone: "1", address: "2 Side St", materialDescription: "My own photos", mistakeUnderPenalty: true, consentToJurisdiction: true, acceptService: true, signature: "Owner" };
    // Only the person whose content was removed may counter.
    const { user: stranger } = await user("stranger");
    expect((await api(stranger, "/api/trust/counter-notices", { method: "POST", json: counter })).status).toBe(404);
    const c = await api(owner, "/api/trust/counter-notices", { method: "POST", json: counter });
    expect(c.status, await c.clone().text()).toBe(201);
    const counterId = ((await c.json()) as any).caseId;
    expect((await api(reviewer, `/api/admin/cases/${counterId}/actions`, { method: "POST", json: { action: "forward_counter", reason: "Sent to complainant" } })).status).toBe(200);
    // Too early: the waiting period (10 business days) has not passed.
    expect((await api(reviewer, `/api/admin/cases/${counterId}/actions`, { method: "POST", json: { action: "restore", reason: "No lawsuit" } })).status).toBe(409);
    await env.DB.prepare("UPDATE trust_cases SET data = json_set(data, '$.restoreAfter', 0) WHERE id = ?").bind(counterId).run();
    expect((await api(reviewer, `/api/admin/cases/${counterId}/actions`, { method: "POST", json: { action: "restore", reason: "No lawsuit filed" } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT revoked_at FROM share_links WHERE id = ?").bind(shareId).first<{ revoked_at: number | null }>())!.revoked_at).toBeNull();
  });
});

describe("child-safety escalation (D-027)", () => {
  const minorVerdict = { verdict: "block" as const, reasons: [{ code: "MINOR_SEXUAL" as const, detail: "test" }], checks: [{ name: "vision" as const, status: "block" as const }] };

  it("a MINOR_SEXUAL post-check preserves the outputs in the locked prefix, flags and suspends, prefills the packet", async () => {
    const admin = await staff("admin");
    const reviewer = await staff("reviewer");
    const { user: u, ws } = await member("cs");
    const jobId = `job_${uid("j")}`;
    const outKey = `ws/${ws}/gen/${jobId}/0.png`;
    await env.MEDIA.put(outKey, new Uint8Array([9, 9, 9]), { httpMetadata: { contentType: "image/png" } });
    await logSafety(env, { id: `${jobId}:post`, workspaceId: ws, userId: u, runId: "run_x", jobId, stage: "post", verdict: minorVerdict, prompt: "the full prompt text", evidenceKeys: [outKey] });
    // Retried step: same case, no duplicate evidence.
    await logSafety(env, { id: `${jobId}:post`, workspaceId: ws, userId: u, runId: "run_x", jobId, stage: "post", verdict: minorVerdict, prompt: "the full prompt text", evidenceKeys: [outKey] });
    const cases = (await env.DB.prepare("SELECT * FROM trust_cases WHERE workspace_id = ? AND kind = 'child_safety'").bind(ws).all<any>()).results;
    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.priority).toBe(2);
    const items = (await env.DB.prepare("SELECT * FROM evidence_items WHERE case_id = ?").bind(c.id).all<any>()).results;
    expect(items.map((i) => i.kind).sort()).toEqual(["object", "text"]);
    for (const i of items) {
      expect(i.r2_key.startsWith(`evidence/${c.id}/`)).toBe(true);
      expect(await env.MEDIA.head(i.r2_key)).not.toBeNull();
      expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(i.retain_until).toBeGreaterThan(Date.now() + 364 * DAY);
    }
    // The caller deletes the output afterwards; the evidence copy stays and cannot be removed from the index.
    await env.MEDIA.delete(outKey);
    expect(await env.MEDIA.head(items.find((i) => i.kind === "object").r2_key)).not.toBeNull();
    await expect(env.DB.prepare("DELETE FROM evidence_items WHERE case_id = ?").bind(c.id).run()).rejects.toThrow(/locked/);
    // Flagged and suspended pending review.
    expect((await env.DB.prepare("SELECT safety_flag FROM workspaces WHERE id = ?").bind(ws).first<{ safety_flag: number }>())!.safety_flag).toBe(1);
    expect((await api(u, "/api/runs", { method: "POST", json: { quoteId: "qt_x" } })).status).toBe(403);
    // Restricted: reviewers neither list nor open it; admins see the manifest and the packet, never the prompt.
    expect(((await (await api(reviewer, "/api/admin/cases?kind=child_safety")).json()) as any).items).toHaveLength(0);
    expect((await api(reviewer, `/api/admin/cases/${c.id}`)).status).toBe(404);
    const view = (await (await api(admin, `/api/admin/cases/${c.id}`)).json()) as any;
    expect(view.evidence).toHaveLength(2);
    expect(view.case.data.packet).toMatchObject({ submission: { status: "pending" }, reportedPerson: { espUserId: u, workspaceId: ws } });
    expect(JSON.stringify(view)).not.toContain("the full prompt text");
    expect(JSON.stringify(view)).not.toContain("evidence/");
    // The media routes never serve the evidence prefix, even with a valid-looking path.
    expect((await api(null, `/media/${items[0].r2_key}?exp=9999999999&ws=${ws}&sig=x`)).status).toBe(404);
    // Closing needs the CyberTipline report number first; then evidence still waits for retention.
    expect((await api(admin, `/api/admin/cases/${c.id}/actions`, { method: "POST", json: { action: "close", reason: "done" } })).status).toBe(409);
    expect((await api(admin, `/api/admin/cases/${c.id}/actions`, { method: "POST", json: { action: "mark_submitted", reason: "Submitted by T&S lead", reportId: "123456789" } })).status).toBe(200);
    expect((await api(admin, `/api/admin/cases/${c.id}/actions`, { method: "POST", json: { action: "close", reason: "Reported" } })).status).toBe(200);
    await expect(env.DB.prepare("DELETE FROM evidence_items WHERE case_id = ?").bind(c.id).run()).rejects.toThrow(/locked/);
    expect((await auditRows("child_safety.case_opened", c.id)).length).toBe(1);
    expect((await auditRows("case.mark_submitted", c.id))[0].data).toContain("123456789");
  });

  it("a confirmed child-safety report escalates: snapshot preserved first, then the public link goes", async () => {
    const reviewer = await staff("reviewer");
    const { user: owner, ws } = await user("csr");
    const { shareId, assetKey } = await shareFor(owner, ws);
    const r = await api(null, "/api/trust/reports", { method: "POST", json: { targetKind: "share", targetId: shareId, category: "child_safety" } });
    const { caseId } = (await r.json()) as any;
    expect(((await (await api(reviewer, `/api/admin/cases/${caseId}`)).json()) as any).case.priority).toBe(2);
    // Removal without escalation is refused for child-safety reports.
    expect((await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "delete_content", reason: "x" } })).status).toBe(409);
    const esc = await api(reviewer, `/api/admin/cases/${caseId}/actions`, { method: "POST", json: { action: "escalate_child_safety", reason: "Apparent CSAM" } });
    expect(esc.status, await esc.clone().text()).toBe(200);
    const { childSafetyCaseId } = (await esc.json()) as any;
    const items = (await env.DB.prepare("SELECT source_key FROM evidence_items WHERE case_id = ?").bind(childSafetyCaseId).all<any>()).results.map((i) => i.source_key);
    expect(items).toContain(assetKey);
    expect((await api(null, `/api/share/${shareId}`)).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM suspensions WHERE subject_id = ? AND lifted_at IS NULL").bind(owner).first<{ n: number }>())!.n).toBe(1);
  });

  it("other hard limits land in the workspace's safety case; dismissing clears the review flag", async () => {
    const reviewer = await staff("reviewer");
    const { user: u, ws } = await member("hard");
    for (let i = 0; i < 3; i++) {
      await logSafety(env, { id: `hard-${ws}-${i}`, workspaceId: ws, userId: u, stage: "pre", verdict: { verdict: "block", reasons: [{ code: "EXTREME_VIOLENCE", detail: "x" }], checks: [] } });
    }
    const cs = (await env.DB.prepare("SELECT * FROM trust_cases WHERE workspace_id = ? AND kind = 'safety'").bind(ws).all<any>()).results;
    expect(cs).toHaveLength(1);
    expect(cs[0].priority).toBe(1); // flagged after 3 hard blocks (SAFETY_REVIEW)
    const view = (await (await api(reviewer, `/api/admin/cases/${cs[0].id}`)).json()) as any;
    expect(view.events).toHaveLength(3);
    expect((await api(reviewer, `/api/admin/cases/${cs[0].id}/actions`, { method: "POST", json: { action: "dismiss", reason: "Reviewed, no pattern" } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT safety_flag FROM workspaces WHERE id = ?").bind(ws).first<{ safety_flag: number }>())!.safety_flag).toBe(0);
  });
});

describe("status page", () => {
  it("probes every component, shows degraded and outage, and the incident banner", async () => {
    const admin = await staff("admin");
    setProbeForTests("auth", async () => ({ ok: true }));
    await runStatusProbes(env);
    let s = (await (await api(null, "/api/status")).json()) as any;
    expect(s.components.map((c: any) => c.id)).toEqual(["api", "gateway", "media", "auth"]);
    expect(s.components.find((c: any) => c.id === "gateway").status).toBe("operational");
    expect(s.generation.available).toBe(true);
    // Gateway listing fails twice: down, overall outage.
    gatewayStatus = 503;
    await runStatusProbes(env);
    await runStatusProbes(env);
    s = (await (await api(null, "/api/status")).json()) as any;
    expect(s.components.find((c: any) => c.id === "gateway").status).toBe("down");
    expect(s.overall).toBe("outage");
    expect((await api(admin, "/api/admin/incident", { method: "PUT", json: { message: "Video renders are slow.", level: "degraded" } })).status).toBe(200);
    s = (await (await api(null, "/api/status")).json()) as any;
    expect(s.incident).toMatchObject({ message: "Video renders are slow.", level: "degraded" });
    gatewayStatus = 200;
    await runStatusProbes(env);
    expect((await api(admin, "/api/admin/incident", { method: "PUT", json: { message: "", level: "info" } })).status).toBe(200);
    expect(((await (await api(null, "/api/status")).json()) as any).incident).toBeNull();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM status_checks").first<{ n: number }>();
    expect(rows!.n).toBeGreaterThanOrEqual(16);
    resetProbesForTests();
  });
});

describe("backups (D-030)", () => {
  it("dumps CreditAccounts and ProjectRooms to R2 and restores one", async () => {
    const admin = await staff("admin");
    const { user: u, ws } = await member("bak");
    const created = (await (await api(u, "/api/projects", { method: "POST", json: { title: "Backed up" } })).json()) as any;
    const projectId = created.project?.id ?? created.id;
    const date = backupDate();
    // Back up everything (a few batches), then check our objects.
    for (const kind of ["credits", "projects"] as const) {
      let cursor = "";
      for (let i = 0; i < 200; i++) {
        const r = await backupBatch(env, date, kind, cursor, 50);
        if (!r.next) break;
        cursor = r.next;
      }
    }
    const credits = await env.MEDIA.get(backupKey(date, "credits", ws));
    expect(credits).not.toBeNull();
    const dump = (await credits!.json()) as any;
    expect(dump).toMatchObject({ kind: "CreditAccount", name: ws });
    expect(dump.tables.ledger.rows.length).toBeGreaterThan(0);
    expect(await env.MEDIA.head(backupKey(date, "projects", projectId))).not.toBeNull();
    // Damage the account, then restore it from the backup.
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    const before = await stub.balance();
    expect((await stub.adjust({ amount: 777, reason: "after the backup", actor: "test", idemKey: `post-backup-${ws}` })).ok).toBe(true);
    const res = await api(admin, "/api/admin/backups/restore", { method: "POST", json: { kind: "credits", id: ws, date, reason: "Restore drill" } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await stub.balance()).toEqual(before);
    expect((await stub.audit()).ok).toBe(true);
    expect((await auditRows("backup.restore", ws)).length).toBe(1);
    // A ProjectRoom restores too.
    const room = projectRoom(env, projectId) as unknown as { restoreBackup(d: unknown): Promise<{ ok: boolean }> };
    const roomDump = await (await env.MEDIA.get(backupKey(date, "projects", projectId)))!.json();
    expect((await room.restoreBackup(roomDump)).ok).toBe(true);
    // A backup of another workspace is refused.
    const other = await member("bak2");
    expect((await env.CREDITS.get(env.CREDITS.idFromName(other.ws)).restoreBackup(dump)).ok).toBe(false);
    // 30-day retention.
    const old = backupKey("2000-01-01", "credits", ws);
    await env.MEDIA.put(old, "{}");
    expect(await pruneBackups(env)).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA.head(old)).toBeNull();
    expect(await env.MEDIA.head(backupKey(date, "credits", ws))).not.toBeNull();
  });
});

describe("gateway circuit breaker (D-030)", () => {
  it("opens after repeated 5xx, fails fast without holding, half-opens and closes", async () => {
    setBreakerConfigForTests({ ...DEFAULT_BREAKER, threshold: 3, openMs: 60_000 });
    const { user: u, ws } = await member("brk");
    const q = await api(u, "/api/runs/quote", { method: "POST", json: { promptSpec: { kind: "image", model: "bytedance/seedream-5.0-lite", prompt: "A red bicycle" } } });
    expect(q.status, await q.clone().text()).toBe(200);
    const quoteId = ((await q.json()) as any).quoteId;
    for (let i = 0; i < 3; i++) await recordGatewayFailure(env, "503: upstream_error");
    expect(await breakerOpen(env)).toBe(true);
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    const before = await stub.balance();
    const start = await api(u, "/api/runs", { method: "POST", json: { quoteId } });
    expect(start.status).toBe(503);
    expect(((await start.json()) as any).error).toMatchObject({ code: "GATEWAY_UNAVAILABLE", message: expect.stringContaining("temporarily unavailable") });
    expect(await stub.balance()).toEqual(before);
    const s = (await (await api(null, "/api/status")).json()) as any;
    expect(s.generation).toMatchObject({ available: false, breaker: "open" });
    expect(s.overall).not.toBe("operational");
    // Half-open after openMs: a probe success closes it.
    await env.DB.prepare("UPDATE gateway_breaker SET open_until = ? WHERE gateway = 'hyperouter'").bind(Date.now() - 1).run();
    setBreakerConfigForTests({ ...DEFAULT_BREAKER, threshold: 3 });
    setProbeForTests("auth", async () => ({ ok: true }));
    await runStatusProbes(env);
    expect((await readBreaker(env, undefined, true)).state).toBe("closed");
    resetProbesForTests();
  });

  it("provider 5xx on submit count toward opening; client errors do not", async () => {
    setBreakerConfigForTests({ ...DEFAULT_BREAKER, threshold: 2 });
    const { generationProvider } = await import("../src/runs/provider");
    const { loadCatalog } = await import("../src/models/catalog");
    const model = (await loadCatalog(env)).get("bytedance/seedream-5.0-lite")!;
    const p = generationProvider(env, model);
    // The fake gateway answers 503 to everything but the listing.
    await expect(p.status("gen_brk_1")).rejects.toThrow();
    expect(await breakerOpen(env)).toBe(false);
    await expect(p.status("gen_brk_2")).rejects.toThrow();
    expect(await breakerOpen(env)).toBe(true);
    await resetBreaker(env);
    // An invalid request (client error, nothing sent) never counts.
    await expect(p.submit({ prompt: "", n: 99 } as never, "idem-brk-3")).rejects.toThrow();
    expect((await readBreaker(env, undefined, true)).failures).toBe(0);
  });
});
