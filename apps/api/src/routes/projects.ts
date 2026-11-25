/**
 * Projects, graph patches, node versions, timeline and sharing (M3).
 * Graph state lives in the ProjectRoom DO; D1 `projects` is the index
 * (ProjectRoom updates it after commits, debounced).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { newId } from "@rolling/core/ids";
import { templateOps } from "@rolling/core/project";
import type { AppEnv } from "../env";
import { projectAccess, projectRoom, requireAuth, requireEditor, roomCaller, type AuthContext, type ProjectRow } from "../lib/access";
import { ApiError } from "../lib/errors";
import { mediaUrlFor } from "../lib/mediaUrls";
import { orFail, unwrap } from "../lib/room";
import { validate } from "../lib/validate";
import { projectIdForCanvas } from "../do/ProjectRoom";
import { createShare, revokeShares } from "../lib/share";

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const IdParam = z.object({ id: Id });
const Title = z.string().trim().min(1).max(120);

export interface ProjectView {
  id: string;
  workspaceId: string;
  title: string;
  kind: string;
  nodeCount: number;
  updatedAt: number;
  createdBy: string;
  thumbUrl: string | null;
}

export async function projectView(env: Env, row: ProjectRow): Promise<ProjectView> {
  // The index only ever stores non-mature thumbnails (ProjectRoom picks them).
  const thumbUrl = row.thumb_key ? await mediaUrlFor(env, { key: row.thumb_key, workspaceId: row.workspace_id, mature: false }, { mayViewMature: false }) : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    kind: row.kind,
    nodeCount: row.node_count,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    thumbUrl,
  };
}

function encodeCursor(row: Pick<ProjectRow, "updated_at" | "id">): string {
  return btoa(JSON.stringify([row.updated_at, row.id]));
}

function decodeCursor(cursor: string | null | undefined): [number, string] | null {
  if (!cursor) return null;
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    // Invalid cursor.
  }
  throw new ApiError(400, "BAD_REQUEST", "Invalid cursor");
}

/** Recent first, keyset pagination on (updated_at, id). Shared by REST and GraphQL. */
export async function listProjects(env: Env, workspaceId: string, first: number, after?: string | null) {
  const cur = decodeCursor(after);
  const rows = await env.DB.prepare(
    `SELECT * FROM projects WHERE workspace_id = ?1 ${cur ? "AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))" : ""}
     ORDER BY updated_at DESC, id DESC LIMIT ?4`,
  )
    .bind(workspaceId, cur?.[0] ?? null, cur?.[1] ?? null, first + 1)
    .all<ProjectRow>();
  const page = rows.results.slice(0, first);
  return {
    items: await Promise.all(page.map((r) => projectView(env, r))),
    hasNextPage: rows.results.length > first,
    endCursor: page.length ? encodeCursor(page.at(-1)!) : null,
  };
}

async function access(c: Context<AppEnv>, id: string, min: "viewer" | "editor" = "viewer") {
  const auth = await requireAuth(c);
  const acc = await projectAccess(c, auth, id, min);
  return { auth, acc, caller: roomCaller(auth, acc), room: projectRoom(c.env, id) };
}

const PatchBody = z.object({
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(z.unknown()).max(500),
  origin: z.enum(["user", "agent"]).optional(),
});

export const projects = new Hono<AppEnv>()
  .get("/", validate("query", z.object({ first: z.coerce.number().int().min(1).max(100).default(24), after: z.string().max(200).optional() })), async (c) => {
    const auth = await requireAuth(c);
    const { first, after } = c.req.valid("query");
    const page = await listProjects(c.env, auth.workspaceId, first, after);
    return c.json({ items: page.items, nextCursor: page.hasNextPage ? page.endCursor : null });
  })
  .post("/", validate("json", z.object({ title: Title.default("Untitled project"), fromTemplateId: Id.optional() })), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    const { title, fromTemplateId } = c.req.valid("json");
    let ops: ReturnType<typeof templateOps> = [];
    if (fromTemplateId) {
      const tpl = await c.env.DB.prepare("SELECT graph FROM templates WHERE id = ? AND (workspace_id IS NULL OR workspace_id = ?)")
        .bind(fromTemplateId, auth.workspaceId)
        .first<{ graph: string }>();
      if (!tpl) throw new ApiError(404, "NOT_FOUND", "Template not found", { templateId: fromTemplateId });
      try {
        ops = templateOps(JSON.parse(tpl.graph));
      } catch {
        throw new ApiError(422, "VALIDATION_FAILED", "Template graph is not readable", { templateId: fromTemplateId });
      }
    }
    const id = newId("project");
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO projects (id, workspace_id, title, kind, node_count, created_by, updated_at) VALUES (?, ?, ?, 'canvas', 0, ?, ?)")
      .bind(id, auth.workspaceId, title, auth.userId, now)
      .run();
    try {
      await projectRoom(c.env, id).init({ projectId: id, workspaceId: auth.workspaceId, title, createdBy: auth.userId, ops });
    } catch (err) {
      await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
      throw new ApiError(422, "VALIDATION_FAILED", err instanceof Error ? err.message : "Project could not be created");
    }
    if (fromTemplateId) await c.env.DB.prepare("UPDATE templates SET uses = uses + 1 WHERE id = ?").bind(fromTemplateId).run();
    const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
    return c.json({ project: await projectView(c.env, row!) }, 201);
  })
  .get("/:id", validate("param", IdParam), async (c) => {
    const { acc, caller, room } = await access(c, c.req.valid("param").id);
    const snapshot = orFail(await room.getSnapshot(caller));
    return c.json({ project: await projectView(c.env, acc.project), role: acc.role, canEdit: acc.canEdit, snapshot });
  })
  .patch("/:id", validate("param", IdParam), validate("json", z.object({ title: Title })), async (c) => {
    const id = c.req.valid("param").id;
    const { caller, room } = await access(c, id, "editor");
    const { title } = c.req.valid("json");
    unwrap(await room.setTitle(caller, title));
    await c.env.DB.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").bind(title, Date.now(), id).run();
    const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
    return c.json({ project: await projectView(c.env, row!) });
  })
  .delete("/:id", validate("param", IdParam), async (c) => {
    const id = c.req.valid("param").id;
    const { caller, room } = await access(c, id, "editor");
    await revokeShares(c.env, id);
    unwrap(await room.destroy(caller));
    await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  })
  .post("/:id/patch", validate("param", IdParam), validate("json", PatchBody), async (c) => {
    const { caller, room } = await access(c, c.req.valid("param").id, "editor");
    const body = c.req.valid("json");
    const result = unwrap(await room.applyPatch(caller, { baseRevision: body.baseRevision, ops: body.ops, origin: body.origin }));
    return c.json({ revision: result.revision, ops: result.ops, idMap: result.idMap, statuses: result.statuses });
  })
  .post("/:id/undo", validate("param", IdParam), async (c) => {
    const { caller, room } = await access(c, c.req.valid("param").id, "editor");
    const result = unwrap(await room.undo(caller));
    return c.json({ revision: result.revision, ops: result.ops, statuses: result.statuses });
  })
  .post("/:id/redo", validate("param", IdParam), async (c) => {
    const { caller, room } = await access(c, c.req.valid("param").id, "editor");
    const result = unwrap(await room.redo(caller));
    return c.json({ revision: result.revision, ops: result.ops, statuses: result.statuses });
  })
  .post("/:id/share", validate("param", IdParam), validate("json", z.object({ allowDownload: z.boolean().default(false) })), async (c) => {
    const id = c.req.valid("param").id;
    const { auth, acc, caller, room } = await access(c, id, "editor");
    const graph = orFail(await room.getGraph(caller));
    const share = await createShare(c.env, { project: acc.project, userId: auth.userId, allowDownload: c.req.valid("json").allowDownload, graph });
    return c.json(share, 201);
  })
  .delete("/:id/share", validate("param", IdParam), async (c) => {
    const id = c.req.valid("param").id;
    await access(c, id, "editor");
    const revoked = await revokeShares(c.env, id);
    return c.json({ ok: true, revoked });
  });

/** `/api/nodes/:id/...` — node versions. Node ids are unique per project; pass `projectId`. */
export const nodes = new Hono<AppEnv>()
  .get("/:id/versions", validate("param", IdParam), validate("query", z.object({ projectId: Id })), async (c) => {
    const { auth, acc, caller, room } = await access(c, c.req.valid("query").projectId);
    const result = unwrap(await room.listVersions(caller, c.req.valid("param").id));
    return c.json({ nodeId: c.req.valid("param").id, activeVersionId: result.activeVersionId, versions: await versionViews(c.env, auth, acc.matureAllowed, result.versions) });
  })
  .post("/:id/active", validate("param", IdParam), validate("json", z.object({ projectId: Id, versionId: Id })), async (c) => {
    const body = c.req.valid("json");
    const { auth, acc, caller, room } = await access(c, body.projectId, "editor");
    const result = unwrap(await room.setActiveVersion(caller, c.req.valid("param").id, body.versionId));
    const [version] = await versionViews(c.env, auth, acc.matureAllowed, [result.version]);
    return c.json({ version, statuses: result.statuses });
  });

async function versionViews<V extends { assetId: string | null; rating?: string | null }>(env: Env, _auth: AuthContext, mayViewMature: boolean, versions: V[]) {
  const ids = [...new Set(versions.map((v) => v.assetId).filter((x): x is string => !!x))];
  const rows = ids.length
    ? (
        await env.DB.prepare(`SELECT id, workspace_id, r2_key, kind, meta, mature FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<{ id: string; workspace_id: string | null; r2_key: string; kind: string; meta: string; mature: number }>()
      ).results
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    versions.map(async (v) => {
      const a = v.assetId ? byId.get(v.assetId) : undefined;
      let thumb: string | undefined;
      try {
        const m = a ? (JSON.parse(a.meta) as { thumbKey?: unknown }) : {};
        if (typeof m.thumbKey === "string") thumb = m.thumbKey;
      } catch {
        // No meta.
      }
      // D-005: the version's own rating counts even before the asset row is marked mature.
      const mature = a?.mature === 1 || v.rating === "suggestive" || v.rating === "explicit";
      const ref = (key: string | undefined) =>
        a && key ? mediaUrlFor(env, { key, workspaceId: a.workspace_id, mature }, { mayViewMature }) : Promise.resolve(null);
      return {
        ...v,
        mature,
        url: await ref(a?.r2_key),
        thumbUrl: await ref(thumb ?? (a?.kind === "image" ? a.r2_key : undefined)),
      };
    }),
  );
}

const CanvasParam = z.object({ id: z.string().regex(/^cnv_[A-Za-z0-9]+$/) });

function canvasProject(canvasId: string): string {
  const projectId = projectIdForCanvas(canvasId);
  if (!projectId) throw new ApiError(404, "NOT_FOUND", "Canvas not found");
  return projectId;
}

/** `/api/canvases/:id/timeline` — the editor's EDL (assembled from the graph on first open). */
export const canvases = new Hono<AppEnv>()
  .get("/:id/timeline", validate("param", CanvasParam), async (c) => {
    const canvasId = c.req.valid("param").id;
    const { caller, room } = await access(c, canvasProject(canvasId));
    return c.json(unwrap(await room.getTimeline(caller, canvasId)).timeline);
  })
  .post(
    "/:id/timeline/patch",
    validate("param", CanvasParam),
    validate("json", z.object({ baseRevision: z.number().int().nonnegative(), ops: z.array(z.unknown()).min(1).max(500) })),
    async (c) => {
      const canvasId = c.req.valid("param").id;
      const { caller, room } = await access(c, canvasProject(canvasId), "editor");
      const body = c.req.valid("json");
      const result = unwrap(await room.patchTimeline(caller, { canvasId, baseRevision: body.baseRevision, ops: body.ops }));
      return c.json({ ...result.timeline, ops: result.ops });
    },
  )
  .post("/:id/timeline/reassemble", validate("param", CanvasParam), async (c) => {
    const canvasId = c.req.valid("param").id;
    const { caller, room } = await access(c, canvasProject(canvasId), "editor");
    return c.json(unwrap(await room.reassembleTimeline(caller, canvasId)).timeline);
  });
