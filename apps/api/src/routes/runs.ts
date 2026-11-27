/**
 * Runs (M4, docs/api.md → Runs): quote, start, cancel, retry, Activity list and single read.
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
import { cancelRun, quoteRun, retryRun, startRun } from "../runs/service";
import { getRunView, listRuns, RunsFilter } from "../runs/activity";
import { RunSurfaceSchema } from "../runs/surface";

const Id = z.string().min(1).max(80);

const QuoteBody = z.union([
  z.object({
    projectId: Id,
    scope: z.enum(["node", "selection", "all", "upTo", "from"]),
    nodeIds: z.array(Id).max(500).optional(),
    /** Who started it: `canvas` (default) or `agent`. */
    surface: RunSurfaceSchema.optional(),
  }),
  /** `surface`: `home` (Home prompt box) or `quick` (default); tool specs are always their tool. */
  z.object({ promptSpec: PromptSpecSchema, projectId: Id.optional(), surface: RunSurfaceSchema.optional() }),
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
      return c.json(await quoteRun(c.env, auth, { promptSpec: body.promptSpec, projectId: body.projectId ?? null, ...(body.surface && { surface: body.surface }) }));
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
        ...(body.surface && { surface: body.surface }),
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
  .post("/:id/retry", validate("param", z.object({ id: Id })), async (c) => {
    // Like a quote: open to non-members (the start answers NO_PLAN); the client confirms the fresh quote.
    const auth = requireRole(c, "editor");
    return c.json(
      await retryRun(c.env, auth, c.req.valid("param").id, async (projectId) => {
        const access = await projectAccess(c, auth, projectId, "editor");
        return { caller: roomCaller(auth, access), matureAllowed: access.matureAllowed };
      }),
    );
  })
  .get("/", validate("query", RunsFilter), async (c) => {
    const auth = requireUser(c);
    return c.json(await listRuns(c.env, auth.workspaceId, c.req.valid("query")));
  })
  .get("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = requireUser(c);
    const run = await getRunView(c.env, auth.workspaceId, c.req.valid("param").id);
    if (!run) throw new ApiError(404, "NOT_FOUND", "Run not found");
    return c.json({ run });
  });
