import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { getSessionUser } from "../lib/session";
import { validate } from "../lib/validate";

function requireUpgrade(req: Request): void {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "BAD_REQUEST", "Expected WebSocket upgrade");
  }
}

/** Forward a WebSocket upgrade to a DO with identity headers set by the Worker (never by the client). */
function forward(req: Request, headers: Record<string, string>): Request {
  const h = new Headers(req.headers);
  h.delete("x-user-id");
  h.delete("x-project-id");
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request(req, { headers: h });
}

export const realtime = new Hono<AppEnv>()
  // TODO(M3): require a session and check project membership before connecting.
  .get(
    "/projects/:id/ws",
    validate("param", z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) })),
    async (c) => {
      requireUpgrade(c.req.raw);
      const { id } = c.req.valid("param");
      const user = await getSessionUser(c);
      const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(id));
      return stub.fetch(forward(c.req.raw, { "x-project-id": id, "x-user-id": user?.id ?? "anonymous" }));
    },
  )
  .get("/ws", async (c) => {
    requireUpgrade(c.req.raw);
    const user = await getSessionUser(c);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
    return stub.fetch(forward(c.req.raw, { "x-user-id": user.id }));
  });
