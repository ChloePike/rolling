import { Hono } from "hono";
import type { AppEnv } from "../env";

export const health = new Hono<AppEnv>().get("/", (c) =>
  c.json({ ok: true, service: "rolling-api", environment: c.env.ENVIRONMENT, time: Date.now() }),
);
