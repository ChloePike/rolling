/**
 * `GET /api/status` (public, D-029): component status from the 5-minute
 * probes, whether generation is available (gateway circuit breaker), and the
 * incident banner. Cached at the edge for 30 s; the app polls it for the banner.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statusView } from "../ops/status";

export const status = new Hono<AppEnv>().get("/", async (c) => {
  const view = await statusView(c.env);
  c.header("cache-control", "public, max-age=30");
  return c.json(view);
});
