import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { getSessionUser } from "../lib/session";

/** `GET /api/me` — full payload (workspace, role, prefs, plan, balance) in M1. */
export const me = new Hono<AppEnv>().get("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  throw new ApiError(501, "NOT_IMPLEMENTED", "Profile is not available yet", { userId: user.id });
});
