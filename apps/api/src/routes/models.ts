import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { getSessionUser } from "../lib/session";
import { validate } from "../lib/validate";
import { listPublicModels } from "../models/catalog";

const ModelsQuery = z.object({ kind: z.enum(["image", "video", "chat"]).optional() });

/**
 * `GET /api/models?kind=` — the synced catalog (D-002). Public read; mature-only
 * models appear only for callers allowed to see them (D-005), so responses for
 * signed-in callers are private.
 */
export const models = new Hono<AppEnv>().get("/", validate("query", ModelsQuery), async (c) => {
  const { kind } = c.req.valid("query");
  const user = await getSessionUser(c);
  const list = await listPublicModels(c.env, user, kind);
  c.header("cache-control", `${user ? "private" : "public"}, max-age=300`);
  c.header("vary", "cookie, authorization");
  return c.json({ models: list });
});
