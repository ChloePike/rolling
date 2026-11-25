import type { Context } from "hono";
import type { AppEnv } from "../env";

export interface SessionUser {
  id: string;
}

/**
 * Resolves the signed-in user. Better Auth lands in M1; until then there is
 * never a session, except the dev-only `x-dev-user` header / `devUser` query
 * (honoured only when `ENVIRONMENT === "development"`) so sockets can be tried locally.
 */
export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  if (c.env.ENVIRONMENT === "development") {
    const dev = c.req.header("x-dev-user") ?? c.req.query("devUser");
    if (dev && /^[A-Za-z0-9_-]{1,64}$/.test(dev)) return { id: dev };
  }
  return null;
}
