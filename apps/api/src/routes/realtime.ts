import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { roleAtLeast } from "@rolling/core/auth/roles";
import { requireUser } from "../auth/context";
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
  h.delete("x-workspace-id");
  h.delete("x-workspace-role");
  h.delete("x-can-edit");
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request(req, { headers: h });
}

/** Workspace of a project, if the caller is a member of it (missing and foreign projects look the same). */
async function projectWorkspace(env: Env, projectId: string, memberOf: ReadonlySet<string>): Promise<string | null> {
  const row = await env.DB.prepare("SELECT workspace_id FROM projects WHERE id = ?1").bind(projectId).first<{ workspace_id: string }>();
  return row && memberOf.has(row.workspace_id) ? row.workspace_id : null;
}

export const realtime = new Hono<AppEnv>()
  // Sockets need a session (cookie; dev header in development) and, for a project,
  // membership of the project's workspace. ProjectRoom re-checks on its side.
  .get(
    "/projects/:id/ws",
    validate("param", z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) })),
    async (c) => {
      requireUpgrade(c.req.raw);
      const { id } = c.req.valid("param");
      const auth = requireUser(c);
      const workspaceId = await projectWorkspace(c.env, id, new Set(auth.memberships.map((m) => m.workspaceId)));
      if (!workspaceId) throw new ApiError(404, "NOT_FOUND", "Project not found", { projectId: id });
      const role = auth.memberships.find((m) => m.workspaceId === workspaceId)!.role;
      const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(id));
      return stub.fetch(
        forward(c.req.raw, {
          "x-project-id": id,
          "x-user-id": auth.userId,
          "x-workspace-id": workspaceId,
          "x-workspace-role": role,
          "x-can-edit": roleAtLeast(role, "editor") ? "1" : "0",
        }),
      );
    },
  )
  .get("/ws", async (c) => {
    requireUpgrade(c.req.raw);
    const auth = requireUser(c);
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(auth.userId));
    return stub.fetch(forward(c.req.raw, { "x-user-id": auth.userId }));
  });
