import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { edgeTtl, preloadLinks, serveSpaFromR2, WEB_PREFIX } from "../src/lib/r2Static";

/** Headers of the R2-served SPA (staging/production deploys without the assets binding), PWA files included. */
describe("r2Static: SPA and PWA headers", () => {
  beforeAll(async () => {
    await env.MEDIA.put(`${WEB_PREFIX}/index.html`, '<!doctype html><div id="root"></div>');
    await env.MEDIA.put(`${WEB_PREFIX}/sw.js`, "self.addEventListener('fetch', () => {});");
    await env.MEDIA.put(`${WEB_PREFIX}/manifest.webmanifest`, '{"name":"Rolling"}');
    await env.MEDIA.put(`${WEB_PREFIX}/assets/index-abc123.js`, "console.log(1)");
    await env.MEDIA.put(`${WEB_PREFIX}/assets/geist-abc123.woff2`, "font");
    await env.MEDIA.put(`${WEB_PREFIX}/icons/app-icon-192.png`, "png");
  });

  const get = (path: string, init?: RequestInit) => serveSpaFromR2(env.MEDIA, new Request(`https://rolling.test${path}`, init));

  it("serves /sw.js as JavaScript, never cached, allowed to control the whole origin", async () => {
    const res = await get("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    expect(await res.text()).toContain("addEventListener");
  });

  it("serves the web manifest as application/manifest+json, revalidated", async () => {
    const res = await get("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("service-worker-allowed")).toBeNull();
  });

  it("serves hashed assets as immutable with their content types", async () => {
    const js = await get("/assets/index-abc123.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const font = await get("/assets/geist-abc123.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates index.html and icons; SPA routes fall back to index.html", async () => {
    const shell = await get("/");
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    const route = await get("/p/prj_1");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('id="root"');
    const icon = await get("/icons/app-icon-192.png");
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("does not fall back to index.html for a missing file (a missing sw.js must be a 404)", async () => {
    await env.MEDIA.delete(`${WEB_PREFIX}/sw.js`);
    expect((await get("/sw.js")).status).toBe(404);
    expect((await get("/assets/missing-123.js")).status).toBe(404);
  });

  it("answers a matching If-None-Match with 304", async () => {
    const first = await get("/manifest.webmanifest");
    const etag = first.headers.get("etag")!;
    const again = await get("/manifest.webmanifest", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("no-cache");
  });
});

/** Edge cache (Cache API) in front of R2: lifetimes, bypass for fresh fetches, Early Hints links. */
describe("r2Static: edge cache", () => {
  const host = "https://edge.rolling.test";
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const get = async (path: string, init?: RequestInit) => {
    const res = await serveSpaFromR2(env.MEDIA, new Request(`${host}${path}`, init), ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="preload" href="/assets/Geist-x.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>';

  beforeAll(async () => {
    await env.MEDIA.put(`${WEB_PREFIX}/index.html`, html);
    await env.MEDIA.put(`${WEB_PREFIX}/assets/app-edge1.js`, "console.log('v1')");
    await env.MEDIA.put(`${WEB_PREFIX}/sw.js`, "// sw v1");
  });

  it("uses a year for hashed assets, 10 s for sw.js and 60 s for everything else", () => {
    expect(edgeTtl("assets/index-abc.js")).toBe(31_536_000);
    expect(edgeTtl("sw.js")).toBe(10);
    expect(edgeTtl("index.html")).toBe(60);
    expect(edgeTtl("privacy.html")).toBe(60);
    expect(edgeTtl("manifest.webmanifest")).toBe(60);
    expect(edgeTtl("robots.txt")).toBe(60);
  });

  it("serves the second request from the edge copy with the browser's Cache-Control", async () => {
    const first = await get("/assets/app-edge1.js");
    expect(first.headers.get("x-edge-cache")).toBe("MISS");
    expect(first.headers.get("server-timing")).toMatch(/r2;dur=\d+/);
    // Gone from R2: only the edge copy can answer now.
    await env.MEDIA.delete(`${WEB_PREFIX}/assets/app-edge1.js`);
    const second = await get("/assets/app-edge1.js");
    expect(second.headers.get("x-edge-cache")).toBe("HIT");
    expect(second.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(second.headers.get("x-served-path")).toBeNull();
    expect(await second.text()).toBe("console.log('v1')");
  });

  it("answers If-None-Match with 304 from the edge copy", async () => {
    const first = await get("/");
    const etag = first.headers.get("etag")!;
    const again = await get("/", { headers: { "if-none-match": etag } });
    expect(again.headers.get("x-edge-cache")).toBe("HIT");
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("no-cache");
  });

  it("skips the edge copy for a no-cache fetch (Workbox precache), so a new sw.js never precaches a stale shell", async () => {
    await get("/index.html");
    await env.MEDIA.put(`${WEB_PREFIX}/index.html`, html.replace("index-abc.js", "index-def.js"));
    const stale = await get("/index.html");
    expect(stale.headers.get("x-edge-cache")).toBe("HIT");
    expect(await stale.text()).toContain("index-abc.js");
    const fresh = await get("/index.html", { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
    expect(fresh.headers.get("x-edge-cache")).toBe("BYPASS");
    expect(await fresh.text()).toContain("index-def.js");
    // The fresh fetch also refreshed the edge copy.
    expect(await (await get("/index.html")).text()).toContain("index-def.js");
  });

  it("serves sw.js with service-worker-allowed from the edge copy too", async () => {
    await get("/sw.js");
    const hit = await get("/sw.js");
    expect(hit.headers.get("x-edge-cache")).toBe("HIT");
    expect(hit.headers.get("service-worker-allowed")).toBe("/");
    expect(hit.headers.get("cache-control")).toBe("no-cache");
  });

  it("adds Link preloads (Early Hints) for the entry script, stylesheet and font of HTML pages", async () => {
    const res = await get("/p/prj_edge");
    const link = res.headers.get("link") ?? "";
    expect(link).toContain("</assets/index-def.js>; rel=modulepreload; crossorigin");
    expect(link).toContain("</assets/index-abc.css>; rel=preload; as=style; crossorigin");
    expect(link).toContain('</assets/Geist-x.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin');
    expect(preloadLinks("<html><head></head></html>")).toBeNull();
  });

  it("does not cache misses", async () => {
    expect((await get("/assets/never-edge.js")).status).toBe(404);
    await env.MEDIA.put(`${WEB_PREFIX}/assets/never-edge.js`, "late");
    expect((await get("/assets/never-edge.js")).status).toBe(200);
  });
});
