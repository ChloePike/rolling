/**
 * Privacy (workers pool): durable account deletion over Durable Objects,
 * pseudonymised retained records, the daily retention purge and the
 * self-serve data export.
 */
import { createExecutionContext, createScheduledController, env, introspectWorkflow, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingEmailProvider } from "@rolling/core/email/recording";
import { tombstoneUserId } from "@rolling/core/privacy";
import { readZip } from "@rolling/core/zip";
import worker from "../src/index";
import { purgeAccount, runR2Cleanup } from "../src/auth/deleteAccount";
import { deletionIdFor, runDeletionJob } from "../src/auth/deletionJob";
import { RECONCILE_CRON } from "../src/scheduled";
import { BASE, freshEmail, freshIp, getMe, grantPlan, ORIGIN, signIn, waitForEmail } from "./auth-helpers";

const DAY = 86_400_000;

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function send(cookie: string, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": freshIp(), cookie };
  if (body !== undefined) h["content-type"] = "application/json";
  return call(new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function user(tag: string) {
  const email = freshEmail(tag);
  const { cookie } = await signIn(email, { "cf-connecting-ip": freshIp() });
  const { body } = await getMe(cookie);
  return { email, cookie, userId: body.user.id as string, ws: body.workspace.id as string };
}

async function newProject(cookie: string, title = "Launch ad"): Promise<{ projectId: string; nodeId: string }> {
  const created = await send(cookie, "POST", "/api/projects", { title });
  expect(created.status, await created.clone().text()).toBe(201);
  const projectId = ((await created.json()) as any).project.id as string;
  const patch = await send(cookie, "POST", `/api/projects/${projectId}/patch`, { baseRevision: 0, ops: [{ op: "addNode", tempId: "t", kind: "text", title: "Brief", params: { text: "a bottle on a desk" } }] });
  expect(patch.status, await patch.clone().text()).toBe(200);
  return { projectId, nodeId: ((await patch.json()) as any).idMap.t as string };
}

const project = (id: string) => env.PROJECT.get(env.PROJECT.idFromName(id));
const agent = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const credits = (ws: string) => env.CREDITS.get(env.CREDITS.idFromName(ws));
const hub = (userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));

/** Rows in a DO table, 0 when storage was wiped (the table is gone or recreated empty). */
async function count(stub: DurableObjectStub, table: string): Promise<number> {
  return runInDurableObject(stub, (_i, state: DurableObjectState) => {
    try {
      return Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
    } catch {
      return 0;
    }
  });
}

async function d1Count(sql: string, ...binds: unknown[]): Promise<number> {
  return Number((await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);
}

let deletions: Awaited<ReturnType<typeof introspectWorkflow>>;
let exportsFlow: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeEach(async () => {
  deletions = await introspectWorkflow(env.ACCOUNT_DELETION);
  exportsFlow = await introspectWorkflow(env.DATA_EXPORT);
  for (const i of [deletions, exportsFlow]) {
    await i.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
  }
});

afterEach(async () => {
  await deletions.dispose();
  await exportsFlow.dispose();
});

describe("account deletion: Durable Objects, R2 and retained records", () => {
  it("wipes rooms, threads and the hub, keeps the ledger under a tombstone, and is idempotent", async () => {
    const a = await user("pdel");
    await grantPlan(a.ws, "pro");
    const own = await newProject(a.cookie);
    const thread = (await (await send(a.cookie, "POST", "/api/agent/threads", { surface: "canvas", projectId: own.projectId })).json()) as any;
    const threadId = thread.thread.id as string;
    expect(await count(agent(threadId), "meta")).toBeGreaterThan(0);
    await runInDurableObject(hub(a.userId), (_i, state: DurableObjectState) => state.storage.put("agent_turns", [Date.now()]));
    await runInDurableObject(project(own.projectId), (_i, state: DurableObjectState) => state.storage.setAlarm(Date.now() + 60_000));
    await env.MEDIA.put(`ws/${a.ws}/uploads/x.bin`, new Uint8Array([1, 2, 3]));

    // A team workspace owned by someone else, where the user made a project and spent credits.
    const team = `ws_team_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (id, name, kind, created_at) VALUES (?, 'Ridgeline', 'team', 0)").bind(team),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, 'usr_team_owner', 'owner')").bind(team),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'editor')").bind(team, a.userId),
    ]);
    const shared = `prj_01JSHARED${crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    await env.DB.prepare("INSERT INTO projects (id, workspace_id, title, created_by, updated_at) VALUES (?, ?, 'Team ad', ?, 0)").bind(shared, team, a.userId).run();
    const room = project(shared) as unknown as { init(i: unknown): Promise<unknown>; applyPatch(c: unknown, p: unknown): Promise<any> };
    await room.init({ projectId: shared, workspaceId: team, title: "Team ad", createdBy: a.userId });
    const patched = await room.applyPatch({ userId: a.userId, workspaceId: team, canEdit: true }, { baseRevision: 0, ops: [{ op: "addNode", tempId: "n", kind: "text", title: "Line", params: {} }] });
    expect(patched.ok).toBe(true);
    await runInDurableObject(credits(team), (_i, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO ledger (id, kind, bucket, amount, user_id, created_at, mirrored_at) VALUES ('led_pdel_1', 'settle', 'plan', -5, ?, 1, 1)", a.userId);
      state.storage.sql.exec("INSERT INTO member_usage (user_id, month, spent) VALUES (?, '2026-11', 5)", a.userId);
    });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ledger_lines (id, workspace_id, user_id, kind, bucket, amount, created_at) VALUES ('led_pdel_1', ?, ?, 'settle', 'plan', -5, 1)").bind(team, a.userId),
      env.DB.prepare("INSERT INTO safety_events (id, workspace_id, user_id, stage, verdict, codes, excerpt, created_at) VALUES (?, ?, ?, 'pre', 'block', '[]', 'excerpt', ?)").bind(`sev_${a.userId}`, team, a.userId, now),
      env.DB.prepare("INSERT INTO agent_usage (turn_id, workspace_id, user_id, llm, period_start, created_at) VALUES (?, ?, ?, 'deepseek', 0, ?)").bind(`turn_${a.userId}`, team, a.userId, now),
    ]);

    await purgeAccount(env, a.userId);
    const tomb = await tombstoneUserId(a.userId);
    const [instance] = await deletions.get();
    expect(instance).toBeDefined();
    await instance!.waitForStatus("complete");

    // Durable Objects: own project room (storage + alarm), thread and hub wiped.
    expect(await count(project(own.projectId), "meta")).toBe(0);
    expect(await count(project(own.projectId), "nodes")).toBe(0);
    expect(await runInDurableObject(project(own.projectId), (_i, state: DurableObjectState) => state.storage.getAlarm())).toBeNull();
    expect(await count(agent(threadId), "meta")).toBe(0);
    expect(await runInDurableObject(hub(a.userId), (_i, state: DurableObjectState) => state.storage.get("agent_turns"))).toBeUndefined();
    // Team project stays, authored by the tombstone.
    const teamRoom = await runInDurableObject(project(shared), (_i, state: DurableObjectState) => ({
      createdBy: state.storage.sql.exec("SELECT value FROM meta WHERE key = 'created_by'").one().value,
      nodes: state.storage.sql.exec("SELECT created_by FROM nodes").toArray().map((r) => r.created_by),
      actors: state.storage.sql.exec("SELECT actor FROM patch_log").toArray().map((r) => r.actor),
    }));
    // (Node `created_by` holds the origin, "user" or "agent", not a user id.)
    expect(teamRoom).toEqual({ createdBy: tomb, nodes: ["user"], actors: [tomb] });
    // CreditAccount: the line stays, pseudonymised.
    const ledger = await runInDurableObject(credits(team), (_i, state: DurableObjectState) => ({
      line: state.storage.sql.exec("SELECT user_id, amount FROM ledger WHERE id = 'led_pdel_1'").one(),
      usage: state.storage.sql.exec("SELECT user_id, spent FROM member_usage").toArray(),
    }));
    expect(ledger).toEqual({ line: { user_id: tomb, amount: -5 }, usage: [{ user_id: tomb, spent: 5 }] });

    // D1: content gone, retained records pseudonymised.
    expect(await d1Count("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?", a.ws)).toBe(0);
    expect(await d1Count("SELECT COUNT(*) AS n FROM agent_threads WHERE id = ?", threadId)).toBe(0);
    expect(await env.DB.prepare("SELECT created_by FROM projects WHERE id = ?").bind(shared).first()).toEqual({ created_by: tomb });
    expect(await env.DB.prepare("SELECT user_id FROM ledger_lines WHERE id = 'led_pdel_1'").first()).toEqual({ user_id: tomb });
    expect(await env.DB.prepare("SELECT user_id, excerpt FROM safety_events WHERE id = ?").bind(`sev_${a.userId}`).first()).toEqual({ user_id: tomb, excerpt: "excerpt" });
    expect(await env.DB.prepare("SELECT user_id FROM agent_usage WHERE turn_id = ?").bind(`turn_${a.userId}`).first()).toEqual({ user_id: tomb });
    for (const [table, col] of [["ledger_lines", "user_id"], ["safety_events", "user_id"], ["agent_usage", "user_id"], ["projects", "created_by"], ["workspace_members", "user_id"]] as const) {
      expect(await d1Count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, a.userId), table).toBe(0);
    }
    // The job forgets the raw id when done.
    const job = await env.DB.prepare("SELECT status, user_id FROM account_deletions WHERE id = ?").bind(deletionIdFor(tomb)).first();
    expect(job).toEqual({ status: "done", user_id: tomb });
    expect(await d1Count("SELECT COUNT(*) AS n FROM account_deletion_items WHERE deletion_id = ? AND done_at IS NULL", deletionIdFor(tomb))).toBe(0);

    // R2: the workspace prefix is swept.
    await runR2Cleanup(env);
    expect((await env.MEDIA.list({ prefix: `ws/${a.ws}/` })).objects.length).toBe(0);

    // Rerun: nothing more changes, nothing breaks.
    await purgeAccount(env, a.userId);
    await runDeletionJob(env, deletionIdFor(tomb));
    expect(await d1Count("SELECT COUNT(*) AS n FROM account_deletions WHERE id = ?", deletionIdFor(tomb))).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM account_deletions WHERE id = ?").bind(deletionIdFor(tomb)).first()).toEqual({ status: "done" });
    expect(await count(project(own.projectId), "meta")).toBe(0);
    expect(await runInDurableObject(credits(team), (_i, state: DurableObjectState) => state.storage.sql.exec("SELECT user_id FROM ledger WHERE id = 'led_pdel_1'").one().user_id)).toBe(tomb);
    expect(await env.DB.prepare("SELECT created_by FROM projects WHERE id = ?").bind(shared).first()).toEqual({ created_by: tomb });
  });

  it("refuses OWNER_OF_TEAM and records no job while a Team needs a new owner", async () => {
    const a = await user("powner");
    await env.DB.prepare("UPDATE workspaces SET kind = 'team' WHERE id = ?").bind(a.ws).run();
    await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, 'usr_powner_member', 'editor')").bind(a.ws).run();
    await expect(purgeAccount(env, a.userId)).rejects.toMatchObject({ code: "OWNER_OF_TEAM" });
    expect(await d1Count("SELECT COUNT(*) AS n FROM account_deletions WHERE id = ?", deletionIdFor(await tombstoneUserId(a.userId)))).toBe(0);
  });
});

describe("retention purge (daily cron)", () => {
  it("deletes old safety events and agent usage and clears excerpts after 90 days", async () => {
    const now = Date.now();
    const ws = "ws_retention";
    const ins = (id: string, ageDays: number) =>
      env.DB.prepare("INSERT INTO safety_events (id, workspace_id, user_id, stage, verdict, codes, excerpt, created_at) VALUES (?, ?, NULL, 'pre', 'block', '[]', 'some prompt', ?)").bind(id, ws, now - ageDays * DAY);
    const usage = (id: string, ageDays: number) =>
      env.DB.prepare("INSERT INTO agent_usage (turn_id, workspace_id, user_id, llm, period_start, created_at) VALUES (?, ?, NULL, 'deepseek', 0, ?)").bind(id, ws, now - ageDays * DAY);
    await env.DB.batch([ins("sev_r_new", 10), ins("sev_r_mid", 120), ins("sev_r_old", 400), usage("turn_r_new", 30), usage("turn_r_old", 401)]);

    const ctrl = createScheduledController({ cron: RECONCILE_CRON, scheduledTime: now });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);

    const events = await env.DB.prepare("SELECT id, excerpt FROM safety_events WHERE workspace_id = ? ORDER BY id").bind(ws).all();
    expect(events.results).toEqual([
      { id: "sev_r_mid", excerpt: null },
      { id: "sev_r_new", excerpt: "some prompt" },
    ]);
    const turns = await env.DB.prepare("SELECT turn_id FROM agent_usage WHERE workspace_id = ?").bind(ws).all();
    expect(turns.results).toEqual([{ turn_id: "turn_r_new" }]);
  });
});

describe("POST /api/account/export", () => {
  it("builds a ZIP with profile, workspaces, projects, assets, threads and ledger, emails a 7-day link, and allows one per 24 h", async () => {
    const a = await user("pexp");
    await grantPlan(a.ws, "pro");
    const p = await newProject(a.cookie, "Export me");
    const thread = (await (await send(a.cookie, "POST", "/api/agent/threads", { surface: "canvas", projectId: p.projectId })).json()) as any;
    await env.MEDIA.put(`ws/${a.ws}/uploads/ast_pexp.png`, new Uint8Array([137, 80, 78, 71]));
    await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, created_by, created_at, status) VALUES (?, ?, 'image', 'mine', 'photo.png', ?, ?, 1, 'ready')")
      .bind(`ast_pexp_${a.userId.slice(-6)}`, a.ws, `ws/${a.ws}/uploads/ast_pexp.png`, a.userId)
      .run();
    await env.DB.prepare("INSERT INTO ledger_lines (id, workspace_id, user_id, kind, bucket, amount, created_at) VALUES (?, ?, ?, 'grant', 'plan', 2500, 1)").bind(`led_pexp_${a.userId}`, a.ws, a.userId).run();

    const mailsBefore = RecordingEmailProvider.to(a.email).length;
    const res = await send(a.cookie, "POST", "/api/account/export", {});
    expect(res.status, await res.clone().text()).toBe(202);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ export: { id: expect.stringMatching(/^dex_/), status: "queued" }, email: a.email, linkTtlDays: 7 });
    const [instance] = await exportsFlow.get();
    await instance!.waitForStatus("complete");

    const row = await env.DB.prepare("SELECT status, r2_key, size, expires_at, finished_at FROM data_exports WHERE id = ?").bind(body.export.id).first<any>();
    expect(row.status).toBe("done");
    expect(row.r2_key).toMatch(new RegExp(`^ws/${a.ws}/account-exports/${body.export.id}/rolling-data-\\d{4}-\\d{2}-\\d{2}\\.zip$`));
    expect(row.expires_at - row.finished_at).toBe(7 * DAY);
    const obj = await env.MEDIA.get(row.r2_key);
    const files = readZip(new Uint8Array(await obj!.arrayBuffer()));
    const byName = Object.fromEntries(files.map((f) => [f.name, f.data]));
    const json = (name: string) => JSON.parse(new TextDecoder().decode(byName[name]!));
    expect(Object.keys(byName).sort()).toEqual(
      ["README.txt", "agent-threads/" + thread.thread.id + ".json", "assets/page-001.json", "credit-ledger.json", "profile.json", `projects/${p.projectId}.json`, "runs.json", "workspaces.json"].sort(),
    );
    expect(json("profile.json")).toMatchObject({ user: { id: a.userId, email: a.email }, preferences: { user_id: a.userId } });
    expect(JSON.stringify(json("profile.json"))).not.toMatch(/token/i);
    expect(json("workspaces.json")).toEqual([{ id: a.ws, name: expect.any(String), kind: "personal", role: "owner" }]);
    const snap = json(`projects/${p.projectId}.json`);
    expect(snap).toMatchObject({ projectId: p.projectId, title: "Export me", nodes: [{ id: p.nodeId, title: "Brief" }] });
    expect(snap).toHaveProperty("timeline");
    const assets = json("assets/page-001.json");
    expect(assets).toEqual([expect.objectContaining({ name: "photo.png", url: expect.stringMatching(/^http.*\/media\//) })]);
    expect(json(`agent-threads/${thread.thread.id}.json`)).toMatchObject({ id: thread.thread.id, messages: [] });
    expect(json("credit-ledger.json")).toEqual(expect.arrayContaining([expect.objectContaining({ id: `led_pexp_${a.userId}`, amount: 2500 })]));
    // Parts were removed after zipping.
    expect((await env.MEDIA.list({ prefix: `ws/${a.ws}/account-exports/${body.export.id}/parts/` })).objects.length).toBe(0);

    // The emailed link downloads the bundle.
    const mail = await waitForEmail(a.email, mailsBefore + 1);
    const last = mail[mail.length - 1]!;
    expect(last.subject).toBe("Your Rolling data export is ready");
    expect(last.text).toContain("7 days");
    const link = /(https?:\/\/\S+)/.exec(last.text.split("Download it: ")[1] ?? "")![1]!;
    const u = new URL(link);
    const dl = await SELF.fetch(`${BASE}${u.pathname}${u.search}`, { redirect: "manual" });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/zip");
    await dl.arrayBuffer();

    // One per 24 h.
    const again = await send(a.cookie, "POST", "/api/account/export", {});
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: { code: "RATE_LIMITED", data: { retryAfter: expect.any(Number), nextAvailableAt: body.export.createdAt + DAY } } });
    const latest = (await (await send(a.cookie, "GET", "/api/account/export")).json()) as any;
    expect(latest.export).toMatchObject({ id: body.export.id, status: "done", nextAvailableAt: body.export.createdAt + DAY });

    // After the window a new export is allowed; expired bundles are removed by the purge.
    await env.DB.prepare("UPDATE data_exports SET created_at = created_at - ? WHERE id = ?").bind(8 * DAY, body.export.id).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: RECONCILE_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare("SELECT status, r2_key FROM data_exports WHERE id = ?").bind(body.export.id).first()).toEqual({ status: "expired", r2_key: null });
    expect(await env.MEDIA.head(row.r2_key)).toBeNull();
    const third = await send(a.cookie, "POST", "/api/account/export", {});
    expect(third.status).toBe(202);
    await (await exportsFlow.get())[1]!.waitForStatus("complete");
  });

  it("needs a session", async () => {
    const res = await SELF.fetch(`${BASE}/api/account/export`, { method: "POST", headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
});
