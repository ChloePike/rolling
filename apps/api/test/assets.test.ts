import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signMediaKey } from "@rolling/core/media";
import { processAsset } from "../src/queues/mediaProcess";
import { projectRoom } from "../src/lib/access";
import { mediaSigningKey } from "../src/lib/mediaUrls";
import { cleanupExpiredUploads, s3Fetch } from "../src/routes/uploads";
import { parseListParts, presignUploadPart } from "../src/lib/r2s3";
import { app } from "../src/index";

const BASE = "https://example.com";
const MiB = 1024 * 1024;

let seq = 0;
function user(tag: string): string {
  seq++;
  return `${tag}${Date.now().toString(36)}${seq}`;
}
const wsOf = (u: string) => `ws_dev_${u}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(path.startsWith("http") ? path : `${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function ensureWorkspace(u: string): Promise<void> {
  expect((await api(u, "/api/projects")).status).toBe(200);
}

/** Makes `u`'s personal workspace a paying member with mature content on (D-005). */
async function makeMatureMember(u: string): Promise<void> {
  await ensureWorkspace(u);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)").bind(
      `sub_${u}`,
      wsOf(u),
      Date.now() + 86_400_000,
      Date.now(),
    ),
    env.DB.prepare("UPDATE user_prefs SET mature_content = 1 WHERE user_id = ?").bind(u),
  ]);
}

async function upload(u: string, bytes: Uint8Array, contentType: string, filename: string, extra: Record<string, unknown> = {}) {
  const start = await api(u, "/api/assets/uploads", { method: "POST", json: { filename, contentType, size: bytes.byteLength, ...extra } });
  expect(start.status, await start.clone().text()).toBe(201);
  const { assetId, partSize, partCount } = (await start.json()) as { assetId: string; partSize: number; partCount: number };
  await putParts(u, assetId, bytes, partSize, Array.from({ length: partCount }, (_, i) => i + 1));
  const done = await api(u, `/api/assets/uploads/${assetId}/complete`, { method: "POST" });
  expect(done.status, await done.clone().text()).toBe(200);
  return { assetId, asset: ((await done.json()) as { asset: any }).asset };
}

/** Requests part URLs and PUTs the parts (development fallback: the Worker proxy). */
async function putParts(u: string, assetId: string, bytes: Uint8Array, partSize: number, numbers: number[]) {
  const urls = await api(u, `/api/assets/uploads/${assetId}/part-urls`, { method: "POST", json: { partNumbers: numbers } });
  expect(urls.status, await urls.clone().text()).toBe(200);
  const body = (await urls.json()) as { direct: boolean; urls: { n: number; url: string; size: number }[] };
  expect(body.direct).toBe(false);
  for (const { n, url, size } of body.urls) {
    const chunk = bytes.slice((n - 1) * partSize, n * partSize);
    expect(chunk.byteLength).toBe(size);
    const res = await api(u, url, { method: "PUT", body: chunk, headers: { "content-length": String(chunk.byteLength) } });
    expect(res.status, await res.clone().text()).toBe(200);
  }
}

function pngBytes(size = 2048): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) b[i] = i % 251;
  return b;
}

describe("multipart uploads", () => {
  it("uploads in parts, queues processing and serves the bytes through a signed URL", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const bytes = new Uint8Array(10 * MiB + 1234);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 256;
    const { assetId, asset } = await upload(alice, bytes, "video/mp4", "My clip.mp4");
    expect(asset).toMatchObject({ id: assetId, kind: "video", status: "processing", size: bytes.byteLength, source: "mine" });

    const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId).first<any>();
    expect(row.r2_key).toBe(`ws/${wsOf(alice)}/uploads/${assetId}/My-clip.mp4`);
    // No container in tests: the asset is usable and marked pending.
    expect(await processAsset(env, { assetId, r2Key: row.r2_key, kind: "video" })).toBe("pending");
    const list = (await (await api(alice, "/api/assets?scope=mine&kind=video")).json()) as any;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: assetId, status: "ready", meta: { processing: "pending" } });

    const url: string = list.items[0].url;
    expect(url).toMatch(/^\/media\/ws\/.+\?exp=\d+&ws=.+&sig=/);
    const got = await SELF.fetch(`${BASE}${url}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("video/mp4");
    const digest = async (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))).join(",");
    const body = await got.arrayBuffer();
    expect(body.byteLength).toBe(bytes.byteLength);
    expect(await digest(body)).toBe(await digest(bytes));
    const ranged = await SELF.fetch(`${BASE}${url}`, { headers: { range: "bytes=0-9" } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);

    // Search through the FTS rows; the `@` picker via GraphQL.
    const found = (await (await api(alice, "/api/assets?q=clip")).json()) as any;
    expect(found.items.map((a: any) => a.id)).toContain(assetId);
    const gql = (await (await api(alice, "/api/graphql", { method: "POST", json: { query: '{ assets(scope: MINE, q: "clip") { edges { node { id kind status url } } } }' } })).json()) as any;
    expect(gql.data.assets.edges[0].node).toMatchObject({ id: assetId, kind: "VIDEO", status: "ready" });

    // Redirect for signed-in clients; delete removes the object.
    const redirect = await api(alice, `/api/media/private/${assetId}`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toMatch(/^\/media\//);
    expect((await api(alice, `/api/assets/${assetId}`, { method: "DELETE" })).status).toBe(200);
    expect(await env.MEDIA.head(row.r2_key)).toBeNull();
    expect((await SELF.fetch(`${BASE}${url}`)).status).toBe(404);
  });

  it("processes images into a ready asset", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const { assetId } = await upload(alice, pngBytes(), "image/png", "product.png");
    const row = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string }>();
    expect(await processAsset(env, { assetId, r2Key: row!.r2_key, kind: "image" })).toBe("done");
    const asset = ((await (await api(alice, `/api/assets/${assetId}`)).json()) as any).asset;
    expect(asset).toMatchObject({ status: "ready", kind: "image" });
    expect(asset.thumbUrl).toMatch(/^\/media\//);
  });

  it("keeps the browser-reported length of audio/video until probing replaces it", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const { assetId, asset } = await upload(alice, new Uint8Array(4096).fill(7), "audio/mpeg", "voice.mp3", { durationMs: 6400 });
    expect(asset).toMatchObject({ status: "processing", meta: { durationSec: 6.4 } });
    const row = await env.DB.prepare("SELECT r2_key, meta FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string; meta: string }>();
    expect(JSON.parse(row!.meta)).toMatchObject({ durationSec: 6.4, durationSource: "declared", declaredDurationSec: 6.4 });
    // No container: still the declared length.
    expect(await processAsset(env, { assetId, r2Key: row!.r2_key, kind: "audio" })).toBe("pending");
    const after = await env.DB.prepare("SELECT meta FROM assets WHERE id = ?").bind(assetId).first<{ meta: string }>();
    expect(JSON.parse(after!.meta)).toMatchObject({ durationSec: 6.4, durationSource: "declared", processing: "pending" });
    // Images ignore it; nonsense is refused.
    const img = await upload(alice, pngBytes(), "image/png", "a.png", { durationMs: 5000 });
    expect(img.asset.meta.durationSec).toBeUndefined();
    expect((await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.mp3", contentType: "audio/mpeg", size: 10, durationMs: -1 } })).status).toBe(400);
  });

  it("enforces type and size limits and part sizes", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const big = await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.png", contentType: "image/png", size: 30 * MiB + 1 } });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: "VALIDATION_FAILED", data: { reason: "TOO_LARGE", maxBytes: 30 * MiB } } });
    expect((await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.mp4", contentType: "video/mp4", size: 2048 * MiB + 1 } })).status).toBe(413);
    expect((await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.mp3", contentType: "audio/mpeg", size: 201 * MiB } })).status).toBe(413);
    const pdf = await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.pdf", contentType: "application/pdf", size: 10 } });
    expect(pdf.status).toBe(415);
    expect(await pdf.json()).toMatchObject({ error: { data: { reason: "UNSUPPORTED_TYPE" } } });

    const start = (await (await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.png", contentType: "image/png", size: 100 } })).json()) as any;
    expect(start).toMatchObject({ partSize: 8 * MiB, partCount: 1, parts: [], status: "uploading", expiresAt: expect.any(Number) });
    const wrong = await api(alice, `/api/assets/uploads/${start.assetId}/parts/1`, { method: "PUT", body: new Uint8Array(50), headers: { "content-length": "50" } });
    expect(wrong.status).toBe(400);
    expect((await api(alice, `/api/assets/uploads/${start.assetId}/parts/2`, { method: "PUT", body: new Uint8Array(100), headers: { "content-length": "100" } })).status).toBe(400);
    expect((await api(alice, `/api/assets/uploads/${start.assetId}/part-urls`, { method: "POST", json: { partNumbers: [2] } })).status).toBe(400);
    // Someone else cannot see, sign or add parts.
    const bob = user("bob");
    expect((await api(bob, `/api/assets/uploads/${start.assetId}`)).status).toBe(404);
    expect((await api(bob, `/api/assets/uploads/${start.assetId}/part-urls`, { method: "POST", json: { partNumbers: [1] } })).status).toBe(404);
    expect((await api(bob, `/api/assets/uploads/${start.assetId}/parts/1`, { method: "PUT", body: new Uint8Array(100), headers: { "content-length": "100" } })).status).toBe(404);
    expect((await api(bob, `/api/assets/uploads/${start.assetId}/complete`, { method: "POST" })).status).toBe(404);
    // Completing with parts missing is refused with the list.
    const early = await api(alice, `/api/assets/uploads/${start.assetId}/complete`, { method: "POST" });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: { data: { reason: "MISSING_PARTS", missing: [1] } } });
    // Uploading assets are not listed.
    const list = (await (await api(alice, "/api/assets?scope=mine")).json()) as any;
    expect(list.items.map((a: any) => a.id)).not.toContain(start.assetId);
  });
});

describe("signed media URLs", () => {
  it("accepts valid signatures and refuses expired or tampered ones", async () => {
    const alice = user("alice");
    const key = `ws/${wsOf(alice)}/uploads/ast_X/f.txt`;
    await env.MEDIA.put(key, "hello", { httpMetadata: { contentType: "text/plain" } });
    const secret = mediaSigningKey(env);
    const ok = await signMediaKey(key, { workspaceId: wsOf(alice), expiresIn: 60, secret });
    const res = await SELF.fetch(`${BASE}${ok}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");

    const expired = await signMediaKey(key, { workspaceId: wsOf(alice), expiresIn: 60, secret, now: Date.now() - 3_600_000 });
    const gone = await SELF.fetch(`${BASE}${expired}`);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { data: { reason: "expired" } } });

    const tampered = ok.replace("f.txt", "g.txt");
    expect((await SELF.fetch(`${BASE}${tampered}`)).status).toBe(403);
    const otherWs = ok.replace(`ws=${encodeURIComponent(wsOf(alice))}`, "ws=ws_dev_mallory");
    expect((await SELF.fetch(`${BASE}${otherWs}`)).status).toBe(403);
    const badSig = ok.replace(/sig=[^&]+/, "sig=AAAA");
    expect((await SELF.fetch(`${BASE}${badSig}`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/media/${key}`)).status).toBe(403);
  });

  it("signs mature media only for users allowed to see it (D-005)", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const { assetId } = await upload(alice, pngBytes(), "image/png", "x.png");
    await env.DB.prepare("UPDATE assets SET mature = 1, status = 'ready' WHERE id = ?").bind(assetId).run();
    expect(((await (await api(alice, "/api/assets?scope=mine")).json()) as any).items.map((a: any) => a.id)).not.toContain(assetId);
    expect((await api(alice, `/api/media/private/${assetId}`, { redirect: "manual" })).status).toBe(404);

    await makeMatureMember(alice);
    const items = ((await (await api(alice, "/api/assets?scope=mine")).json()) as any).items;
    expect(items.find((a: any) => a.id === assetId)).toMatchObject({ mature: true, url: expect.stringMatching(/^\/media\//) });
  });
});

describe("workspace isolation", () => {
  it("never lists or serves another workspace's assets", async () => {
    const alice = user("alice");
    const bob = user("bob");
    await ensureWorkspace(alice);
    const { assetId } = await upload(alice, pngBytes(), "image/png", "secret-product.png");
    for (const scope of ["mine", "team", "all"]) {
      const list = (await (await api(bob, `/api/assets?scope=${scope}&q=secret`)).json()) as any;
      expect(list.items.map((a: any) => a.id)).not.toContain(assetId);
    }
    expect((await api(bob, `/api/assets/${assetId}`)).status).toBe(404);
    expect((await api(bob, `/api/assets/${assetId}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(bob, `/api/media/private/${assetId}`, { redirect: "manual" })).status).toBe(404);
    expect((await api(bob, "/api/characters", { method: "POST", json: { name: "Thief", coverAssetId: assetId } })).status).toBe(404);
  });
});

describe("characters and voices", () => {
  it("creates and lists characters; voice cloning needs a plan with cloning", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const { assetId } = await upload(alice, pngBytes(), "image/png", "lead.png");
    const created = await api(alice, "/api/characters", { method: "POST", json: { name: "Lead", coverAssetId: assetId, meta: { age: "30s" } } });
    expect(created.status).toBe(201);
    const list = (await (await api(alice, "/api/characters")).json()) as any;
    expect(list.items).toMatchObject([{ name: "Lead", coverAssetId: assetId, meta: { age: "30s" }, versions: [{ n: 1, assetIds: [assetId] }] }]);
    expect((await api(alice, `/api/characters/${list.items[0].id}`, { method: "DELETE" })).status).toBe(200);

    const sample = await upload(alice, new Uint8Array(4096), "audio/mpeg", "sample.mp3");
    const noPlan = await api(alice, "/api/voices", { method: "POST", json: { name: "My voice", sampleAssetId: sample.assetId } });
    expect(noPlan.status).toBe(402);
    expect(await noPlan.json()).toMatchObject({ error: { code: "NO_PLAN" } });
    await makeMatureMember(alice);
    const voice = await api(alice, "/api/voices/clone", { method: "POST", json: { name: "My voice", sampleAssetId: sample.assetId } });
    expect(voice.status).toBe(202);
    expect(await voice.json()).toMatchObject({ voice: { kind: "cloned", status: "pending" } });
    expect(((await (await api(alice, "/api/voices")).json()) as any).items.map((v: any) => v.name)).toContain("My voice");
  });
});

describe("share links", () => {
  it("publishes a snapshot without mature outputs, readable signed out, revocable", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const created = await api(alice, "/api/projects", { method: "POST", json: { title: "Ad" } });
    const projectId = ((await created.json()) as any).project.id as string;
    const patch = await api(alice, `/api/projects/${projectId}/patch`, {
      method: "POST",
      json: {
        baseRevision: 0,
        ops: [
          { op: "addNode", tempId: "safe", kind: "image", title: "Safe", params: { prompt: "a bottle" } },
          { op: "addNode", tempId: "spicy", kind: "image", title: "Mature", params: { prompt: "x" } },
          { op: "addNode", tempId: "vid", kind: "video", title: "Shot", params: { prompt: "y" } },
          { op: "connect", from: { node: "spicy", port: "out" }, to: { node: "vid", port: "frame" } },
        ],
      },
    });
    const { idMap } = (await patch.json()) as any;
    const safe = await upload(alice, pngBytes(), "image/png", "safe.png");
    const spicy = await upload(alice, pngBytes(), "image/png", "spicy.png");
    await env.DB.prepare("UPDATE assets SET source = 'generated', mature = 1 WHERE id = ?").bind(spicy.assetId).run();
    const room = projectRoom(env, projectId);
    await room.addVersion({ nodeId: idMap.safe, assetId: safe.assetId, inputDigest: "dg_x" });
    await room.addVersion({ nodeId: idMap.spicy, assetId: spicy.assetId, inputDigest: "dg_y" });

    const res = await api(alice, `/api/projects/${projectId}/share`, { method: "POST", json: { allowDownload: false } });
    expect(res.status).toBe(201);
    const info = (await res.json()) as any;
    expect(info.shareId).toMatch(/^shr_/);

    const pub = await api(null, `/api/share/${info.shareId}`);
    expect(pub.status).toBe(200);
    const doc = (await pub.json()) as any;
    expect(doc.nodes.map((n: any) => n.title).sort()).toEqual(["Safe", "Shot"]);
    expect(doc.edges).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain(spicy.assetId);
    const safeNode = doc.nodes.find((n: any) => n.title === "Safe");
    expect(safeNode.media).toMatchObject({ kind: "image", url: expect.stringMatching(/^\/media\//), downloadUrl: null });
    expect((await SELF.fetch(`${BASE}${safeNode.media.url}`)).status).toBe(200);

    // Re-sharing keeps the link and updates the download toggle.
    const again = (await (await api(alice, `/api/projects/${projectId}/share`, { method: "POST", json: { allowDownload: true } })).json()) as any;
    expect(again.shareId).toBe(info.shareId);
    expect(((await (await api(null, `/api/share/${info.shareId}`)).json()) as any).allowDownload).toBe(true);

    expect((await api(alice, `/api/projects/${projectId}/share`, { method: "DELETE" })).status).toBe(200);
    expect((await api(null, `/api/share/${info.shareId}`)).status).toBe(404);
  });
});

describe("share links and version ratings (D-005)", () => {
  it("drops nodes whose active version is rated suggestive or explicit, even if the asset row is not mature yet", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const created = await api(alice, "/api/projects", { method: "POST", json: { title: "Rated" } });
    const projectId = ((await created.json()) as any).project.id as string;
    const patch = await api(alice, `/api/projects/${projectId}/patch`, {
      method: "POST",
      json: {
        baseRevision: 0,
        ops: [
          { op: "addNode", tempId: "ok", kind: "image", title: "Fine", params: { prompt: "a bottle" } },
          { op: "addNode", tempId: "hot", kind: "image", title: "Rated", params: { prompt: "x" } },
        ],
      },
    });
    const { idMap } = (await patch.json()) as any;
    const ok = await upload(alice, pngBytes(), "image/png", "ok.png");
    const hot = await upload(alice, pngBytes(), "image/png", "hot.png");
    const room = projectRoom(env, projectId);
    await room.addVersion({ nodeId: idMap.ok, assetId: ok.assetId, inputDigest: "dg_a", rating: "safe" });
    const v = await room.addVersion({ nodeId: idMap.hot, assetId: hot.assetId, inputDigest: "dg_b", output: { rating: "suggestive" } });
    expect(v).toMatchObject({ ok: true, version: { rating: "suggestive" } });
    const graph = (await room.getGraph({ userId: alice, workspaceId: `ws_dev_${alice}`, canEdit: true })) as any;
    expect(graph.ratings).toEqual({ [idMap.ok]: "safe", [idMap.hot]: "suggestive" });

    const info = (await (await api(alice, `/api/projects/${projectId}/share`, { method: "POST", json: {} })).json()) as any;
    const doc = (await (await api(null, `/api/share/${info.shareId}`)).json()) as any;
    expect(doc.nodes.map((n: any) => n.title)).toEqual(["Fine"]);
    expect(JSON.stringify(doc)).not.toContain(hot.assetId);

    // The project thumbnail never comes from a mature-rated version.
    await room.flushIndex();
    const row = await env.DB.prepare("SELECT thumb_key FROM projects WHERE id = ?").bind(projectId).first<{ thumb_key: string | null }>();
    const keyOf = async (id: string) => {
      const a = await env.DB.prepare("SELECT r2_key, meta FROM assets WHERE id = ?").bind(id).first<{ r2_key: string; meta: string }>();
      return (JSON.parse(a!.meta).thumbKey as string | undefined) ?? a!.r2_key;
    };
    expect(row?.thumb_key).toBe(await keyOf(ok.assetId));
    expect(row?.thumb_key).not.toBe(await keyOf(hot.assetId));
  });
});

describe("resumable uploads (D-011)", () => {
  it("resumes by fingerprint after partial parts, re-sends parts idempotently, completes once", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const bytes = new Uint8Array(8 * MiB + 777);
    for (let i = 0; i < bytes.length; i += 1024) bytes[i] = (i / 1024) % 256;
    const req = { filename: "clip.mp4", contentType: "video/mp4", size: bytes.byteLength, fingerprint: "fp_abc123456" };
    const first = (await (await api(alice, "/api/assets/uploads", { method: "POST", json: req })).json()) as any;
    expect(first).toMatchObject({ partCount: 2, resumed: false });
    await putParts(alice, first.assetId, bytes, first.partSize, [1]);
    await putParts(alice, first.assetId, bytes, first.partSize, [1]); // re-send replaces

    const again = await api(alice, "/api/assets/uploads", { method: "POST", json: req });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ assetId: first.assetId, resumed: true, parts: [{ n: 1, size: 8 * MiB }] });
    expect(await (await api(alice, `/api/assets/uploads/${first.assetId}`)).json()).toMatchObject({ status: "uploading", size: bytes.byteLength, parts: [{ n: 1 }] });
    // Another user with the same fingerprint gets a fresh upload.
    const bob = user("bob");
    await ensureWorkspace(bob);
    const other = (await (await api(bob, "/api/assets/uploads", { method: "POST", json: req })).json()) as any;
    expect(other.assetId).not.toBe(first.assetId);

    await putParts(alice, first.assetId, bytes, first.partSize, [2]);
    const done = await api(alice, `/api/assets/uploads/${first.assetId}/complete`, { method: "POST" });
    expect(done.status).toBe(200);
    const twice = await api(alice, `/api/assets/uploads/${first.assetId}/complete`, { method: "POST" });
    expect(twice.status).toBe(200);
    expect(await (await api(alice, `/api/assets/uploads/${first.assetId}`)).json()).toMatchObject({ status: "complete" });
    const head = await env.MEDIA.head(`ws/${wsOf(alice)}/uploads/${first.assetId}/clip.mp4`);
    expect(head?.size).toBe(bytes.byteLength);
    // A new upload of the same file after completion starts fresh.
    expect(((await (await api(alice, "/api/assets/uploads", { method: "POST", json: req })).json()) as any).resumed).toBe(false);
  });

  it("aborts, and expires uploads after 7 days", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const a = (await (await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "a.png", contentType: "image/png", size: 100 } })).json()) as any;
    expect(await (await api(alice, `/api/assets/uploads/${a.assetId}`, { method: "DELETE" })).json()).toMatchObject({ ok: true, status: "aborted" });
    expect(await (await api(alice, `/api/assets/uploads/${a.assetId}`)).json()).toMatchObject({ status: "aborted" });
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(a.assetId).first()).toBeNull();

    const b = (await (await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "b.png", contentType: "image/png", size: 100, fingerprint: "fp_expiring1" } })).json()) as any;
    await env.DB.prepare("UPDATE uploads SET expires_at = ? WHERE asset_id = ?").bind(Date.now() - 1, b.assetId).run();
    expect(await (await api(alice, `/api/assets/uploads/${b.assetId}`)).json()).toMatchObject({ status: "expired" });
    expect((await api(alice, `/api/assets/uploads/${b.assetId}/part-urls`, { method: "POST", json: { partNumbers: [1] } })).status).toBe(409);

    const c = (await (await api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "c.png", contentType: "image/png", size: 100 } })).json()) as any;
    await env.DB.prepare("UPDATE uploads SET expires_at = ? WHERE asset_id = ?").bind(Date.now() - 1, c.assetId).run();
    expect(await cleanupExpiredUploads(env)).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT status FROM uploads WHERE asset_id = ?").bind(c.assetId).first()).toEqual({ status: "expired" });
  });

  it("serves resumable downloads: 206, If-Range, 416", async () => {
    const alice = user("alice");
    const key = `ws/${wsOf(alice)}/uploads/ast_R/r.bin`;
    await env.MEDIA.put(key, new Uint8Array(1000).map((_, i) => i % 256), { httpMetadata: { contentType: "application/octet-stream" } });
    const url = await signMediaKey(key, { workspaceId: wsOf(alice), expiresIn: 60, secret: mediaSigningKey(env) });
    const full = await SELF.fetch(`${BASE}${url}`);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const etag = full.headers.get("etag")!;
    await full.arrayBuffer();
    const part = await SELF.fetch(`${BASE}${url}`, { headers: { range: "bytes=100-199", "if-range": etag } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(new Uint8Array(await part.arrayBuffer())[0]).toBe(100);
    const tail = await SELF.fetch(`${BASE}${url}`, { headers: { range: "bytes=-10" } });
    expect(tail.headers.get("content-range")).toBe("bytes 990-999/1000");
    await tail.arrayBuffer();
    const stale = await SELF.fetch(`${BASE}${url}`, { headers: { range: "bytes=100-199", "if-range": '"other"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
    const bad = await SELF.fetch(`${BASE}${url}`, { headers: { range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
  });
});

describe("direct-to-R2 uploads over the S3 API", () => {
  const s3env = () => ({ ...env, R2_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", R2_ACCOUNT_ID: "acc123", R2_BUCKET_NAME: "rolling-media-test" }) as Env;

  async function s3api(u: string, path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-dev-user", u);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), s3env(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("presigns UploadPart URLs with a valid SigV4 query signature", async () => {
    const cfg = { accountId: "acc123", bucket: "rolling-media-test", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
    const signed = new URL(await presignUploadPart(cfg, "ws/ws_A/uploads/ast_1/My clip.mp4", "up-1", 3, 3600, "20261125T120000Z"));
    expect(`${signed.origin}${signed.pathname}`).toBe("https://acc123.r2.cloudflarestorage.com/rolling-media-test/ws/ws_A/uploads/ast_1/My%20clip.mp4");
    const q = signed.searchParams;
    expect(q.get("partNumber")).toBe("3");
    expect(q.get("uploadId")).toBe("up-1");
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20261125/auto/s3/aws4_request");
    expect(q.get("X-Amz-Date")).toBe("20261125T120000Z");
    expect(q.get("X-Amz-Expires")).toBe("3600");
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    // Independent SigV4 check (canonical request → string to sign → HMAC chain).
    const enc = new TextEncoder();
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const hmac = async (key: ArrayBuffer | Uint8Array, msg: string) =>
      crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(msg));
    const sigless = [...q.entries()].filter(([k]) => k !== "X-Amz-Signature").map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]);
    sigless.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1));
    const canonical = ["PUT", signed.pathname, sigless.map(([k, v]) => `${k}=${v}`).join("&"), `host:${signed.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
    const sts = ["AWS4-HMAC-SHA256", "20261125T120000Z", "20261125/auto/s3/aws4_request", hex(await crypto.subtle.digest("SHA-256", enc.encode(canonical)))].join("\n");
    let k = await hmac(enc.encode(`AWS4${cfg.secretAccessKey}`), "20261125");
    k = await hmac(k, "auto");
    k = await hmac(k, "s3");
    k = await hmac(k, "aws4_request");
    expect(q.get("X-Amz-Signature")).toBe(hex(await hmac(k, sts)));
  });

  it("parses ListParts XML, including pages", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>b</Bucket><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>
      <Part><PartNumber>1</PartNumber><LastModified>2026-11-25T00:00:00Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>8388608</Size></Part>
      <Part><PartNumber>2</PartNumber><ETag>"def"</ETag><Size>12</Size></Part></ListPartsResult>`;
    expect(parseListParts(xml)).toEqual({ parts: [{ n: 1, size: 8388608, etag: "abc" }, { n: 2, size: 12, etag: "def" }], truncated: true, next: 2 });
  });

  it("hands out direct URLs, lists parts with ListParts, validates and completes", async () => {
    const alice = user("alice");
    await ensureWorkspace(alice);
    const bytes = new Uint8Array(8 * MiB + 10).fill(7);
    const start = await s3api(alice, "/api/assets/uploads", { method: "POST", json: { filename: "v.mp4", contentType: "video/mp4", size: bytes.byteLength } });
    expect(start.status).toBe(201);
    const up = (await start.json()) as any;
    const urls = (await (await s3api(alice, `/api/assets/uploads/${up.assetId}/part-urls`, { method: "POST", json: { partNumbers: [1, 2] } })).json()) as any;
    expect(urls.direct).toBe(true);
    expect(urls.urls[0].url).toMatch(/^https:\/\/acc123\.r2\.cloudflarestorage\.com\/rolling-media-test\/ws\/.+\?partNumber=1&uploadId=.+X-Amz-Signature=/);
    // The Worker proxy is off when S3 credentials exist.
    expect((await s3api(alice, `/api/assets/uploads/${up.assetId}/parts/1`, { method: "PUT", body: new Uint8Array(1), headers: { "content-length": "1" } })).status).toBe(404);

    // Simulate the browser's direct PUTs with the binding; R2 answers ListParts via the mock.
    const mp = env.MEDIA.resumeMultipartUpload(up.key, up.uploadId);
    const p1 = await mp.uploadPart(1, bytes.slice(0, 8 * MiB));
    let listed = [{ n: 1, size: 8 * MiB, etag: p1.etag }];
    const calls: string[] = [];
    s3Fetch.fn = async (input) => {
      const req = input as Request;
      calls.push(req.url);
      expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
      const parts = listed.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>"${p.etag}"</ETag><Size>${p.size}</Size></Part>`).join("");
      return new Response(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`, { status: 200 });
    };
    try {
      expect(await (await s3api(alice, `/api/assets/uploads/${up.assetId}`)).json()).toMatchObject({ parts: [{ n: 1, size: 8 * MiB }] });
      expect(calls[0]).toContain(`uploadId=${encodeURIComponent(up.uploadId)}`);
      const missing = await s3api(alice, `/api/assets/uploads/${up.assetId}/complete`, { method: "POST" });
      expect(await missing.json()).toMatchObject({ error: { data: { reason: "MISSING_PARTS", missing: [2] } } });

      const p2 = await mp.uploadPart(2, bytes.slice(8 * MiB));
      listed = [...listed, { n: 2, size: 9, etag: p2.etag }];
      const wrongSize = await s3api(alice, `/api/assets/uploads/${up.assetId}/complete`, { method: "POST" });
      expect(await wrongSize.json()).toMatchObject({ error: { data: { reason: "PART_SIZE", n: 2, expected: 10, got: 9 } } });

      listed[1] = { n: 2, size: 10, etag: p2.etag };
      const done = await s3api(alice, `/api/assets/uploads/${up.assetId}/complete`, { method: "POST" });
      expect(done.status, await done.clone().text()).toBe(200);
      expect(await done.json()).toMatchObject({ asset: { id: up.assetId, status: "processing" } });
      expect((await env.MEDIA.head(up.key))?.size).toBe(bytes.byteLength);
    } finally {
      s3Fetch.fn = (i, init) => fetch(i, init);
    }
  });
});
