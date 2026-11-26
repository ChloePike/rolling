import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { signMediaKey } from "@rolling/core/media";
import { app } from "../src/index";
import { mediaSigningKey, mediaUrlFor } from "../src/lib/mediaUrls";

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://example.com/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: unknown[] };
}

const angles = (id: string, category: string) =>
  JSON.stringify([
    { name: "front", r2Key: `public/${category}/${id}/front.webp`, depthR2Key: `public/pose_depth/${id}_d/front.png` },
    { name: "side", r2Key: `public/${category}/${id}/side.webp` },
  ]);

describe("public-library media and GraphQL image fields", () => {
  beforeAll(async () => {
    const insert = env.DB.prepare(
      "INSERT INTO public_items (id, category, sub, title, tags, asset_id, license, source, angles, depth_key, mature, sort) VALUES (?, ?, ?, ?, '[]', ?, 'first-party', 'posewear', ?, ?, ?, ?)",
    );
    await env.DB.batch([
      insert.bind("pw_m1", "outfit", "casual", "Denim jacket", "ast_m1", angles("pw_m1", "outfit"), "public/pose_depth/pw_m1_d/front.png", 0, 1),
      insert.bind("pw_m2", "outfit", "casual", "Hoodie", "ast_m2", angles("pw_m2", "outfit"), null, 0, 2),
      insert.bind("pw_m3", "outfit", "formal", "Suit", "ast_m3", angles("pw_m3", "outfit"), null, 0, 3),
      insert.bind("pw_m4", "outfit", "lingerie", "Mature item", "ast_m4", angles("pw_m4", "outfit"), null, 1, 4),
    ]);
    await env.MEDIA.put("public/outfit/pw_m1/front.webp", new Uint8Array([1, 2, 3]));
    await env.MEDIA.put("public/outfit/pw_m4/front.webp", new Uint8Array([9, 9, 9]));
  });

  it("serves images of public, non-mature items with immutable caching", async () => {
    const res = await SELF.fetch("https://example.com/api/media/public/outfit/pw_m1/front.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("never serves mature items, unknown items, wrong categories or odd keys", async () => {
    for (const path of [
      "public/outfit/pw_m4/front.webp",
      "public/outfit/pw_nope/front.webp",
      "public/pose/pw_m1/front.webp",
      "public/outfit/pw_m1/../pw_m4/front.webp",
      "private/outfit/pw_m1/front.webp",
    ]) {
      const res = await SELF.fetch(`https://example.com/api/media/${path}`);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });

  it("returns thumbnail, angle and depth URLs, filters by sub and lists facets", async () => {
    const { data, errors } = await gql(`{
      publicItems(category: "outfit", sub: "casual") { edges { node { id thumbUrl depthUrl angles { name url depthUrl } } } }
      publicSubCategories(category: "outfit") { key count }
    }`);
    expect(errors).toBeUndefined();
    const nodes = data.publicItems.edges.map((e: any) => e.node);
    expect(nodes.map((n: any) => n.id)).toEqual(["pw_m1", "pw_m2"]);
    expect(nodes[0]).toMatchObject({
      thumbUrl: "/api/media/public/outfit/pw_m1/front.webp",
      depthUrl: "/api/media/public/pose_depth/pw_m1_d/front.png",
      angles: [
        { name: "front", url: "/api/media/public/outfit/pw_m1/front.webp", depthUrl: "/api/media/public/pose_depth/pw_m1_d/front.png" },
        { name: "side", url: "/api/media/public/outfit/pw_m1/side.webp", depthUrl: null },
      ],
    });
    expect(data.publicSubCategories).toEqual([
      { key: "casual", count: 2 },
      { key: "formal", count: 1 },
    ]);
  });
});

describe("private media host (D-008)", () => {
  const HOST = "https://cdn-private.example.com";
  const mediaEnv = () => ({ ...env, PRIVATE_MEDIA_BASE_URL: HOST, PUBLIC_MEDIA_BASE_URL: "https://media.example.com" }) as Env;
  const key = "ws/ws_media/uploads/ast_1/clip.mp4";
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

  async function call(path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${HOST}${path}`, init), mediaEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  beforeAll(async () => {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  });

  it("answers only signed URLs: unsigned 403, signed 200 with long cache, Range 206", async () => {
    const unsigned = await call(`/media/${key}`);
    expect(unsigned.status).toBe(403);
    await unsigned.arrayBuffer();

    const signed = await signMediaKey(key, { workspaceId: "ws_media", expiresIn: 3600, alignSeconds: 3600, secret: mediaSigningKey(env), baseUrl: HOST });
    const path = signed.slice(HOST.length);
    const ok = await call(path, { headers: { origin: "http://localhost:8787" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/);
    expect(Number(/max-age=(\d+)/.exec(ok.headers.get("cache-control")!)![1])).toBeGreaterThanOrEqual(3500);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:8787");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);

    const ranged = await call(path, { headers: { range: "bytes=10-19" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(10, 20));
  });

  it("serves nothing else on that host", async () => {
    for (const path of ["/", "/api/health", "/login", `/api/media/public/outfit/pw_m1/front.webp`]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
    const preflight = await call(`/media/${key}`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(preflight.status).toBe(403);
  });

  it("signs mature public-library objects instead of linking the public bucket", async () => {
    const viewer = { mayViewMature: true };
    expect(await mediaUrlFor(mediaEnv(), { key: "public/outfit/pw_m1/front.webp", workspaceId: null, mature: false }, viewer)).toBe(
      "https://media.example.com/public/outfit/pw_m1/front.webp",
    );
    const mature = await mediaUrlFor(mediaEnv(), { key: "public/outfit/pw_m4/front.webp", workspaceId: null, mature: true }, viewer);
    expect(mature).toMatch(/^https:\/\/cdn-private\.example\.com\/media\/public\/outfit\/pw_m4\/front\.webp\?exp=\d+&ws=_&sig=/);
    expect(await mediaUrlFor(mediaEnv(), { key: "public/outfit/pw_m4/front.webp", workspaceId: null, mature: true }, { mayViewMature: false })).toBeNull();
  });
});
