import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { serveSpaFromR2, WEB_PREFIX } from "../src/lib/r2Static";

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
