/**
 * `GET /api/showcase`: the sign-in panel's preview clips. Public, built-ins with a
 * preview clip only, never mature, edge-cached with an ETag.
 */
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listShowcase, SHOWCASE_LIMIT, type ShowcaseItem } from "../src/routes/showcase";

const BASE = "https://example.com";
const MATURE_ID = "tpl_showcase_mature";
const TAGGED_ID = "tpl_showcase_tagged";

async function insertBuiltin(id: string, meta: Record<string, unknown>) {
  const keys = {
    coverKey: `public/templates/${id}/poster.jpg`,
    coverWebpKey: `public/templates/${id}/poster.webp`,
    previewKey: `public/templates/${id}/preview.mp4`,
    coverWidth: 720,
    coverHeight: 1280,
  };
  await env.DB.prepare(
    "INSERT INTO templates (id, workspace_id, title, category, graph, slots, preview_asset_id, uses, description, meta, created_at, updated_at) VALUES (?, NULL, ?, 'drama', ?, '[]', NULL, 0, NULL, ?, 1000, 1000)",
  )
    .bind(id, `Showcase ${id}`, JSON.stringify({ nodes: [], edges: [], groups: [] }), JSON.stringify({ ...keys, ...meta }))
    .run();
}

describe("GET /api/showcase", () => {
  beforeAll(async () => {
    // Newest in feed order, so they would lead the list if they were not filtered out.
    await insertBuiltin(MATURE_ID, { mature: true });
    await insertBuiltin(TAGGED_ID, { tags: ["18+"] });
  });

  it("is public: anonymous callers get built-in clips with posters on the public bucket", async () => {
    const res = await SELF.fetch(`${BASE}/api/showcase`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: ShowcaseItem[] };
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(SHOWCASE_LIMIT);
    for (const it of items) {
      expect(it.id).toMatch(/^tpl_/);
      expect(it.name.length).toBeGreaterThan(0);
      expect(it.previewUrl).toMatch(new RegExp(`^/api/media/public/templates/${it.id}/preview-[0-9a-f]{10}\\.mp4$`));
      expect(it.posterUrl).toMatch(new RegExp(`^/api/media/public/templates/${it.id}/poster-[0-9a-f]{10}\\.(webp|jpg)$`));
      expect(it.poster.jpg).toMatch(/\.jpg$/);
      expect(it.aspect).toBe(`${it.width}/${it.height}`);
      expect(it.width).toBeGreaterThan(0);
      expect(it.height).toBeGreaterThan(0);
    }
    // Templates without a clip (e.g. the comic page) are not on the panel.
    expect(items.map((i) => i.id)).not.toContain("tpl_comic_page");
  });

  it("never includes mature templates", async () => {
    const { items } = (await (await SELF.fetch(`${BASE}/api/showcase`)).json()) as { items: ShowcaseItem[] };
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(MATURE_ID);
    expect(ids).not.toContain(TAGGED_ID);
    const direct = (await listShowcase(env as Env, 100)).map((i) => i.id);
    expect(direct).not.toContain(MATURE_ID);
    expect(direct).not.toContain(TAGGED_ID);
  });

  it("uses the public media host when one is configured", async () => {
    const items = await listShowcase({ ...env, PUBLIC_MEDIA_BASE_URL: "https://media.rolling.actor" } as Env);
    expect(items[0]!.previewUrl.startsWith("https://media.rolling.actor/public/templates/")).toBe(true);
    expect(items[0]!.posterUrl.startsWith("https://media.rolling.actor/public/templates/")).toBe(true);
  });

  it("is publicly cacheable with an ETag and answers 304 on revalidation", async () => {
    const first = await SELF.fetch(`${BASE}/api/showcase`);
    expect(first.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/);
    await first.arrayBuffer();
    const again = await SELF.fetch(`${BASE}/api/showcase`, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    // Signed-in callers get the same public body (nothing per user in it).
    const signed = await SELF.fetch(`${BASE}/api/showcase`, { headers: { "x-dev-user": "showcaseviewer" } });
    expect(signed.status).toBe(200);
    expect(signed.headers.get("etag")).toBe(etag);
    await signed.arrayBuffer();
  });
});
