import type { Context } from "hono";
import type { AppEnv } from "../env";
import { resolveAuth } from "../auth/context";

export interface SessionUser {
  id: string;
}

/**
 * The signed-in user, from the auth context resolved once per request by
 * `authMiddleware` (`apps/api/src/auth/context.ts`). Prefer `c.get("auth")` or
 * `requireUser` / `requireMember` / `requireRole` in new code; this stays for
 * callers that only need the id. The dev header (`x-dev-user`) is honoured only
 * in `ENVIRONMENT=development` (local dev and tests), inside the middleware.
 */
export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const auth = c.get("auth");
  if (auth !== undefined) return auth ? { id: auth.userId } : null;
  const resolved = await resolveAuth(c);
  return resolved ? { id: resolved.userId } : null;
}
