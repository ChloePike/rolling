/**
 * Profiles, avatars, share settings, feedback, invite credit limits, card on
 * file, email change and account deletion (workers pool). Session users sign
 * in with the email code; Stripe is the in-memory fake; the safety LLM is a
 * scripted fake.
 */
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import type { ChatEvent, ChatRequest, LlmProvider } from "@rolling/core";
import { RecordingEmailProvider } from "@rolling/core/email/recording";
import { tombstoneUserId } from "@rolling/core/privacy";
import worker from "../src/index";
import { personalWorkspaceId } from "../src/auth/workspace";
import { runR2Cleanup } from "../src/auth/deleteAccount";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { processAsset } from "../src/queues/mediaProcess";
import { setSafetyLlmForTests } from "../src/safety/service";
import { clearPriceCache } from "../src/billing/stripe";
import { BASE, codeFrom, cookieFrom, freshEmail, freshIp, getMe, grantPlan, ORIGIN, signIn, waitForEmail } from "./auth-helpers";
import { FakeStripe, stripeEnv } from "./fake-stripe";

// ---------------------------------------------------------------- fakes

const vision = { rating: "safe" as "safe" | "suggestive" | "explicit" | "error" };

const fakeSafetyLlm: LlmProvider = {
  id: "fake-safety",
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const user = req.messages.find((m) => m.role === "user")!;
    const images = typeof user.content === "string" ? 0 : user.content.filter((p) => p.type === "image_url").length;
    if (images > 0 && vision.rating === "error") return yield { type: "error", error: { code: "upstream_error", message: "down", retryable: true } };
    const image = {
      rating: vision.rating,
      confidence: 0.9,
      photographic: false,
      apparentMinor: false,
      minorSexualized: false,
      knownPerson: false,
      extremeViolence: false,
      violentExtremism: false,
      animalSexual: false,
      selfHarm: false,
    };
    const text = {
      sexualLevel: "none",
      apparentMinor: false,
      minorSexualized: false,
      realPerson: false,
      realPersonNames: [],
      realPersonSexualOrIntimate: false,
      nonConsensualSexual: false,
      extremeViolence: false,
      violentExtremism: false,
      animalSexual: false,
      selfHarm: false,
    };
    yield { type: "text", delta: JSON.stringify(images > 0 ? { images: Array.from({ length: images }, () => image) } : text) };
    yield { type: "done", id: "s", finishReason: "stop" };
  },
};

const stripe = new FakeStripe();

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, {
    fetch: (async () => new Response(JSON.stringify(listing), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  setSafetyLlmForTests(() => fakeSafetyLlm);
  vi.stubGlobal("fetch", stripe.fetch);
  clearPriceCache();
});
afterAll(() => {
  setSafetyLlmForTests(null);
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vision.rating = "safe";
});

// ---------------------------------------------------------------- helpers

async function call(req: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...stripeEnv, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function send(cookie: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  const h: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": freshIp(), ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  return call(new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), overrides);
}

async function user(tag: string) {
  const email = freshEmail(tag);
  const { cookie } = await signIn(email, { "cf-connecting-ip": freshIp() });
  const { body } = await getMe(cookie);
  return { email, cookie, userId: body.user.id as string, ws: body.workspace.id as string };
}

let pngSeq = 0;
function png(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(1024 + (++pngSeq % 97));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < b.length; i++) b[i] = (i * 7 + pngSeq) % 251;
  return b;
}

/** Uploads through the dev Worker-proxy path; returns the asset id. */
async function upload(cookie: string, bytes: Uint8Array<ArrayBuffer> = png(), name = "photo.png", contentType = "image/png"): Promise<string> {
  const start = await send(cookie, "POST", "/api/assets/uploads", { filename: name, contentType, size: bytes.byteLength });
  expect(start.status, await start.clone().text()).toBe(201);
  const { assetId } = (await start.json()) as { assetId: string };
  const urls = (await (await send(cookie, "POST", `/api/assets/uploads/${assetId}/part-urls`, { partNumbers: [1] })).json()) as any;
  const put = await call(new Request(`${BASE}${urls.urls[0].url}`, { method: "PUT", headers: { cookie, "content-length": String(bytes.byteLength) }, body: bytes }));
  expect(put.status, await put.clone().text()).toBe(200);
  expect((await send(cookie, "POST", `/api/assets/uploads/${assetId}/complete`)).status).toBe(200);
  return assetId;
}

// ---------------------------------------------------------------- profile

describe("PATCH /api/me/profile", () => {
  it("updates name, handle and bio; /api/me and the public profile read them", async () => {
    const a = await user("prof");
    const res = await send(a.cookie, "PATCH", "/api/me/profile", { name: "Ada L", handle: "@Ada.Builds", bio: "Makes ads." });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).profile).toMatchObject({ name: "Ada L", handle: "ada.builds", bio: "Makes ads." });
    const me = (await getMe(a.cookie)).body;
    expect(me.user).toMatchObject({ name: "Ada L", handle: "ada.builds", bio: "Makes ads." });

    const pub = await SELF.fetch(`${BASE}/api/profiles/ADA.builds`);
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ name: "Ada L", handle: "ada.builds", bio: "Makes ads.", avatarUrl: null, works: [], templates: [], isYou: false });
    const own = (await (await send(a.cookie, "GET", "/api/profiles/ada.builds")).json()) as any;
    expect(own.isYou).toBe(true);

    // Empty bio clears it.
    await send(a.cookie, "PATCH", "/api/me/profile", { bio: "" });
    expect((await getMe(a.cookie)).body.user.bio).toBeNull();
  });

  it("validates input and refuses taken (case-insensitive) and reserved handles with HANDLE_TAKEN", async () => {
    const a = await user("hta");
    const b = await user("htb");
    const handle = `taken_${Date.now().toString(36)}`;
    expect((await send(a.cookie, "PATCH", "/api/me/profile", { handle })).status).toBe(200);
    for (const h of [handle.toUpperCase(), "admin", "Settings"]) {
      const res = await send(b.cookie, "PATCH", "/api/me/profile", { handle: h });
      expect(res.status, h).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "HANDLE_TAKEN" } });
    }
    for (const bad of [{ handle: "ab" }, { handle: "has space" }, { handle: "x".repeat(31) }, { name: "" }, { bio: "x".repeat(161) }, {}, { email: "x@y.z" }]) {
      const res = await send(b.cookie, "PATCH", "/api/me/profile", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // Keeping your own handle is fine.
    expect((await send(a.cookie, "PATCH", "/api/me/profile", { handle: handle.toUpperCase() })).status).toBe(200);
    expect((await send(null, "PATCH", "/api/me/profile", { bio: "x" })).status).toBe(401);
  });

  it("unknown handles are 404", async () => {
    expect((await SELF.fetch(`${BASE}/api/profiles/nobody_${Date.now()}`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/profiles/a`)).status).toBe(404);
  });
});

describe("avatars", () => {
  it("accepts the caller's safe image and serves it through a redirect to a signed URL", async () => {
    const a = await user("ava");
    const assetId = await upload(a.cookie);
    const res = await send(a.cookie, "PATCH", "/api/me/profile", { avatarAssetId: assetId });
    expect(res.status, await res.clone().text()).toBe(200);
    const image = ((await res.json()) as any).profile.image as string;
    expect(image).toMatch(new RegExp(`^/api/media/avatar/${a.userId}\\?v=`));
    expect((await getMe(a.cookie)).body.user.image).toBe(image);

    const redirect = await send(null, "GET", image);
    expect(redirect.status).toBe(302);
    const signed = redirect.headers.get("location")!;
    expect(signed).toMatch(new RegExp(`^/media/ws/${personalWorkspaceId(a.userId)}/avatars/${assetId}\\.`));
    expect((await SELF.fetch(`${BASE}${signed}`)).status).toBe(200);

    // Removing it clears the image and the route.
    await send(a.cookie, "PATCH", "/api/me/profile", { avatarAssetId: null });
    expect((await getMe(a.cookie)).body.user.image).toBeNull();
    expect((await send(null, "GET", `/api/media/avatar/${a.userId}`)).status).toBe(404);
  });

  it("refuses suggestive and explicit images (D-005) and someone else's asset", async () => {
    const a = await user("avb");
    const b = await user("avc");
    vision.rating = "explicit";
    const spicy = await upload(a.cookie);
    const res = await send(a.cookie, "PATCH", "/api/me/profile", { avatarAssetId: spicy });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "AVATAR_REJECTED", data: { reason: "rating", rating: "explicit" } } });
    vision.rating = "suggestive";
    const hint = await upload(a.cookie);
    expect((await send(a.cookie, "PATCH", "/api/me/profile", { avatarAssetId: hint })).status).toBe(422);
    vision.rating = "safe";
    const mine = await upload(a.cookie);
    expect((await send(b.cookie, "PATCH", "/api/me/profile", { avatarAssetId: mine })).status).toBe(404);
    expect((await getMe(a.cookie)).body.user.image).toBeNull();
  });

  it("fails closed when the classifier is down (SAFETY_UNAVAILABLE)", async () => {
    const a = await user("avd");
    vision.rating = "error";
    const id = await upload(a.cookie);
    await env.DB.prepare("UPDATE assets SET rating = NULL WHERE id = ?").bind(id).run();
    const res = await send(a.cookie, "PATCH", "/api/me/profile", { avatarAssetId: id });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "SAFETY_UNAVAILABLE" } });
  });
});

// ---------------------------------------------------------------- share settings and profile works

async function projectWithOutput(cookie: string, rating: "safe" | "suggestive" = "safe") {
  const created = await send(cookie, "POST", "/api/projects", { title: "Launch ad" });
  const projectId = ((await created.json()) as any).project.id as string;
  const patch = await send(cookie, "POST", `/api/projects/${projectId}/patch`, {
    baseRevision: 0,
    ops: [{ op: "addNode", tempId: "img", kind: "image", title: "Shot", params: { prompt: "a bottle on a desk", negativePrompt: "blur", model: "x" } }],
  });
  const { idMap } = (await patch.json()) as any;
  vision.rating = rating;
  const assetId = await upload(cookie);
  // Run the media-process consumer now (it rates the upload, D-005).
  const row = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string }>();
  await processAsset(env, { assetId, r2Key: row!.r2_key, kind: "image" });
  vision.rating = "safe";
  await projectRoom(env, projectId).addVersion({ nodeId: idMap.img, assetId, inputDigest: `dg_${assetId}` });
  return { projectId, assetId };
}

describe("share settings", () => {
  it("GET/POST/PATCH share: defaults, settings kept across re-publish, toggles without re-publishing", async () => {
    const a = await user("shs");
    const { projectId } = await projectWithOutput(a.cookie);
    const empty = (await (await send(a.cookie, "GET", `/api/projects/${projectId}/share`)).json()) as any;
    // Never shared: not "revoked" (the dialog shows the first-share state, not "the old link no longer opens").
    expect(empty).toEqual({ enabled: false, shareId: null, url: null, snapshotAt: null, revoked: false, audience: "link", allowDownload: false, showPrompt: true, showOnProfile: false });
    expect((await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, { allowDownload: true })).status).toBe(404);

    const created = (await (await send(a.cookie, "POST", `/api/projects/${projectId}/share`, { allowDownload: true, showPrompt: false })).json()) as any;
    expect(created).toMatchObject({ shareId: expect.stringMatching(/^shr_/), allowDownload: true, showPrompt: false, audience: "link", showOnProfile: false });
    const pub = (await (await SELF.fetch(`${BASE}/api/share/${created.shareId}`)).json()) as any;
    expect(JSON.stringify(pub.nodes)).not.toContain("a bottle on a desk");
    expect(pub.nodes[0].params).toEqual({ model: "x" });

    const state = (await (await send(a.cookie, "GET", `/api/projects/${projectId}/share`)).json()) as any;
    expect(state).toMatchObject({ enabled: true, shareId: created.shareId, allowDownload: true, showPrompt: false, snapshotAt: created.createdAt });

    // PATCH keeps the snapshot (same snapshotAt) and changes flags.
    const patched = (await (await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, { allowDownload: false, showOnProfile: true })).json()) as any;
    expect(patched).toMatchObject({ allowDownload: false, showOnProfile: true, showPrompt: false, snapshotAt: created.createdAt });
    // Re-publishing with prompts on includes them; unspecified settings stay.
    const again = (await (await send(a.cookie, "POST", `/api/projects/${projectId}/share`, { showPrompt: true })).json()) as any;
    expect(again).toMatchObject({ shareId: created.shareId, showPrompt: true, showOnProfile: true, allowDownload: false });
    const pub2 = (await (await SELF.fetch(`${BASE}/api/share/${created.shareId}`)).json()) as any;
    expect(pub2.nodes[0].params.prompt).toBe("a bottle on a desk");
    // Turning prompts off hides them at once.
    await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, { showPrompt: false });
    expect(((await (await SELF.fetch(`${BASE}/api/share/${created.shareId}`)).json()) as any).nodes[0].params.prompt).toBeUndefined();
    expect((await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, {})).status).toBe(400);
    expect((await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, { audience: "public" })).status).toBe(400);
    // Stopped: no link, and the state says it was revoked.
    expect((await send(a.cookie, "DELETE", `/api/projects/${projectId}/share`)).status).toBe(200);
    expect(await (await send(a.cookie, "GET", `/api/projects/${projectId}/share`)).json()).toMatchObject({ enabled: false, url: null, revoked: true });
  });

  it("workspace-only links open for signed-in members only", async () => {
    const a = await user("shw");
    const b = await user("shx");
    const { projectId } = await projectWithOutput(a.cookie);
    const { shareId } = (await (await send(a.cookie, "POST", `/api/projects/${projectId}/share`, { audience: "workspace" })).json()) as any;
    expect((await SELF.fetch(`${BASE}/api/share/${shareId}`)).status).toBe(404);
    expect((await send(b.cookie, "GET", `/api/share/${shareId}`)).status).toBe(404);
    const own = await send(a.cookie, "GET", `/api/share/${shareId}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ audience: "workspace" });
    await send(a.cookie, "PATCH", `/api/projects/${projectId}/share`, { audience: "link" });
    expect((await SELF.fetch(`${BASE}/api/share/${shareId}`)).status).toBe(200);
  });

  it("published works appear on the profile only with a safe cover (D-005)", async () => {
    const a = await user("pw");
    const handle = `pw_${Date.now().toString(36)}`;
    await send(a.cookie, "PATCH", "/api/me/profile", { handle });
    const safe = await projectWithOutput(a.cookie, "safe");
    const hot = await projectWithOutput(a.cookie, "suggestive");
    const hidden = await projectWithOutput(a.cookie, "safe");
    await send(a.cookie, "POST", `/api/projects/${safe.projectId}/share`, { showOnProfile: true });
    await send(a.cookie, "POST", `/api/projects/${hot.projectId}/share`, { showOnProfile: true });
    await send(a.cookie, "POST", `/api/projects/${hidden.projectId}/share`, {});
    const profile = (await (await SELF.fetch(`${BASE}/api/profiles/${handle}`)).json()) as any;
    expect(profile.works).toHaveLength(1);
    expect(profile.works[0]).toMatchObject({ title: "Launch ad", kind: "image", coverUrl: expect.stringMatching(/^\/media\//), url: expect.stringContaining("/share/") });
    expect(JSON.stringify(profile)).not.toContain(hot.assetId);

    // Marked mature later: gone from the profile at once.
    await env.DB.prepare("UPDATE assets SET mature = 1 WHERE id = ?").bind(safe.assetId).run();
    expect(((await (await SELF.fetch(`${BASE}/api/profiles/${handle}`)).json()) as any).works).toEqual([]);
  });
});

// ---------------------------------------------------------------- feedback

describe("POST /api/feedback", () => {
  it("stores feedback with server-side diagnostics, emails FEEDBACK_TO and rate limits", async () => {
    const a = await user("fb");
    const to = freshEmail("feedback-inbox");
    const res = await send(a.cookie, "POST", "/api/feedback", { message: "Export button does nothing", page: "/editor/x", kind: "bug", includeDiagnostics: true }, { "user-agent": "TestAgent/1" }, { FEEDBACK_TO: to });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = (await res.json()) as any;
    const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(id).first<any>();
    expect(row).toMatchObject({ user_id: a.userId, kind: "bug", message: "Export button does nothing", page: "/editor/x" });
    expect(JSON.parse(row.diagnostics)).toMatchObject({ userAgent: "TestAgent/1", workspaceId: a.ws });
    const mail = await waitForEmail(to);
    expect(mail[0]!.subject).toContain("bug: Export button does nothing");

    const plain = await send(a.cookie, "POST", "/api/feedback", { message: "Nice", kind: "idea" });
    const plainRow = await env.DB.prepare("SELECT diagnostics FROM feedback WHERE id = ?").bind(((await plain.json()) as any).id).first<any>();
    expect(plainRow.diagnostics).toBeNull();

    for (const bad of [{ message: "" }, { message: "x", kind: "rant" }, { message: "x", extra: 1 }]) expect((await send(a.cookie, "POST", "/api/feedback", bad)).status).toBe(400);
    expect((await send(null, "POST", "/api/feedback", { message: "x" })).status).toBe(401);
    for (let i = 0; i < 8; i++) await send(a.cookie, "POST", "/api/feedback", { message: `n${i}` });
    const limited = await send(a.cookie, "POST", "/api/feedback", { message: "one more" });
    expect(limited.status).toBe(429);
  });
});

// ---------------------------------------------------------------- invites with a credit limit

describe("invite monthly credit limit", () => {
  it("is stored on the invite and applied on accept", async () => {
    const owner = await user("ilo");
    await grantPlan(owner.ws, "team", "active", 3);
    const guest = await user("ilg");
    const inv = await send(owner.cookie, "POST", "/api/workspace/invites", { email: guest.email, role: "editor", monthlyCreditLimit: 500 });
    expect(inv.status, await inv.clone().text()).toBe(201);
    expect(((await inv.json()) as any).invite.monthlyCreditLimit).toBe(500);
    const mail = await waitForEmail(guest.email, 2);
    const token = /\/invite\/([^\s]+)/.exec(mail[mail.length - 1]!.text)![1]!;
    expect((await send(guest.cookie, "POST", "/api/workspace/invites/accept", { token: decodeURIComponent(token) })).status).toBe(200);
    const members = (await (await send(owner.cookie, "GET", "/api/workspace/members")).json()) as any;
    expect(members.members.find((m: any) => m.userId === guest.userId)).toMatchObject({ role: "editor", monthlyCreditLimit: 500 });
    expect((await send(owner.cookie, "POST", "/api/workspace/invites", { email: freshEmail("x"), role: "viewer", monthlyCreditLimit: -1 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------- card on file

describe("GET /api/billing/payment-method", () => {
  it("reads brand, last4 and expiry of the customer's default card; null without a customer", async () => {
    const a = await user("pm");
    expect(await (await send(a.cookie, "GET", "/api/billing/payment-method")).json()).toEqual({ paymentMethod: null });
    const customer = await (await stripe.fetch("https://stripe.test/v1/customers", { method: "POST", headers: { authorization: `Bearer ${stripeEnv.STRIPE_SECRET_KEY}` }, body: "" })).json() as any;
    stripe.customers.get(customer.id)!.default_payment_method = "pm_card_visa";
    await env.DB.prepare("UPDATE workspaces SET stripe_customer_id = ? WHERE id = ?").bind(customer.id, a.ws).run();
    const res = (await (await send(a.cookie, "GET", "/api/billing/payment-method")).json()) as any;
    expect(res.paymentMethod).toEqual({ id: "pm_card_visa", type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030, wallet: null });
  });
});

// ---------------------------------------------------------------- email change

describe("email change (Better Auth email OTP)", () => {
  it("sends a code to the new address and switches the email after verification", async () => {
    const a = await user("chg");
    const next = freshEmail("chg-new");
    const req = await send(a.cookie, "POST", "/api/auth/email-otp/request-email-change", { newEmail: next });
    expect(req.status, await req.clone().text()).toBe(200);
    const mail = await waitForEmail(next);
    const code = codeFrom(mail[0]!.text);
    const wrong = await send(a.cookie, "POST", "/api/auth/email-otp/change-email", { newEmail: next, otp: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: "INVALID_CODE" } });
    const ok = await send(a.cookie, "POST", "/api/auth/email-otp/change-email", { newEmail: next, otp: code });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const cookie = cookieFrom(ok) || a.cookie;
    expect((await getMe(cookie)).body.user).toMatchObject({ email: next, emailVerified: true });
    // The old address no longer signs in to this account; the new one does.
    const again = await signIn(next, { "cf-connecting-ip": freshIp() });
    expect((await getMe(again.cookie)).body.user.id).toBe(a.userId);
  });

  it("validates and rate limits the request", async () => {
    const a = await user("chv");
    expect((await send(a.cookie, "POST", "/api/auth/email-otp/request-email-change", { newEmail: "nope" })).status).toBe(400);
    const next = freshEmail("chv-new");
    expect((await send(a.cookie, "POST", "/api/auth/email-otp/request-email-change", { newEmail: next })).status).toBe(200);
    const again = await send(a.cookie, "POST", "/api/auth/email-otp/request-email-change", { newEmail: next });
    expect(again.status).toBe(429);
    expect((await send(null, "POST", "/api/auth/email-otp/request-email-change", { newEmail: freshEmail("z") })).status).toBe(401);
  });
});

// ---------------------------------------------------------------- account deletion

async function deleteCode(a: { cookie: string; email: string }): Promise<string> {
  const before = RecordingEmailProvider.to(a.email).length;
  const res = await send(a.cookie, "POST", "/api/me/delete/send-code");
  expect(res.status, await res.clone().text()).toBe(200);
  const mail = await waitForEmail(a.email, before + 1);
  return codeFrom(mail[mail.length - 1]!.text);
}

describe("account deletion", () => {
  it("Better Auth delete-user is only reachable through the code flow", async () => {
    const a = await user("dblk");
    expect((await send(a.cookie, "POST", "/api/auth/delete-user", {})).status).toBe(404);
    expect((await getMe(a.cookie)).res.status).toBe(200);
  });

  it("refuses OWNER_OF_TEAM while a Team has other members and no other owner", async () => {
    const owner = await user("dto");
    await grantPlan(owner.ws, "team", "active", 2);
    await env.DB.prepare("UPDATE workspaces SET kind = 'team' WHERE id = ?").bind(owner.ws).run();
    await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, 'usr_other_member', 'editor')").bind(owner.ws).run();
    const res = await send(owner.cookie, "POST", "/api/me/delete/send-code");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "OWNER_OF_TEAM", data: { workspaces: [{ id: owner.ws, members: 2 }] } } });
    // After transferring ownership (another owner), deletion proceeds and the team stays.
    await env.DB.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = 'usr_other_member'").bind(owner.ws).run();
    const code = await deleteCode(owner);
    expect((await send(owner.cookie, "POST", "/api/me/delete", { code })).status).toBe(200);
    expect(await env.DB.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").bind(owner.ws).first()).toEqual({ deleted_at: null });
    expect(await env.DB.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ?").bind(owner.ws).all().then((r) => r.results)).toEqual([{ user_id: "usr_other_member" }]);
  });

  it("verifies the code, cancels the plan at period end, removes data, pseudonymises ledger lines and ends sessions", async () => {
    const a = await user("del");
    await env.DB.exec("DELETE FROM auth_email_sends");
    const second = await signIn(a.email, { "cf-connecting-ip": freshIp() });
    // A paid personal workspace with a Stripe subscription.
    const sub = stripe.addSubscription({ customer: "cus_del", lookupKey: "rolling_plus_month", start: Date.now(), end: Date.now() + 20 * 86_400_000, workspaceId: a.ws });
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, seats) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, 0, 1)",
    )
      .bind(sub.id, a.ws, Date.now() + 20 * 86_400_000)
      .run();
    const { projectId, assetId } = await projectWithOutput(a.cookie);
    const { shareId } = (await (await send(a.cookie, "POST", `/api/projects/${projectId}/share`, {})).json()) as any;
    await env.DB.prepare("INSERT INTO ledger_lines (id, workspace_id, user_id, kind, bucket, amount, created_at) VALUES (?, 'ws_elsewhere', ?, 'settle', 'plan', -5, 0)").bind(`led_del_${a.userId}`, a.userId).run();
    await send(a.cookie, "POST", "/api/feedback", { message: "bye" });

    const code = await deleteCode(a);
    const wrong = await send(a.cookie, "POST", "/api/me/delete", { code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: "INVALID_CODE" } });
    expect((await send(a.cookie, "POST", "/api/me/delete", { code: "12" })).status).toBe(400);

    const res = await send(a.cookie, "POST", "/api/me/delete", { code });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.getSetCookie().some((c) => /session_token=;/.test(c) || /Max-Age=0/i.test(c))).toBe(true);

    // Stripe: cancel at period end, idempotent per subscription.
    const cancel = stripe.calls.find((c) => c.path === `/v1/subscriptions/${sub.id}` && c.method === "POST");
    expect(cancel).toMatchObject({ form: { cancel_at_period_end: "true" }, idempotencyKey: `account-delete:${sub.id}` });
    // Every session is gone.
    expect((await getMe(a.cookie)).res.status).toBe(401);
    expect((await getMe(second.cookie)).res.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").bind(a.userId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(a.userId).first()).toEqual({ n: 0 });
    // Workspace soft-deleted with its content; share link gone; ledger and feedback anonymised.
    expect(await env.DB.prepare("SELECT deleted_at IS NOT NULL AS d FROM workspaces WHERE id = ?").bind(a.ws).first()).toEqual({ d: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?").bind(a.ws).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE id = ?").bind(assetId).first()).toEqual({ n: 0 });
    expect((await SELF.fetch(`${BASE}/api/share/${shareId}`)).status).toBe(404);
    // Ledger lines are kept (financial records) under the user's tombstone (@rolling/core/privacy).
    expect(await env.DB.prepare("SELECT user_id FROM ledger_lines WHERE id = ?").bind(`led_del_${a.userId}`).first()).toEqual({ user_id: await tombstoneUserId(a.userId) });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?").bind(a.userId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?").bind(a.userId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT cancel_at_period_end FROM subscriptions WHERE id = ?").bind(sub.id).first()).toEqual({ cancel_at_period_end: 1 });

    // Private media is queued and swept by the cron.
    expect(await env.DB.prepare("SELECT done_at FROM r2_cleanup WHERE prefix = ?").bind(`ws/${a.ws}/`).first()).toEqual({ done_at: null });
    expect((await env.MEDIA.list({ prefix: `ws/${a.ws}/` })).objects.length).toBeGreaterThan(0);
    await runR2Cleanup(env);
    expect((await env.MEDIA.list({ prefix: `ws/${a.ws}/` })).objects.length).toBe(0);
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d FROM r2_cleanup WHERE prefix = ?").bind(`ws/${a.ws}/`).first()).toEqual({ d: 1 });

    // Signing up again with the same email starts a fresh account.
    await env.DB.exec("DELETE FROM auth_email_sends");
    const fresh = await signIn(a.email, { "cf-connecting-ip": freshIp() });
    expect((await getMe(fresh.cookie)).body.user.id).not.toBe(a.userId);
  });

  it("locks the code after too many wrong tries", async () => {
    const a = await user("dlock");
    const code = await deleteCode(a);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await send(a.cookie, "POST", "/api/me/delete", { code: wrong })).status).toBe(400);
    const locked = await send(a.cookie, "POST", "/api/me/delete", { code });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ error: { code: "TOO_MANY_ATTEMPTS" } });
    expect((await getMe(a.cookie)).res.status).toBe(200);
  });
});
