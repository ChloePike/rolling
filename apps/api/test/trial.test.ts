/**
 * The one-time sign-up trial (D-022): granted on the first verified sign-up
 * only, once, behind the anti-abuse checks; what a trial may run (quote caps,
 * agent, exports, mature content); expiry.
 */
import { env, introspectWorkflow, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { fixtureCatalog } from "@rolling/core/models/__fixtures__/catalog";
import { TRIAL } from "@rolling/core/pricing/config";
import { adminGrantTrial, claimTrial, markTrialPending } from "../src/auth/trial";
import { sha256Hex } from "../src/auth/rateLimit";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { lineFromRow } from "../src/do/creditStore";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { BASE, freshEmail, freshIp, getMe, ORIGIN, signIn } from "./auth-helpers";

const DAY = 86_400_000;

function credits(ws: string) {
  return env.CREDITS.get(env.CREDITS.idFromName(ws));
}

async function claimOf(userId: string): Promise<any> {
  return env.DB.prepare("SELECT * FROM trial_claims WHERE user_id = ?").bind(userId).first();
}

async function trialLines(ws: string) {
  return runInDurableObject(credits(ws), (_i, state) =>
    state.storage.sql
      .exec("SELECT * FROM ledger WHERE bucket = 'trial' ORDER BY created_at, id")
      .toArray()
      .map((r) => lineFromRow(r as Record<string, SqlStorageValue>)),
  );
}

let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

/** A dev-header user on a trial (as if granted at sign-up), optionally already expired. */
async function trialUser(tag: string, opts: { expiresAt?: number } = {}): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  const expiresAt = opts.expiresAt ?? now + TRIAL.days * DAY;
  await env.DB.prepare("INSERT INTO trial_claims (user_id, workspace_id, status, method, credits, expires_at, created_at, updated_at) VALUES (?, ?, 'granted', 'admin', ?, ?, ?, ?)")
    .bind(user, ws, TRIAL.credits, expiresAt, now, now)
    .run();
  const g = await credits(ws).grantTrial(TRIAL.credits, Math.max(expiresAt, now + 1), `trial:${ws}`);
  expect(g.ok).toBe(true);
  return { user, ws };
}

async function project(user: string, ws: string, nodes: { kind: string; title: string; params: Record<string, unknown> }[]): Promise<{ id: string; ids: Record<string, string>; canvasId: string }> {
  const res = await api(user, "/api/projects", { method: "POST", json: { title: "Trial test" } });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as { project: { id: string; canvasId?: string } };
  const id = body.project.id;
  const room = projectRoom(env, id);
  const r = (await room.applyPatch(
    { userId: user, workspaceId: ws, canEdit: true },
    { baseRevision: 0, ops: nodes.map((n, i) => ({ op: "addNode", tempId: `t${i}`, kind: n.kind, title: n.title, params: n.params, position: { x: i * 300, y: 0 } })) },
  )) as any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const ids: Record<string, string> = {};
  nodes.forEach((n, i) => (ids[n.title] = r.idMap[`t${i}`]));
  return { id, ids, canvasId: body.project.canvasId ?? `cnv_${id.slice(4)}` };
}

async function quote(user: string, body: unknown): Promise<any> {
  const res = await api(user, "/api/runs/quote", { method: "POST", json: body });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

const IMAGE = { model: "Seedream 5.0 Lite", prompt: "A bottle on a rock", ratio: "9:16", resolution: "2K" };
const SHOT = { model: "Seedance 2.0 Mini", prompt: "Slow push-in", ratio: "9:16", resolution: "480p", length: 5 };

// Minimal fake gateway: images finish on the first poll.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const gateway = { creates: 0 };
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "cdn.fake") return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    gateway.creates++;
    return json({ id: `gen_trial_${gateway.creates}`, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) return json({ data: { id: gen[1], kind: "image", status: "done", usage: { cost: 0.035 }, outputs: [{ url: `https://cdn.fake/${gen[1]}.png` }] } });
  return json({ error: { message: `fake: no route ${url.pathname}`, code: "not_found" } }, 404);
}) as typeof fetch;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => new Response(JSON.stringify(listing))) as unknown as typeof fetch });
  setGatewayFetchForTests(fakeFetch);
});
afterAll(() => setGatewayFetchForTests(null));
beforeEach(async () => {
  introspector = await introspectWorkflow(env.GENERATE);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.forceEventTimeout({ name: "wait-1-1" });
  });
});
afterEach(async () => {
  await introspector.dispose();
});

// ---------------------------------------------------------------------------

describe("trial grant on sign-up", () => {
  it("grants the trial on the first verified email sign-up, once", async () => {
    const email = freshEmail("trial");
    const ip = freshIp();
    const { cookie } = await signIn(email, { "cf-connecting-ip": ip });
    const { body } = await getMe(cookie);
    const ws = body.workspace.id;
    expect(body.isMember).toBe(false);
    expect(body.trial).toMatchObject({ status: "active", credits: TRIAL.credits, remaining: TRIAL.credits, agentAllowanceUsd: TRIAL.agentAllowanceUsd });
    expect(body.trial.expiresAt).toBeGreaterThan(Date.now() + (TRIAL.days - 1) * DAY);
    // The balance keeps its shape; trial credits live in their own bucket.
    expect(body.balance).toEqual({ plan: 0, purchased: 0, held: 0, planExpiresAt: null });
    expect(await credits(ws).balance()).toMatchObject({ trial: TRIAL.credits });
    const claim = await claimOf(body.user.id);
    expect(claim).toMatchObject({ status: "granted", method: "email", workspace_id: ws, credits: TRIAL.credits });
    expect(claim.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    // Raw identifiers are never stored.
    expect(JSON.stringify(claim)).not.toContain(email);
    expect(JSON.stringify(claim)).not.toContain(ip);

    // Later sessions grant nothing more: the claim is decided once, the DO grant is once per workspace.
    expect(await trialLines(ws)).toHaveLength(1);
    expect(await credits(ws).grantTrial(TRIAL.credits, Date.now() + DAY, `trial:${ws}:again`)).toMatchObject({ ok: true, value: { granted: 0, skipped: "already" } });
    expect((await credits(ws).balance()).trial).toBe(TRIAL.credits);
    // claimTrial again: nothing pending.
    expect(await claimTrial(env, body.user.id, { ip, cookie: null })).toBe("none");
  });

  it("does not grant existing users retroactively; an admin can", async () => {
    // A user created before the trial shipped: no pending claim.
    const id = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
    const email = freshEmail("old");
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Old', ?, 1, ?, ?)").bind(id, email, now, now).run();
    const { cookie } = await signIn(email, { "cf-connecting-ip": freshIp() });
    const { body } = await getMe(cookie);
    expect(body.user.id).toBe(id);
    expect(body.trial).toBeNull();
    expect(await claimOf(id)).toBeNull();

    // Admin grant (`POST /api/admin/trial`), still once.
    const first = await adminGrantTrial(env, id);
    expect(first).toMatchObject({ status: "granted", workspaceId: personalWorkspaceId(id) });
    expect(await adminGrantTrial(env, id)).toMatchObject({ status: "already" });
    expect((await credits(personalWorkspaceId(id)).balance()).trial).toBe(TRIAL.credits);
  });

  it("refuses unverified emails and disposable domains", async () => {
    const id = newUser("usr_unverified");
    await env.DB.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'U', ?, 0, '', '')").bind(id, freshEmail("unv")).run();
    await markTrialPending(env, id);
    expect(await claimTrial(env, id, { ip: null, cookie: null })).toBe("denied");
    expect(await claimOf(id)).toMatchObject({ status: "denied", reason: "unverified" });

    const { cookie } = await signIn(`burner.${Date.now()}@mailinator.com`, { "cf-connecting-ip": freshIp() });
    const { body } = await getMe(cookie);
    expect(body.trial).toBeNull();
    expect(await claimOf(body.user.id)).toMatchObject({ status: "denied", reason: "disposable" });
  });

  it("gives one trial per mailbox: Gmail dots and +tags are the same person", async () => {
    const local = `ada${Date.now().toString(36)}`;
    const a = await signIn(`${local}@gmail.com`, { "cf-connecting-ip": freshIp() });
    expect((await getMe(a.cookie)).body.trial).toMatchObject({ status: "active" });
    const b = await signIn(`${local.slice(0, 2)}.${local.slice(2)}+promo@googlemail.com`, { "cf-connecting-ip": freshIp() });
    const me = await getMe(b.cookie);
    expect(me.body.trial).toBeNull();
    expect(await claimOf(me.body.user.id)).toMatchObject({ status: "denied", reason: "email_used" });
  });

  it("gives one trial per Google account", async () => {
    const sub = `g-${crypto.randomUUID()}`;
    const make = async (tag: string) => {
      const id = newUser(`usr_${tag}`);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'G', ?, 1, '', '')").bind(id, freshEmail(tag)),
        env.DB.prepare("INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'google', ?, '', '')").bind(`acc_${id}`, sub, id),
      ]);
      await markTrialPending(env, id);
      return id;
    };
    const first = await make("g1");
    expect(await claimTrial(env, first, { ip: null, cookie: null })).toBe("granted");
    expect(await claimOf(first)).toMatchObject({ status: "granted", method: "google" });
    // The same Google subject behind another email (changed address): no second trial.
    const second = await make("g2");
    expect(await claimTrial(env, second, { ip: null, cookie: null })).toBe("denied");
    expect(await claimOf(second)).toMatchObject({ status: "denied", reason: "google_used" });
  });

  it("gives one trial per device id", async () => {
    const device = `dev${crypto.randomUUID().replace(/-/g, "")}`;
    const headers = (ip: string) => ({ "cf-connecting-ip": ip, cookie: `rolling_did=${device}` });
    const a = await signIn(freshEmail("dev1"), headers(freshIp()));
    expect((await getMe(a.cookie)).body.trial).toMatchObject({ status: "active" });
    const b = await signIn(freshEmail("dev2"), headers(freshIp()));
    const me = await getMe(b.cookie);
    expect(me.body.trial).toBeNull();
    expect(await claimOf(me.body.user.id)).toMatchObject({ status: "denied", reason: "device_used" });
  });

  it("rate limits trials per IP and per /24 over a day", async () => {
    const now = Date.now();
    const seed = async (kind: "ip" | "subnet", value: string, n: number) => {
      const h = await sha256Hex(`trial:${kind}:${value}`);
      for (let i = 0; i < n; i++) {
        await env.DB.prepare(`INSERT INTO trial_claims (user_id, workspace_id, status, ${kind}_hash, created_at, updated_at) VALUES (?, ?, 'granted', ?, ?, ?)`)
          .bind(`seed_${kind}_${now}_${i}_${Math.random()}`, `ws_seed_${kind}_${now}_${i}_${Math.random()}`, h, now, now)
          .run();
      }
    };
    await seed("ip", "203.0.113.9", TRIAL.perIpPerDay);
    const a = await signIn(freshEmail("ip"), { "cf-connecting-ip": "203.0.113.9" });
    const meA = await getMe(a.cookie);
    expect(await claimOf(meA.body.user.id)).toMatchObject({ status: "denied", reason: "ip_limit" });

    await seed("subnet", "192.0.2.0/24", TRIAL.perSubnetPerDay);
    const b = await signIn(freshEmail("subnet"), { "cf-connecting-ip": "192.0.2.200" });
    const meB = await getMe(b.cookie);
    expect(await claimOf(meB.body.user.id)).toMatchObject({ status: "denied", reason: "subnet_limit" });

    // Grants older than a day no longer count.
    const old = await sha256Hex("trial:ip:203.0.113.10");
    for (let i = 0; i < TRIAL.perIpPerDay; i++) {
      await env.DB.prepare("INSERT INTO trial_claims (user_id, workspace_id, status, ip_hash, created_at, updated_at) VALUES (?, ?, 'granted', ?, ?, ?)")
        .bind(`old_${now}_${i}`, `ws_old_${now}_${i}`, old, now - 2 * DAY, now - 2 * DAY)
        .run();
    }
    const c = await signIn(freshEmail("ipold"), { "cf-connecting-ip": "203.0.113.10" });
    expect((await getMe(c.cookie)).body.trial).toMatchObject({ status: "active" });
  });
});

describe("what a trial can do", () => {
  it("quotes under the trial caps: curated models, 480p, 5 s", async () => {
    const { user, ws } = await trialUser("caps");
    const { id, ids } = await project(user, ws, [
      { kind: "image", title: "Key", params: IMAGE },
      { kind: "video", title: "Shot", params: SHOT },
      { kind: "video", title: "HD", params: { ...SHOT, resolution: "720p" } },
      { kind: "video", title: "Pro", params: { ...SHOT, model: "Seedance 2.5" } },
    ]);
    const q = await quote(user, { projectId: id, scope: "all" });
    const row = (t: string) => q.items.find((i: any) => i.nodeId === ids[t]);
    // Prices follow the live catalog (Enhance prompt may add its bound), so only their sum is pinned.
    expect(row("Key")).toMatchObject({ action: "run", credits: expect.any(Number) });
    expect(row("Shot")).toMatchObject({ action: "run", credits: expect.any(Number) });
    expect(row("HD")).toMatchObject({ action: "blocked", code: "trial_locked", lowestPlan: "starter" });
    expect(row("Pro")).toMatchObject({ action: "blocked", code: "trial_locked" });
    expect(q).toMatchObject({ total: row("Key").credits + row("Shot").credits, balance: TRIAL.credits });
  });

  it("runs on trial credits and refuses with NO_PLAN (trial used) when they do not cover the run", async () => {
    const { user, ws } = await trialUser("run");
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: IMAGE }]);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    const res = await api(user, "/api/runs", { method: "POST", json: { quoteId: q.quoteId } });
    expect(res.status, await res.clone().text()).toBe(201);
    const after = await credits(ws).balance();
    expect((after.trial ?? 0) + after.held).toBe(TRIAL.credits);
    expect(after.trial).toBeLessThan(TRIAL.credits);


    // A run the trial credits cannot cover answers NO_PLAN with trial "used" (the join paywall), never a top-up.
    const big = await project(user, ws, [
      { kind: "video", title: "A", params: SHOT },
      { kind: "video", title: "B", params: { ...SHOT, prompt: "Pan left" } },
      { kind: "video", title: "C", params: { ...SHOT, prompt: "Pan right" } },
    ]);
    const q2 = await quote(user, { projectId: big.id, scope: "all" });
    expect(q2.total).toBeGreaterThan(TRIAL.credits);
    const res2 = await api(user, "/api/runs", { method: "POST", json: { quoteId: q2.quoteId } });
    expect(res2.status).toBe(402);
    expect(await res2.json()).toMatchObject({ error: { code: "NO_PLAN", data: { trial: "used" } } });
  });

  it("an expired trial answers NO_PLAN (trial expired) and its credits expire", async () => {
    const { user, ws } = await trialUser("expired", { expiresAt: Date.now() + 300 });
    const { id, ids } = await project(user, ws, [{ kind: "image", title: "Key", params: IMAGE }]);
    const q = await quote(user, { projectId: id, scope: "node", nodeIds: [ids.Key] });
    await new Promise((r) => setTimeout(r, 400));
    await env.DB.prepare("UPDATE trial_claims SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1, user).run();
    const res = await api(user, "/api/runs", { method: "POST", json: { quoteId: q.quoteId } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: "NO_PLAN", data: { trial: "expired" } } });
    // The DO alarm (or the next operation) expires what was left.
    const out = await credits(ws).expire();
    expect(out.ok).toBe(true);
    expect(await credits(ws).balance()).toMatchObject({ trial: 0, held: 0 });
    const lines = await trialLines(ws);
    expect(lines.at(-1)).toMatchObject({ kind: "expire", bucket: "trial", amount: -TRIAL.credits });
    expect(await credits(ws).trialStatus()).toBe("expired");
  });

  it("blocks mature content: the preference needs a plan, mature models are not in the trial", async () => {
    const { user, ws } = await trialUser("mature");
    const pref = await api(user, "/api/me/prefs", { method: "PATCH", json: { matureContent: true }, headers: { origin: ORIGIN } });
    expect(pref.status).toBe(402);
    expect(await pref.json()).toMatchObject({ error: { code: "NO_PLAN" } });
    const catalog = fixtureCatalog.models.filter((m) => m.id === "lumina/z-image-spicy");
    const q = await credits(ws).quote([{ ref: "m", modelId: "lumina/z-image-spicy", request: {} }], catalog);
    expect(q.ok && q.value.items[0]).toMatchObject({ blocked: "trial_locked", trialLock: "model" });
    expect((await getMeDev(user)).matureAllowed).toBe(false);
  });

  it("uses the agent with DeepSeek only, within the trial allowance", async () => {
    const { user, ws } = await trialUser("agent");
    const thread = await api(user, "/api/agent/threads", { method: "POST", json: { surface: "home" } });
    expect(thread.status, await thread.clone().text()).toBe(201);
    const threadId = ((await thread.json()) as any).thread.id;
    const other = await api(user, `/api/agent/threads/${threadId}/messages`, { method: "POST", json: { text: "Plan an ad", llm: "claude-opus-5.5" } });
    expect(other.status).toBe(402);
    expect(await other.json()).toMatchObject({ error: { code: "NO_PLAN", data: { trial: "active", feature: "agent_model" } } });
    const view = (await (await api(user, "/api/agent/allowance")).json()) as any;
    expect(view).toMatchObject({ trial: true, allowanceUsd: TRIAL.agentAllowanceUsd, usedUsd: 0 });
    expect(view.models.map((m: any) => m.id)).toEqual([TRIAL.agentLlm]);
    expect(view.models[0].turnsLeft).toBeGreaterThan(10);
    // Allowance used up (turn costs land in agent_usage).
    await env.DB.prepare("INSERT INTO agent_usage (turn_id, workspace_id, user_id, llm, period_start, cost_usd, status, created_at) VALUES (?, ?, ?, ?, 0, ?, 'unmetered', ?)")
      .bind(`evt_${ws}`, ws, user, TRIAL.agentLlm, TRIAL.agentAllowanceUsd, Date.now())
      .run();
    const used = await api(user, `/api/agent/threads/${threadId}/messages`, { method: "POST", json: { text: "Plan an ad" } });
    expect(used.status).toBe(402);
    expect(await used.json()).toMatchObject({ error: { code: "NO_PLAN", data: { trial: "agent_used" } } });
  });

  it("exports up to 720p; 1080p needs a plan", async () => {
    const { user, ws } = await trialUser("export");
    const p = await project(user, ws, [{ kind: "image", title: "Key", params: IMAGE }]);
    const hd = await api(user, `/api/canvases/${p.canvasId}/export`, { method: "POST", json: { preset: "mp4_1080p" } });
    expect(hd.status).toBe(402);
    expect(await hd.json()).toMatchObject({ error: { code: "NO_PLAN", data: { trial: "active", feature: "export_1080p" } } });
  });

  it("no top-ups and no team for trials", async () => {
    const { user } = await trialUser("topup");
    const r = await api(user, "/api/billing/checkout", { method: "POST", json: { kind: "topUp", amountCents: 1000 }, headers: { origin: ORIGIN } });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: { code: "NO_PLAN" } });
  });
});

async function getMeDev(user: string): Promise<any> {
  return (await api(user, "/api/me")).json();
}
