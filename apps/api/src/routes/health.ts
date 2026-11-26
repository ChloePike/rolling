import { Hono } from "hono";
import type { AppEnv } from "../env";
import { currentD1 } from "../lib/d1Session";
import { edgeCache } from "../lib/httpCache";
import { WEB_PREFIX } from "../lib/r2Static";

/**
 * `GET /api/health` — liveness. `?timing=1` adds a latency breakdown from the colo that answered:
 * one D1 read through the request's session (which region served it, replica or primary), one
 * R2 HEAD on the SPA shell, one edge-cache lookup of the shell. Never cached.
 */
export const health = new Hono<AppEnv>().get("/", async (c) => {
  const base = { ok: true, service: "rolling-api", environment: c.env.ENVIRONMENT, time: Date.now() };
  if (c.req.query("timing") !== "1") return c.json(base);

  const cf = (c.req.raw as { cf?: { colo?: string; country?: string } }).cf;
  let t = Date.now();
  const d1 = await c.env.DB.prepare("SELECT 1 AS ok").all();
  const d1Ms = Date.now() - t;
  const meta = d1.meta as { served_by_region?: string; served_by_primary?: boolean };

  t = Date.now();
  await c.env.MEDIA.head(`${WEB_PREFIX}/index.html`);
  const r2Ms = Date.now() - t;

  t = Date.now();
  const cache = edgeCache();
  const hit = cache ? await cache.match(new Request(new URL("/__edge/web/v1/", c.req.url).toString())) : undefined;
  const edgeMs = Date.now() - t;

  c.header("cache-control", "no-store");
  return c.json({
    ...base,
    colo: cf?.colo ?? null,
    country: cf?.country ?? null,
    d1: { ms: d1Ms, region: meta.served_by_region ?? null, primary: meta.served_by_primary ?? null, start: currentD1()?.start ?? null },
    r2: { ms: r2Ms },
    edge: { ms: edgeMs, shellCached: Boolean(hit) },
  });
});
