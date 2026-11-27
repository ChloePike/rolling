/**
 * Consistent characters (D-032) end to end in the workers pool with a fake
 * gateway: a sheet run saves a character with a locked descriptor; a canvas
 * shot passes the sheet view as a reference image; the consistency step
 * stores a drift score; versions and outfits come from sheet runs only.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";
import { syncModels } from "../src/models/sync";
import { setGatewayFetchForTests } from "../src/runs/provider";
import { realFaceAssets } from "../src/characters/store";

const BASE = "https://example.com";
const DAY = 86_400_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const HEAD = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;

interface FakeJob {
  id: string;
  kind: "image" | "video";
  body: Record<string, unknown>;
}

const fake = {
  jobs: [] as FakeJob[],
  byKey: new Map<string, FakeJob>(),
  chats: [] as Record<string, unknown>[],
  faces: 1,
  similarity: 0.42,
  reset() {
    this.jobs = [];
    this.byKey.clear();
    this.chats = [];
    this.faces = 1;
    this.similarity = 0.42;
  },
};
let seq = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function chatAnswer(text: string): Response {
  const chunk = { id: "c1", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const key = req.headers.get("idempotency-key");
  if (url.hostname === "cdn.fake") return new Response(url.pathname.endsWith(".mp4") ? MP4 : PNG, { headers: { "content-type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/png" } });
  if (url.pathname === "/v1/chat/completions") {
    const body = (await req.json()) as Record<string, unknown>;
    fake.chats.push(body);
    if (body.model === "lumina/face-detect") {
      return chatAnswer(JSON.stringify({ faces: Array.from({ length: fake.faces }, (_, i) => ({ confidence: 98 - i, box: { x: 0, y: 0, width: 1, height: 1 }, head_url: HEAD })) }));
    }
    const system = JSON.stringify(body.messages).includes("identity consistency");
    if (system) return chatAnswer(JSON.stringify({ matches: [{ image: 2, similarity: fake.similarity, sameIdentity: fake.similarity >= 0.75 }] }));
    return chatAnswer("{}");
  }
  if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits" || url.pathname === "/v1/videos")) {
    const body = (await req.json()) as Record<string, unknown>;
    const existing = key ? fake.byKey.get(key) : undefined;
    if (existing) return json({ id: existing.id, status: "queued" }, 202);
    const kind = url.pathname === "/v1/videos" ? "video" : "image";
    const job: FakeJob = { id: `${kind === "video" ? "vid" : "gen"}_c${++seq}`, kind, body };
    fake.jobs.push(job);
    if (key) fake.byKey.set(key, job);
    return kind === "video" ? json({ id: job.id, object: "video", status: "queued" }) : json({ id: job.id, status: "queued" }, 202);
  }
  const gen = /^\/v1\/generations\/([^/]+)$/.exec(url.pathname);
  if (gen) return json({ data: { id: gen[1], kind: "image", status: "done", usage: { cost: 0.01 }, outputs: [{ url: `https://cdn.fake/${gen[1]}.png` }] } });
  const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname);
  if (content) return new Response(null, { status: 302, headers: { location: `https://cdn.fake/${content[1]}${url.searchParams.get("variant") === "thumbnail" ? ".png" : ".mp4"}` } });
  const vid = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname);
  if (vid) return json({ id: vid[1], status: "completed", progress: 100, usage: { cost: 0.1 } });
  return json({ error: { message: `fake: no route ${req.method} ${url.pathname}`, code: "not_found" } }, 404);
}) as typeof fetch;

let userSeq = 0;
function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function member(tag: string): Promise<{ user: string; ws: string }> {
  const user = `${tag}${Date.now().toString(36)}${++userSeq}`;
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
    .bind(`sub_${user}`, ws, now + 30 * DAY, now)
    .run();
  const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
  expect((await stub.grant({ planId: "plus", interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${user}`)).ok).toBe(true);
  expect((await stub.purchase(5000, `pi_${user}`, `buy_${user}`)).ok).toBe(true);
  return { user, ws };
}

/** An uploaded photo; `faces` = what face detection stored at upload (absent = not run yet). */
async function photo(ws: string, user: string, faces?: number): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const key = `ws/${ws}/uploads/${id}.png`;
  await env.MEDIA.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  const meta = faces === undefined ? {} : { faces: { status: "done", count: faces, maxConfidence: faces ? 99 : 0, apparentMinor: false, model: "lumina/face-detect", source: "image", at: Date.now() } };
  await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'mine', 'photo', ?, ?, ?, ?, 'ready', 0)")
    .bind(id, ws, key, JSON.stringify(meta), user, Date.now())
    .run();
  return id;
}

async function quote(user: string, body: unknown): Promise<any> {
  const res = await api(user, "/api/runs/quote", { method: "POST", json: body });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runToEnd(user: string, q: any): Promise<any> {
  const res = await api(user, "/api/runs", { method: "POST", json: { quoteId: q.quoteId } });
  expect(res.status, await res.clone().text()).toBe(201);
  const { runId } = (await res.json()) as { runId: string };
  return waitFor(`run ${runId}`, async () => {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<any>();
    return r && ["succeeded", "partial", "failed", "canceled"].includes(r.status) ? r : null;
  });
}

const DESCRIPTOR = { face: "woman in her late twenties, oval face, small mole under the left eye", hair: "black side-part bob", build: "slim", outfit: "mustard trench coat", style: "photoreal" };

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await env.DB.exec("DELETE FROM models");
  await syncModels({ ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env, { fetch: (async () => json(listing)) as unknown as typeof fetch });
  setGatewayFetchForTests(fakeFetch);
});

afterAll(() => setGatewayFetchForTests(null));

beforeEach(async () => {
  fake.reset();
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

async function makeSheet(user: string, ws: string, refFaces?: number): Promise<{ characterId: string; character: any }> {
  const ref = await photo(ws, user, refFaces);
  const q = await quote(user, { promptSpec: { kind: "character", name: "Maya", model: "bytedance/seedream-5.0-lite", resolution: "2K", sheet: { descriptor: DESCRIPTOR, expressions: ["smile", "serious"] }, inputs: { referenceAssetIds: [ref] } } });
  expect(q.items.map((i: any) => [i.ref, i.action])).toEqual([
    ["full_body", "run"],
    ["front", "run"],
    ["three_quarter", "run"],
    ["profile", "run"],
    ["expression_smile", "run"],
    ["expression_serious", "run"],
  ]);
  expect(q.total).toBeGreaterThan(0);
  const run = await runToEnd(user, q);
  expect(run.status).toBe("succeeded");
  const characterId = await waitFor("character saved", async () => (await env.DB.prepare("SELECT character_id FROM runs WHERE id = ?").bind(run.id).first<{ character_id: string | null }>())?.character_id);
  const res = await api(user, `/api/characters/${characterId}`);
  expect(res.status).toBe(200);
  return { characterId, character: ((await res.json()) as any).character };
}

describe("character sheets (D-032)", { timeout: 90_000 }, () => {
  it("one run makes the turnaround; the character keeps a locked, versioned descriptor", async () => {
    const { user, ws } = await member("chs");
    const { characterId, character } = await makeSheet(user, ws, 0);
    expect(character.sheet.map((p: any) => p.view)).toEqual(["full_body", "front", "three_quarter", "profile", "expression_smile", "expression_serious"]);
    expect(character.sheet.every((p: any) => typeof p.url === "string")).toBe(true);
    expect(character.descriptor).toMatchObject({ kind: "person", hair: "black side-part bob" });
    expect(character.descriptorVersion).toBe(1);
    expect(character.versions).toHaveLength(1);
    expect(character.versions[0]).toMatchObject({ n: 1, current: true, drift: { checks: 0, verdict: null } });
    expect(character.realFace).toBe(false);
    expect(character.training.available).toBe(false);
    // Every view but the full body was drawn from the full body (an image edit).
    const edits = fake.jobs.filter((j) => j.kind === "image" && Array.isArray(j.body.images));
    expect(edits.length).toBe(6);
    // The pictures are indexed as the character's sheet.
    const indexed = await env.DB.prepare("SELECT view FROM character_sheet_assets WHERE character_id = ? ORDER BY view").bind(characterId).all<{ view: string }>();
    expect(indexed.results).toHaveLength(6);

    // Locked: the descriptor can't be edited in place, only the name.
    const locked = await api(user, `/api/characters/${characterId}`, { method: "PATCH", json: { descriptor: { face: "someone else" } } });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as any).error.data.reason).toBe("DESCRIPTOR_LOCKED");
    const renamed = await api(user, `/api/characters/${characterId}`, { method: "PATCH", json: { name: "Maya Chen" } });
    expect(((await renamed.json()) as any).character.name).toBe("Maya Chen");

    // An outfit variant keeps the locked descriptor (the client's is replaced) and starts from the saved full body.
    const oq = await quote(user, { promptSpec: { kind: "character", model: "bytedance/seedream-5.0-lite", resolution: "2K", sheet: { mode: "outfit", characterId, descriptor: { face: "ignored" }, outfit: { name: "Office", outfit: "navy suit, white shirt" } } } });
    expect(oq.items.map((i: any) => i.ref)).toEqual(["full_body", "three_quarter"]);
    expect((await runToEnd(user, oq)).status).toBe("succeeded");
    const withOutfit = await waitFor("outfit saved", async () => {
      const c = ((await (await api(user, `/api/characters/${characterId}`)).json()) as any).character;
      return c.outfits.length ? c : null;
    });
    expect(withOutfit.outfits[0]).toMatchObject({ name: "Office", outfit: "navy suit, white shirt" });
    expect(withOutfit.outfits[0].views.map((v: any) => v.view)).toEqual(["full_body", "three_quarter"]);
    expect(withOutfit.descriptor.face).toBe(DESCRIPTOR.face);
    const outfitPrompt = String(fake.jobs.filter((j) => j.kind === "image").at(-2)!.body.prompt);
    expect(outfitPrompt).toContain("navy suit");

    // A new version comes from a sheet run with the changed descriptor.
    const vq = await quote(user, { promptSpec: { kind: "character", model: "bytedance/seedream-5.0-lite", resolution: "2K", sheet: { mode: "version", characterId, descriptor: { ...DESCRIPTOR, hair: "long black hair" }, expressions: ["smile"] } } });
    expect((await runToEnd(user, vq)).status).toBe("succeeded");
    const v2 = await waitFor("version 2", async () => {
      const c = ((await (await api(user, `/api/characters/${characterId}`)).json()) as any).character;
      return c.versions.length === 2 ? c : null;
    });
    expect(v2.descriptorVersion).toBe(2);
    expect(v2.descriptor.hair).toBe("long black hair");
    expect(v2.versions.map((v: any) => [v.n, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("a canvas shot passes the sheet view as a reference image, and the consistency check stores a drift score", async () => {
    const { user, ws } = await member("chr");
    const { characterId, character } = await makeSheet(user, ws, 0);
    const front = character.sheet.find((p: any) => p.view === "front").assetId;
    const res = await api(user, "/api/projects", { method: "POST", json: { title: "Episode 1" } });
    const projectId = ((await res.json()) as any).project.id;
    const room = projectRoom(env, projectId);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const added = (await room.applyPatch(caller, {
      baseRevision: 0,
      ops: [
        { op: "addNode", tempId: "a", kind: "asset", title: "Character: Maya · front", params: { assetId: front, media: "image", source: "character", characterId }, position: { x: 0, y: 0 } },
        { op: "addNode", tempId: "v", kind: "video", title: "Shot 1", params: { model: "bytedance/seedance-2.0-mini", mode: "Reference to video", prompt: "Maya looks up from her phone and smiles", ratio: "9:16", resolution: "480p", seconds: 5 }, position: { x: 300, y: 0 } },
        { op: "connect", from: { node: "a", port: "out" }, to: { node: "v", port: "frame" } },
      ],
    })) as any;
    expect(added.ok, JSON.stringify(added)).toBe(true);
    fake.similarity = 0.42;
    const q = await quote(user, { projectId, scope: "all" });
    const video = q.items.find((i: any) => i.kind === "video");
    expect(video.action).toBe("run");
    const before = fake.jobs.length;
    expect((await runToEnd(user, q)).status).toBe("succeeded");
    const job = fake.jobs.slice(before).find((j) => j.kind === "video")!;
    expect(job.body.model).toBe("bytedance/seedance-2.0-mini");
    expect(Array.isArray(job.body.reference_images) && (job.body.reference_images as string[]).length).toBe(1);
    expect(job.body.first_frame ?? job.body.input_reference).toBeUndefined();

    const check = await waitFor("consistency check", async () => env.DB.prepare("SELECT * FROM character_checks WHERE character_id = ? AND project_id = ?").bind(characterId, projectId).first<any>());
    expect(check).toMatchObject({ score: 0.42, verdict: "drift", faces: 1, method: "face-detect+vision-v1", version: 1 });
    // Face detection was asked for head crops; the vision model compared the crops.
    expect(fake.chats.some((c) => c.model === "lumina/face-detect" && c.crop_heads === true)).toBe(true);
    const detail = ((await (await api(user, `/api/characters/${characterId}`)).json()) as any).character;
    expect(detail.versions[0].drift).toMatchObject({ checks: 1, min: 0.42, drifted: 1, verdict: "drift" });
    expect(detail.drift.verdict).toBe("drift");
    expect(detail.usedIn).toEqual([expect.objectContaining({ projectId, title: "Episode 1", uses: 1 })]);
    expect(detail.checks[0]).toMatchObject({ score: 0.42, verdict: "drift", projectId });
  });

  it("D-005: a sheet drawn from an uploaded photo with a face is a real-face character; its pictures count as uploads", async () => {
    const { user, ws } = await member("chf");
    const { characterId, character } = await makeSheet(user, ws, 1);
    expect(character.realFace).toBe(true);
    const ids = character.sheet.map((p: any) => p.assetId);
    expect((await realFaceAssets(env, ws, ids)).size).toBe(ids.length);
    // A photo whose face detection has not run is treated the same (fail safe).
    const second = await makeSheet(user, ws, undefined);
    expect(second.character.realFace).toBe(true);
    // A face-free reference keeps the sheet a platform asset.
    const third = await makeSheet(user, ws, 0);
    expect(third.character.realFace).toBe(false);
    expect((await realFaceAssets(env, ws, third.character.sheet.map((p: any) => p.assetId))).size).toBe(0);
    expect(characterId).not.toBe(third.characterId);
  });
});
