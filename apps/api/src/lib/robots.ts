import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/**
 * Search indexing per environment (LEGAL-3). Production serves the build's `robots.txt` and
 * `sitemap.xml` unchanged. Every other environment (staging, development) must never be indexed:
 * `robots.txt` disallows everything, there is no sitemap, and every response carries
 * `X-Robots-Tag: noindex, nofollow` (crawlers that ignore robots.txt still drop the pages).
 */
export const NON_PRODUCTION_ROBOTS = "User-agent: *\nDisallow: /\n";
export const NOINDEX = "noindex, nofollow";

export function isProduction(environment: string | undefined): boolean {
  return environment === "production";
}

export const robotsPolicy: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isProduction(c.env.ENVIRONMENT)) return next();
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    if (c.req.path === "/robots.txt") {
      return new Response(c.req.method === "HEAD" ? null : NON_PRODUCTION_ROBOTS, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": NOINDEX },
      });
    }
    if (c.req.path === "/sitemap.xml") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": NOINDEX } });
    }
  }
  await next();
  // WebSocket upgrades (101) have immutable headers; everything else gets the tag.
  if (c.res.status === 101) return;
  try {
    c.res.headers.set("x-robots-tag", NOINDEX);
  } catch {
    // Immutable headers (a fetched response passed through): copy into a new response.
    const res = new Response(c.res.body, c.res);
    res.headers.set("x-robots-tag", NOINDEX);
    c.res = res;
  }
};
