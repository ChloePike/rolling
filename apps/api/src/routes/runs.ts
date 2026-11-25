/**
 * Runs (M4, docs/api.md → Runs): quote, start, cancel, Activity list.
 * Thin handlers; logic in `../runs/service.ts` and `@rolling/core/generation`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PromptSpecSchema } from "@rolling/core/generation";
import { requireMember, requireRole, requireUser } from "../auth/context";
import type { AppEnv } from "../env";
import { projectAccess, roomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { cancelRun, quoteRun, startRun } from "../runs/service";
import { listRuns, RunsFilter } from "../runs/activity";

const Id = z.string().min(1).max(80);

const QuoteBody = z.union([
  z.object({
    projectId: Id,
    scope: z.enum(["node", "selection", "all", "upTo", "from"]),
    nodeIds: z.array(Id).max(500).optional(),
  }),
  z.object({ promptSpec: PromptSpecSchema, projectId: Id.optional() }),
]);

const StartBody = z.object({
  quoteId: Id,
  /** Staging and development only: fail items without calling the provider (refund testing). Ignored in production. */
  options: z
    .object({ forceFailure: z.union([z.literal(true), z.array(Id).max(200)]).optional() })
    .optional(),
});

export const runs = new Hono<AppEnv>()
  .post("/quote", validate("json", QuoteBody), async (c) => {
    // Quotes are open to signed-in non-members (D-007: the run itself returns NO_PLAN).
    const auth = requireRole(c, "editor");
    const body = c.req.valid("json");
    if ("promptSpec" in body) {
      if (body.projectId) await projectAccess(c, auth, body.projectId, "editor");
      return c.json(await quoteRun(c.env, auth, { promptSpec: body.promptSpec, projectId: body.projectId ?? null }));
    }
    if ((body.scope !== "all") && (!body.nodeIds || body.nodeIds.length === 0)) {
      throw new ApiError(400, "VALIDATION_FAILED", "nodeIds is required for this scope", { scope: body.scope });
    }
    if ((body.scope === "node" || body.scope === "upTo" || body.scope === "from") && body.nodeIds!.length !== 1) {
      throw new ApiError(400, "VALIDATION_FAILED", "This scope takes exactly one node id", { scope: body.scope });
    }
    const access = await projectAccess(c, auth, body.projectId, "editor");
    return c.json(
      await quoteRun(c.env, auth, {
        projectId: body.projectId,
        scope: body.scope,
        ...(body.nodeIds && { nodeIds: body.nodeIds }),
        caller: roomCaller(auth, access),
        matureAllowed: access.matureAllowed,
      }),
    );
  })
  .post("/", validate("json", StartBody), async (c) => {
    requireRole(c, "editor");
    const auth = requireMember(c);
    const { quoteId, options } = c.req.valid("json");
    return c.json(await startRun(c.env, auth, quoteId, options ?? {}), 201);
  })
  .post("/:id/cancel", validate("param", z.object({ id: Id })), async (c) => {
    const auth = requireRole(c, "editor");
    return c.json(await cancelRun(c.env, auth, c.req.valid("param").id));
  })
  .get("/", validate("query", RunsFilter), async (c) => {
    const auth = requireUser(c);
    return c.json(await listRuns(c.env, auth.workspaceId, c.req.valid("query")));
  });
