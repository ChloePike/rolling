/**
 * Exports (canvas-flow step 11): `POST /api/canvases/:id/export` and
 * `GET /api/exports/:id`. Editors and owners of the project's workspace with
 * an active plan (D-007: `402 NO_PLAN`); free of credits for now.
 * Logic in `../exports/service.ts` and `ExportWorkflow`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { EXPORT_PRESETS } from "@rolling/core/export";
import type { AppEnv } from "../env";
import { projectAccess, requireAuth, roomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { projectIdForCanvas } from "../do/ProjectRoom";
import { createExports, exportView, loadExport } from "../exports/service";
import { ExportOptionsSchema } from "@rolling/core/export";

const CanvasParam = z.object({ id: z.string().regex(/^cnv_[A-Za-z0-9]+$/) });
const ExportParam = z.object({ id: z.string().regex(/^exp_[A-Za-z0-9]+$/) });

const Seconds = z.number().finite().min(0).max(24 * 3600);
const ExportBody = z.object({
  preset: z.enum(EXPORT_PRESETS),
  range: z.object({ start: Seconds, end: Seconds }).refine((r) => r.end > r.start, { message: "end must be after start" }).optional(),
  /** Batch export (D-034): more presets started with `preset`, same range and options. */
  presets: z.array(z.enum(EXPORT_PRESETS)).max(EXPORT_PRESETS.length).optional(),
  /** Captions burn-in, Smoother motion, brand kit, preview (D-033 .. D-035). */
  options: ExportOptionsSchema.optional(),
});

async function access(c: Context<AppEnv>, projectId: string, min: "viewer" | "editor") {
  const auth = await requireAuth(c);
  const acc = await projectAccess(c, auth, projectId, min);
  return { auth, acc };
}

/** Mounted at `/api/canvases` next to the timeline routes. */
export const canvasExports = new Hono<AppEnv>().post("/:id/export", validate("param", CanvasParam), validate("json", ExportBody), async (c) => {
  const canvasId = c.req.valid("param").id;
  const projectId = projectIdForCanvas(canvasId);
  if (!projectId) throw new ApiError(404, "NOT_FOUND", "Canvas not found");
  const { auth, acc } = await access(c, projectId, "editor");
  if (!acc.membership.plan) throw new ApiError(402, "NO_PLAN", "An active plan is required", { workspaceId: acc.project.workspace_id });
  const body = c.req.valid("json");
  const presets = [body.preset, ...(body.presets ?? [])];
  const rows = await createExports(c.env, { caller: roomCaller(auth, acc), projectId, canvasId, presets, ...(body.range ? { range: body.range } : {}), ...(body.options ? { options: body.options } : {}) });
  const views = await Promise.all(rows.map((r) => exportView(c.env, r, { mayViewMature: acc.matureAllowed })));
  return c.json({ export: views[0], exports: views }, 201);
});

/** `GET /api/exports/:id`: status, progress and (when done) a fresh signed download URL. */
export const exportsRoute = new Hono<AppEnv>().get("/:id", validate("param", ExportParam), async (c) => {
  const row = await loadExport(c.env, c.req.valid("param").id);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Export not found");
  const { acc } = await access(c, row.project_id, "viewer").catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 403) throw err;
    throw new ApiError(404, "NOT_FOUND", "Export not found");
  });
  return c.json({ export: await exportView(c.env, row, { mayViewMature: acc.matureAllowed }) });
});
