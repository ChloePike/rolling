import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { WEB_PREFIX } from "../src/lib/r2Static";

/**
 * `/terms` and `/privacy` are registered with Google OAuth: a direct deep load
 * (no session cookie) must get the SPA's index.html with 200, never a redirect
 * or the API's 404. The other legal pages and the old `/legal/<doc>` paths are
 * SPA routes too (the SPA redirects the old ones on the client).
 */
describe("legal pages: SPA fallback for direct loads", () => {
  beforeAll(async () => {
    // Used when the static-assets binding is absent (R2-served SPA, staging fallback).
    await env.MEDIA.put(`${WEB_PREFIX}/index.html`, '<!doctype html><html><body><div id="root"></div></body></html>');
  });

  for (const path of ["/terms", "/privacy", "/acceptable-use", "/subprocessors", "/legal/privacy"]) {
    it(`GET ${path} serves the app shell`, async () => {
      const res = await SELF.fetch(`https://example.com${path}`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      expect(await res.text()).toContain('id="root"');
    });
  }
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
