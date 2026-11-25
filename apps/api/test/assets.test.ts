import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signMediaKey } from "@rolling/core/media";
import { processAsset } from "../src/queues/mediaProcess";
import { projectRoom } from "../src/lib/access";
import { mediaSigningKey } from "../src/lib/mediaUrls";

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

async function upload(u: string, bytes: Uint8Array, contentType: string, filename: string) {
  const start = await api(u, "/api/assets/uploads", { method: "POST", json: { filename, contentType, size: bytes.byteLength } });
  expect(start.status, await start.clone().text()).toBe(201);
  const { assetId, partSize, parts } = (await start.json()) as { assetId: string; partSize: number; parts: number };
  const etags: { partNumber: number; etag: string }[] = [];
  for (let n = 1; n <= parts; n++) {
    const chunk = bytes.slice((n - 1) * partSize, n * partSize);
    const res = await api(u, `/api/assets/uploads/${assetId}/parts/${n}`, { method: "PUT", body: chunk, headers: { "content-length": String(chunk.byteLength) } });
    expect(res.status, await res.clone().text()).toBe(200);
    etags.push((await res.json()) as { partNumber: number; etag: string });
  }
  const done = await api(u, `/api/assets/uploads/${assetId}/complete`, { method: "POST", json: { parts: etags } });
  expect(done.status, await done.clone().text()).toBe(200);
  return { assetId, asset: ((await done.json()) as { asset: any }).asset };
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
    const wrong = await api(alice, `/api/assets/uploads/${start.assetId}/parts/1`, { method: "PUT", body: new Uint8Array(50), headers: { "content-length": "50" } });
    expect(wrong.status).toBe(400);
    expect((await api(alice, `/api/assets/uploads/${start.assetId}/parts/2`, { method: "PUT", body: new Uint8Array(100), headers: { "content-length": "100" } })).status).toBe(400);
    // Someone else cannot add parts.
    expect((await api(user("bob"), `/api/assets/uploads/${start.assetId}/parts/1`, { method: "PUT", body: new Uint8Array(100), headers: { "content-length": "100" } })).status).toBe(404);
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
