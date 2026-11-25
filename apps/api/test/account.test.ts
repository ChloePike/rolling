import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refusedSocket } from "./ws-helpers";
import worker from "../src/index";
import { emailProviderName, handleNotifyEmail, setEmailProviderForTests } from "../src/auth/email";
import { getAuth } from "../src/auth/betterAuth";
import { ResendEmailProvider } from "@rolling/core/email/resend";
import { RecordingEmailProvider } from "@rolling/core/email/recording";
import { BASE, freshEmail, freshIp, getMe, grantPlan, ORIGIN, signIn, waitForEmail } from "./auth-helpers";

async function call(req: Request, overrides: Partial<Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function send(method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("PATCH /api/me/prefs", () => {
  it("validates input", async () => {
    const { cookie } = await signIn(freshEmail("prefs-v"), { "cf-connecting-ip": freshIp() });
    for (const bad of [{}, { language: "xx" }, { theme: "blue" }, { confirmThreshold: -1 }, { confirmThreshold: 1.5 }, { defaultRatio: "3:2" }, { unknown: 1 }, { notifications: { done: "yes" } }]) {
      const res = await send("PATCH", "/api/me/prefs", cookie, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect((await send("PATCH", "/api/me/prefs", "", { theme: "dark" })).status).toBe(401);
  });

  it("persists changes and merges notifications", async () => {
    const { cookie } = await signIn(freshEmail("prefs-p"), { "cf-connecting-ip": freshIp() });
    const res = await send("PATCH", "/api/me/prefs", cookie, {
      language: "fr",
      currency: "EUR",
      creationMode: "advanced",
      defaultRatio: "16:9",
      defaultModel: "bytedance/seedance-2.5",
      confirmThreshold: 1000,
      theme: "light",
      notifications: { product: true },
    });
    expect(res.status).toBe(200);
    const expected = {
      language: "fr",
      currency: "EUR",
      creationMode: "advanced",
      defaultRatio: "16:9",
      defaultModel: "bytedance/seedance-2.5",
      confirmThreshold: 1000,
      notifications: { done: true, low: true, renewal: true, product: true },
      theme: "light",
      matureContent: false,
    };
    expect(await res.json()).toEqual({ prefs: expected, matureAllowed: false });
    expect((await getMe(cookie)).body.prefs).toEqual(expected);
  });

  it("pushes prefs.changed to the user's sockets", async () => {
    const { cookie } = await signIn(freshEmail("prefs-ws"), { "cf-connecting-ip": freshIp() });
    const res = await SELF.fetch(`${BASE}/api/ws`, { headers: { Upgrade: "websocket", cookie } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: any[] = [];
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
    ws.accept();
    await send("PATCH", "/api/me/prefs", cookie, { creationMode: "advanced" });
    const start = Date.now();
    while (!messages.some((m) => m.type === "prefs.changed") && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    const pushed = messages.find((m) => m.type === "prefs.changed");
    expect(pushed?.payload.prefs.creationMode).toBe("advanced");
    ws.close();
  });
});

describe("workspaces, invites and roles", () => {
  it("invites by email, accepts, switches workspace, and enforces roles", async () => {
    const ownerEmail = freshEmail("owner");
    const owner = await signIn(ownerEmail, { "cf-connecting-ip": freshIp() });
    const ownerMe = (await getMe(owner.cookie)).body;
    const ws = ownerMe.workspace.id;

    // D-013: only Team invites. Without a plan or on a personal plan (Pro included): TEAM_REQUIRED.
    const inviteeEmail = freshEmail("invitee");
    const none = await send("POST", "/api/workspace/invites", owner.cookie, { email: inviteeEmail, role: "editor" });
    expect(none.status).toBe(402);
    expect(await none.json()).toMatchObject({ error: { code: "TEAM_REQUIRED", data: { currentPlan: null } } });
    await grantPlan(ws, "pro");
    expect(await (await send("POST", "/api/workspace/invites", owner.cookie, { email: inviteeEmail, role: "editor" })).json()).toMatchObject({ error: { code: "TEAM_REQUIRED", data: { currentPlan: "pro" } } });
    // Team with one seat (the owner): SEATS_REQUIRED.
    await grantPlan(ws, "team", "active", 1);
    const full = await send("POST", "/api/workspace/invites", owner.cookie, { email: inviteeEmail, role: "editor" });
    expect(full.status).toBe(402);
    expect(await full.json()).toMatchObject({ error: { code: "SEATS_REQUIRED", data: { seats: 1, used: 1, needed: 2 } } });
    await grantPlan(ws, "team", "active", 2);

    const created = await send("POST", "/api/workspace/invites", owner.cookie, { email: inviteeEmail.toUpperCase(), role: "editor" });
    expect(created.status).toBe(201);
    const { invite } = (await created.json()) as any;
    expect(invite).toMatchObject({ email: inviteeEmail, role: "editor", invitedBy: ownerMe.user.id });
    expect(invite.id).toMatch(/^inv_/);
    const [mail] = await waitForEmail(inviteeEmail);
    expect(mail!.subject).toBe(`A teammate invited you to Personal on Rolling`);
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;

    const lookup = await SELF.fetch(`${BASE}/api/workspace/invites/lookup?token=${token}`);
    expect(await lookup.json()).toMatchObject({ workspace: { id: ws }, email: inviteeEmail, role: "editor", state: "pending" });

    const members = await (await send("GET", "/api/workspace/members", owner.cookie)).json() as any;
    expect(members.invites).toHaveLength(1);
    expect(members.seats).toEqual({ used: 2, limit: 2, team: true });

    // Someone else cannot accept it.
    const stranger = await signIn(freshEmail("stranger"), { "cf-connecting-ip": freshIp() });
    expect((await send("POST", "/api/workspace/invites/accept", stranger.cookie, { token })).status).toBe(403);

    const invitee = await signIn(inviteeEmail, { "cf-connecting-ip": freshIp() });
    const accepted = await send("POST", "/api/workspace/invites/accept", invitee.cookie, { token });
    expect(await accepted.json()).toEqual({ workspace: { id: ws, name: "Personal", kind: "personal" }, role: "editor" });
    expect((await send("POST", "/api/workspace/invites/accept", invitee.cookie, { token })).status).toBe(409);

    // Default is the invitee's own workspace; x-workspace-id switches.
    const own = (await getMe(invitee.cookie)).body;
    expect(own.role).toBe("owner");
    expect(own.workspaces.map((w: any) => w.id)).toEqual([own.workspace.id, ws]);
    const switched = (await getMe(invitee.cookie, { "x-workspace-id": ws })).body;
    expect(switched).toMatchObject({ workspace: { id: ws }, role: "editor", isMember: true, plan: { id: "team" } });
    const foreign = await getMe(invitee.cookie, { "x-workspace-id": "ws_01J0000000000000000000000Z" });
    expect(foreign.res.status).toBe(403);
    expect(foreign.body.error.code).toBe("FORBIDDEN");
    expect((await getMe(invitee.cookie, { "x-workspace-id": "bad id" })).res.status).toBe(400);

    // Editors cannot manage members.
    const inWs = { "x-workspace-id": ws };
    expect((await send("PATCH", `/api/workspace/members/${ownerMe.user.id}`, invitee.cookie, { role: "viewer" }, inWs)).status).toBe(403);
    expect((await send("POST", "/api/workspace/invites", invitee.cookie, { email: freshEmail(), role: "viewer" }, inWs)).status).toBe(403);

    // Owner sets role and monthly limit.
    const patched = await send("PATCH", `/api/workspace/members/${own.user.id}`, owner.cookie, { role: "viewer", monthlyCreditLimit: 500 });
    expect(await patched.json()).toEqual({ member: { userId: own.user.id, role: "viewer", monthlyCreditLimit: 500 } });
    const list = (await (await send("GET", "/api/workspace/members", invitee.cookie, undefined, inWs)).json()) as any;
    expect(list.members.find((m: any) => m.userId === own.user.id)).toMatchObject({ role: "viewer", monthlyCreditLimit: 500, email: inviteeEmail, isYou: true });
    expect(list.invites).toEqual([]); // only owners see invites
    expect((await send("PATCH", `/api/workspace/members/${own.user.id}`, owner.cookie, { monthlyCreditLimit: -5 })).status).toBe(400);

    // The last owner cannot step down; the member can leave.
    expect((await send("PATCH", `/api/workspace/members/${ownerMe.user.id}`, owner.cookie, { role: "editor" })).status).toBe(409);
    expect((await send("DELETE", `/api/workspace/members/${own.user.id}`, invitee.cookie, undefined, inWs)).status).toBe(200);
    expect((await getMe(invitee.cookie, inWs)).res.status).toBe(403);
    // Nobody leaves their own personal workspace.
    expect((await send("DELETE", `/api/workspace/members/${own.user.id}`, invitee.cookie)).status).toBe(409);
  });

  it("re-inviting replaces the pending invite; owners can revoke", async () => {
    const owner = await signIn(freshEmail("owner2"), { "cf-connecting-ip": freshIp() });
    const ws = (await getMe(owner.cookie)).body.workspace.id;
    await grantPlan(ws, "team", "active", 2);
    const email = freshEmail("re");
    const a = (await (await send("POST", "/api/workspace/invites", owner.cookie, { email, role: "viewer" })).json()) as any;
    const b = (await (await send("POST", "/api/workspace/invites", owner.cookie, { email, role: "editor" })).json()) as any;
    const list = (await (await send("GET", "/api/workspace/members", owner.cookie)).json()) as any;
    expect(list.invites.map((i: any) => i.id)).toEqual([b.invite.id]);
    expect((await send("DELETE", `/api/workspace/invites/${b.invite.id}`, owner.cookie)).status).toBe(200);
    expect((await send("DELETE", `/api/workspace/invites/${a.invite.id}`, owner.cookie)).status).toBe(404);
  });
});

describe("WebSocket auth", () => {
  it("/api/ws requires a session (accepted, error, closed 4401)", async () => {
    const res = await SELF.fetch(`${BASE}/api/ws`, { headers: { Upgrade: "websocket" } });
    const refused = await refusedSocket(res);
    expect(refused).toMatchObject({ closeCode: 4401, error: { code: "UNAUTHENTICATED" } });
  });

  it("/api/ws refuses a workspace the user is not in with 4403", async () => {
    const a = await signIn(freshEmail("wsf"), { "cf-connecting-ip": freshIp() });
    const res = await SELF.fetch(`${BASE}/api/ws?workspaceId=ws_not_mine`, { headers: { Upgrade: "websocket", cookie: a.cookie } });
    expect(await refusedSocket(res)).toMatchObject({ closeCode: 4403, error: { code: "FORBIDDEN" } });
  });

  it("/api/projects/:id/ws requires a session and workspace access", async () => {
    const a = await signIn(freshEmail("wsa"), { "cf-connecting-ip": freshIp() });
    const b = await signIn(freshEmail("wsb"), { "cf-connecting-ip": freshIp() });
    const wsA = (await getMe(a.cookie)).body.workspace.id;
    const userA = (await getMe(a.cookie)).body.user.id;
    await env.DB.prepare("INSERT INTO projects (id, workspace_id, title, created_by, updated_at) VALUES ('prj_ws_auth', ?1, 'P', ?2, 0)").bind(wsA, userA).run();
    const open = (cookie?: string) => SELF.fetch(`${BASE}/api/projects/prj_ws_auth/ws`, { headers: { Upgrade: "websocket", ...(cookie ? { cookie } : {}) } });

    expect(await refusedSocket(await open())).toMatchObject({ closeCode: 4401, error: { code: "UNAUTHENTICATED" } });
    expect(await refusedSocket(await open(b.cookie))).toMatchObject({ closeCode: 4404, error: { code: "NOT_FOUND" } });
    const missing = await SELF.fetch(`${BASE}/api/projects/prj_missing/ws`, { headers: { Upgrade: "websocket", cookie: a.cookie } });
    expect((await refusedSocket(missing)).closeCode).toBe(4404);
    // A member passes the routing layer: the request reaches ProjectRoom, which owns the
    // room state (this row was inserted directly, so the room itself refuses with 4404).
    const member = await open(a.cookie);
    expect(member.headers.get("content-type") ?? "").not.toContain("application/json");
    expect((await refusedSocket(member)).closeCode).toBe(4404);
  });
});

describe("notify-email consumer and providers", () => {
  afterEach(() => {
    setEmailProviderForTests(null);
    vi.restoreAllMocks();
  });

  it("sends through Resend with the API key, sender and idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ id: "re_1" });
    }) as unknown as typeof fetch;
    setEmailProviderForTests(new ResendEmailProvider({ apiKey: "re_test", from: "Rolling <hi@example.com>", fetch: fake }));
    const batch = createMessageBatch("rolling-dev-notify-email", [
      { id: "e1", timestamp: new Date(), attempts: 1, body: { to: "a@example.com", template: "sign-in-code", data: { code: "123456", expiresInMinutes: 10 } } },
      { id: "e2", timestamp: new Date(), attempts: 1, body: { to: "a@example.com", template: "nope", data: {} } },
      { id: "e3", timestamp: new Date(), attempts: 1, body: { template: "sign-in-code", data: {} } },
      { id: "e4", timestamp: new Date(), attempts: 1, body: { to: "a@example.com", template: "sign-in-code", data: { code: "x" } } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test");
    expect(headers["idempotency-key"]).toBe("email:e1");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ from: "Rolling <hi@example.com>", to: ["a@example.com"], subject: "Your Rolling sign-in code is 123456" });
  });

  it("retries on provider 5xx and drops on 4xx", async () => {
    let status = 503;
    const fake = (async () => new Response("err", { status })) as unknown as typeof fetch;
    setEmailProviderForTests(new ResendEmailProvider({ apiKey: "k", from: "f@example.com", fetch: fake }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = { to: "a@example.com", template: "sign-in-code", data: { code: "123456", expiresInMinutes: 10 } };
    for (const [s, expectRetry] of [[503, true], [422, false]] as const) {
      status = s;
      const batch = createMessageBatch("rolling-dev-notify-email", [{ id: `r${s}`, timestamp: new Date(), attempts: 1, body }]);
      const ctx = createExecutionContext();
      await handleNotifyEmail(batch, env);
      const result = await getQueueResult(batch, ctx);
      expect(result.retryMessages.length > 0, String(s)).toBe(expectRetry);
      expect(result.explicitAcks.length > 0, String(s)).toBe(!expectRetry);
    }
  });

  it("resolves the recipient from userId", async () => {
    const email = freshEmail("byid");
    const { cookie } = await signIn(email, { "cf-connecting-ip": freshIp() });
    const userId = (await getMe(cookie)).body.user.id;
    const before = RecordingEmailProvider.to(email).length;
    const batch = createMessageBatch("rolling-dev-notify-email", [
      { id: "u1", timestamp: new Date(), attempts: 1, body: { userId, template: "sign-in-code", data: { code: "654321", expiresInMinutes: 10 } } },
    ]);
    await handleNotifyEmail(batch, env);
    expect(RecordingEmailProvider.to(email).length).toBe(before + 1);
  });
});

describe("test-inbox email provider", () => {
  const inboxEnv = { EMAIL_PROVIDER: "test-inbox", TEST_INBOX_TOKEN: "s3cret-token" } as unknown as Partial<Env>;

  it("is refused in production", async () => {
    expect(() => emailProviderName({ ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "test-inbox" } as unknown as Env)).toThrow(/refused in production/);
    expect(() => emailProviderName({ ...env, ENVIRONMENT: "staging", EMAIL_PROVIDER: "test-inbox" } as unknown as Env)).not.toThrow();
    await expect(getAuth({ ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "test-inbox", BETTER_AUTH_SECRET: "x".repeat(32) } as unknown as Env)).rejects.toThrow(/refused in production/);
    const res = await call(new Request(`${BASE}/api/test/inbox?to=a@example.com`, { headers: { authorization: "Bearer s3cret-token" } }), {
      ...inboxEnv,
      ENVIRONMENT: "production",
    } as unknown as Partial<Env>);
    expect(res.status).toBe(404);
  });

  it("answers 404 when the provider is not test-inbox", async () => {
    const res = await SELF.fetch(`${BASE}/api/test/inbox?to=a@example.com`, { headers: { authorization: "Bearer s3cret-token" } });
    expect(res.status).toBe(404);
  });

  it("checks the bearer token and returns the latest code", async () => {
    const to = freshEmail("inbox");
    const inboxFull = { ...env, ...inboxEnv, ENVIRONMENT: "staging" } as unknown as Env;
    for (const [id, code] of [["i1", "111111"], ["i2", "222222"]] as const) {
      const batch = createMessageBatch("rolling-staging-notify-email", [
        { id, timestamp: new Date(), attempts: 1, body: { to, template: "sign-in-code", data: { code, expiresInMinutes: 10 } } },
      ]);
      await handleNotifyEmail(batch, inboxFull);
      await new Promise((r) => setTimeout(r, 2));
    }
    const url = `${BASE}/api/test/inbox?to=${encodeURIComponent(to.toUpperCase())}`;
    expect((await call(new Request(url), inboxFull)).status).toBe(401);
    expect((await call(new Request(url, { headers: { authorization: "Bearer wrong" } }), inboxFull)).status).toBe(401);
    const ok = await call(new Request(url, { headers: { authorization: "Bearer s3cret-token" } }), inboxFull);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.messages.map((m: any) => m.code)).toEqual(["222222", "111111"]);
    expect(body.messages[0]).toMatchObject({ to, template: "sign-in-code", subject: "Your Rolling sign-in code is 222222" });
    // Older than 24 h: gone.
    await env.DB.prepare("UPDATE test_inbox SET sent_at = 0 WHERE to_email = ?1").bind(to).run();
    const empty = await call(new Request(url, { headers: { authorization: "Bearer s3cret-token" } }), inboxFull);
    expect(((await empty.json()) as any).messages).toEqual([]);
  });
});
