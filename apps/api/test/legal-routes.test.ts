import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../src/env";
import { serveSpaFromR2, WEB_PREFIX } from "../src/lib/r2Static";
import { NOINDEX, NON_PRODUCTION_ROBOTS, robotsPolicy } from "../src/lib/robots";

/**
 * `/terms` and `/privacy` are registered with Google OAuth and checked by
 * Google without JavaScript: direct loads get the build-time static page
 * (apps/web/scripts/prerender-legal.mjs) with the full text, never a redirect,
 * the API's 404 or the empty app shell. `/` is the app shell, which carries a
 * static description for visitors without JavaScript. Files are the real
 * build inputs (vitest.config.ts → TEST_WEB_FILES), uploaded as the deploy does.
 */
describe("static web pages served from R2", () => {
  beforeAll(async () => {
    for (const [path, body] of Object.entries(env.TEST_WEB_FILES)) await env.MEDIA.put(`${WEB_PREFIX}/${path}`, body);
  });

  // Staging and production serve the web build from R2 (scripts/deploy/*-r2.sh); the pool binds ASSETS instead.
  const get = (path: string) => serveSpaFromR2(env.MEDIA, new Request(`https://example.com${path}`));

  it("GET /privacy is complete HTML with the Google user data section, no script needed", async () => {
    const res = await get("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("etag")).toBeTruthy();
    const html = await res.text();
    expect(html).toContain("<title>Privacy policy · Rolling</title>");
    expect(html).toContain('<link rel="canonical" href="https://rolling.actor/privacy">');
    expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
    expect(html).toContain('<h2 id="google-user-data">Google user data</h2>');
    expect(html).toContain("Limited Use");
    expect(html).toContain("https://developers.google.com/terms/api-services-user-data-policy");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Draft for legal review");
    expect(html).not.toContain("data-placeholder");
  });

  for (const [path, title] of [["/terms", "Terms of service"], ["/acceptable-use", "Acceptable use policy"], ["/subprocessors", "Subprocessors"]] as const) {
    it(`GET ${path} is the static page`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<h1 id="${title.toLowerCase().replace(/ /g, "-")}">${title}</h1>`);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("data-placeholder");
    });
  }

  it("GET / is the app shell with a static description and visible legal links", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('id="root"');
    expect(html).toContain("Rolling is a video studio for creators and small brand teams");
    expect(html).toContain('<a href="/privacy">Privacy policy</a>');
    expect(html).toContain('<a href="/terms">Terms of service</a>');
    expect(html).toContain("support@rolling.actor");
  });

  it("other SPA routes, including the old /legal/<doc> paths, still get the app shell", async () => {
    for (const path of ["/legal/privacy", "/p/prj_1", "/settings"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="root"');
    }
  });

  it("serves robots.txt and sitemap.xml", async () => {
    const robots = await get("/robots.txt");
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const txt = await robots.text();
    expect(txt).toContain("Disallow: /api/");
    expect(txt).toContain("Disallow: /p/");
    expect(txt).toContain("Sitemap: https://rolling.actor/sitemap.xml");
    const sitemap = await get("/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const xml = await sitemap.text();
    for (const p of ["/", "/privacy", "/terms", "/acceptable-use", "/subprocessors"]) expect(xml).toContain(`<loc>https://rolling.actor${p}</loc>`);
  });
});

describe("www redirect (D-015)", () => {
  it("sends www.<app host> to the apex with a 301, keeping path and query", async () => {
    const appHost = new URL(env.PUBLIC_APP_URL).host;
    const res = await SELF.fetch(`http://www.${appHost}/privacy?x=1`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${new URL(env.PUBLIC_APP_URL).origin}/privacy?x=1`);
    const other = await SELF.fetch("https://www.example.com/terms", { redirect: "manual" });
    expect(other.status).toBe(200);
  });
});

describe("indexing per environment (LEGAL-3)", () => {
  it("outside production: robots.txt disallows all, no sitemap, X-Robots-Tag on every response", async () => {
    expect(env.ENVIRONMENT).not.toBe("production");
    const robots = await SELF.fetch("https://example.com/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const txt = await robots.text();
    expect(txt).toMatch(/^Disallow: \/$/m);
    expect(txt).not.toMatch(/Sitemap:/);
    expect((await SELF.fetch("https://example.com/sitemap.xml")).status).toBe(404);
    for (const path of ["/api/health", "/api/nope", "/privacy"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.headers.get("x-robots-tag"), path).toBe(NOINDEX);
    }
  });

  it("production passes robots.txt and sitemap.xml through unchanged, without the noindex header", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", robotsPolicy);
    app.get("*", (c) => c.text(`file ${c.req.path}`));
    const prod = { ENVIRONMENT: "production" } as unknown as AppEnv["Bindings"];
    for (const path of ["/robots.txt", "/sitemap.xml", "/"]) {
      const res = await app.request(path, {}, prod);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`file ${path}`);
      expect(res.headers.get("x-robots-tag")).toBeNull();
    }
    const staging = { ENVIRONMENT: "staging" } as unknown as AppEnv["Bindings"];
    expect(await (await app.request("/robots.txt", {}, staging)).text()).toBe(NON_PRODUCTION_ROBOTS);
    expect((await app.request("/", {}, staging)).headers.get("x-robots-tag")).toBe(NOINDEX);
  });
});
