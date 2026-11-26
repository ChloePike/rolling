/**
 * Templates (docs/api.md → Templates): built-in templates (D1 seed, workspace
 * NULL) and workspace-private ones saved from a canvas selection. A template
 * is a canvas graph plus slots; `POST /api/projects { fromTemplateId, slots }`
 * (routes/projects.ts) instantiates it without spending anything.
 */
import { Hono } from "hono";
import { z } from "zod";
import { inferSlots, selectionGraph, summarizeGraph, TEMPLATE_CATEGORIES, type TemplateGraph, type TemplateMeta, type TemplateSlot } from "@rolling/core/templates";
import { newId } from "@rolling/core/ids";
import { requireUser } from "../auth/context";
import type { AppEnv } from "../env";
import { projectAccess, projectRoom, requireAuth, requireEditor, roomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { isRoomError, roomFailure } from "../lib/room";
import { validate } from "../lib/validate";
import { signMediaUrl } from "../lib/mediaUrls";
import { publicMediaUrl } from "./media";

export interface TemplateRow {
  id: string;
  workspace_id: string | null;
  title: string;
  category: string | null;
  graph: string;
  slots: string;
  preview_asset_id: string | null;
  uses: number;
  description: string | null;
  meta: string;
  created_at: number;
  updated_at: number;
}

/** A row of `GET /api/templates`. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  /** `builtin` (everyone) or `workspace` (saved from a selection, workspace-private). */
  source: "builtin" | "workspace";
  durationSec: number;
  /** e.g. `9:16`. */
  ratio: string;
  /** CSS aspect-ratio of the cover, e.g. `9/16`. */
  coverAspect: string;
  roles: number;
  hasLines: boolean;
  tags: string[];
  featured: boolean;
  uses: number;
  nodeCount: number;
  skill: string | null;
  /** Cover picture URL (never a mature asset, D-005), null without a preview. */
  coverUrl: string | null;
  /**
   * Built-in covers (migration 0020): the poster in each format with its pixel size and
   * average color (the card's fill while it loads); null for templates without one.
   */
  cover: TemplateCover | null;
  /** Short muted looping preview (H.264 MP4) of video templates, null otherwise. */
  previewUrl: string | null;
  slots: TemplateSlot[];
  createdAt: number;
}

export interface TemplateCover {
  jpg: string;
  webp: string | null;
  avif: string | null;
  width: number;
  height: number;
  /** `#rrggbb`. */
  color: string | null;
}

/** Cover fields of a built-in's `meta` (migration 0020); keys live under `public/templates/<id>/`. */
export interface CoverMeta {
  coverKey?: unknown;
  coverWebpKey?: unknown;
  coverAvifKey?: unknown;
  previewKey?: unknown;
  coverWidth?: unknown;
  coverHeight?: unknown;
  coverColor?: unknown;
}

export interface TemplateDetail extends TemplateSummary {
  graph: TemplateGraph;
}

export function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** A key of this built-in's public cover folder, or undefined. */
function ownKey(row: TemplateRow, v: unknown): string | undefined {
  return !row.workspace_id && typeof v === "string" && v.startsWith(`public/templates/${row.id}/`) && !v.includes("..") ? v : undefined;
}

/** Built-in covers live on the public bucket (migrations 0017, 0020): public media URLs (D-008). */
export function builtinCover(env: Env, row: TemplateRow, meta: CoverMeta): { cover: TemplateCover | null; coverUrl: string | null; previewUrl: string | null } {
  const url = (k: string | undefined) => (k ? publicMediaUrl(k, env.PUBLIC_MEDIA_BASE_URL) : null);
  const jpg = ownKey(row, meta.coverKey);
  const preview = url(ownKey(row, meta.previewKey));
  const width = typeof meta.coverWidth === "number" ? meta.coverWidth : 0;
  const height = typeof meta.coverHeight === "number" ? meta.coverHeight : 0;
  if (!jpg) return { cover: null, coverUrl: null, previewUrl: preview };
  const webp = url(ownKey(row, meta.coverWebpKey));
  const cover =
    width > 0 && height > 0
      ? {
          jpg: url(jpg)!,
          webp,
          avif: url(ownKey(row, meta.coverAvifKey)),
          width,
          height,
          color: typeof meta.coverColor === "string" && /^#[0-9a-f]{6}$/i.test(meta.coverColor) ? meta.coverColor : null,
        }
      : null;
  return { cover, coverUrl: webp ?? url(jpg), previewUrl: preview };
}

async function previewAssetUrl(env: Env, row: TemplateRow): Promise<string | null> {
  if (!row.preview_asset_id) return null;
  const a = await env.DB.prepare("SELECT r2_key, workspace_id, mature, status FROM assets WHERE id = ?").bind(row.preview_asset_id).first<{
    r2_key: string;
    workspace_id: string | null;
    mature: number;
    status: string;
  }>();
  // Mature outputs are never template covers (D-005).
  if (!a || a.mature || a.status !== "ready") return null;
  return signMediaUrl(env, a.r2_key, { workspaceId: a.workspace_id ?? "_", expiresIn: 3600 });
}

export async function templateSummary(env: Env, row: TemplateRow): Promise<TemplateSummary> {
  const graph = parse<TemplateGraph>(row.graph, { nodes: [], edges: [], groups: [] });
  const meta: Partial<TemplateMeta> & CoverMeta = { ...summarizeGraph(graph), ...parse<Partial<TemplateMeta>>(row.meta, {}) };
  const ratio = meta.ratio ?? "16:9";
  const builtin = builtinCover(env, row, meta);
  return {
    id: row.id,
    name: row.title,
    description: row.description,
    category: row.category,
    source: row.workspace_id ? "workspace" : "builtin",
    durationSec: meta.durationSec ?? 0,
    ratio,
    // The stored poster size when there is one (no layout shift), else the template ratio.
    coverAspect: builtin.cover ? `${builtin.cover.width}/${builtin.cover.height}` : ratio.replace(":", "/"),
    roles: meta.roles ?? 0,
    hasLines: meta.hasLines ?? false,
    tags: meta.tags ?? [],
    featured: meta.featured === true,
    uses: row.uses,
    nodeCount: meta.nodeCount ?? graph.nodes.length,
    skill: meta.skill ?? null,
    coverUrl: builtin.coverUrl ?? (await previewAssetUrl(env, row)),
    cover: builtin.cover,
    previewUrl: builtin.previewUrl,
    slots: parse<TemplateSlot[]>(row.slots, inferSlots(graph)),
    createdAt: row.created_at,
  };
}

export const TemplatesQuery = z.object({
  category: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  first: z.coerce.number().int().min(1).max(100).default(60),
});

/** Built-in and workspace templates, most used first (workspace ones first among equals). */
export async function listTemplates(env: Env, workspaceId: string, query: z.infer<typeof TemplatesQuery>): Promise<{ items: TemplateSummary[]; featured: TemplateSummary[]; total: number }> {
  const where = ["(workspace_id IS NULL OR workspace_id = ?)"];
  const binds: unknown[] = [workspaceId];
  if (query.category) {
    where.push("category = ?");
    binds.push(query.category);
  }
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, " ")}%`;
    where.push("(title LIKE ? OR description LIKE ? OR category LIKE ?)");
    binds.push(like, like, like);
  }
  const rows = (
    await env.DB.prepare(`SELECT * FROM templates WHERE ${where.join(" AND ")} ORDER BY uses DESC, workspace_id IS NULL, created_at DESC, id LIMIT ?`)
      .bind(...binds, query.first)
      .all<TemplateRow>()
  ).results;
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM templates WHERE ${where.join(" AND ")}`)
    .bind(...binds)
    .first<{ n: number }>();
  const items = await Promise.all(rows.map((r) => templateSummary(env, r)));
  return { items, featured: items.filter((t) => t.featured), total: total?.n ?? items.length };
}

export async function getTemplateRow(env: Env, workspaceId: string, id: string): Promise<TemplateRow | null> {
  return env.DB.prepare("SELECT * FROM templates WHERE id = ? AND (workspace_id IS NULL OR workspace_id = ?)").bind(id, workspaceId).first<TemplateRow>();
}

export async function templateDetail(env: Env, row: TemplateRow): Promise<TemplateDetail> {
  return { ...(await templateSummary(env, row)), graph: parse<TemplateGraph>(row.graph, { nodes: [], edges: [], groups: [] }) };
}

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

const SaveBody = z.object({
  projectId: Id,
  nodeIds: z.array(Id).min(1).max(200),
  title: z.string().trim().min(1).max(120),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  description: z.string().max(500).optional(),
});

export const templates = new Hono<AppEnv>()
  .get("/", validate("query", TemplatesQuery), async (c) => {
    const auth = requireUser(c);
    return c.json(await listTemplates(c.env, auth.workspaceId, c.req.valid("query")));
  })
  .get("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = requireUser(c);
    const row = await getTemplateRow(c.env, auth.workspaceId, c.req.valid("param").id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Template not found");
    return c.json({ template: await templateDetail(c.env, row) });
  })
  // "Save selection as template": the selected nodes of a canvas become a workspace-private template.
  .post("/", validate("json", SaveBody), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    const body = c.req.valid("json");
    const access = await projectAccess(c, auth, body.projectId, "editor");
    const graph = await projectRoom(c.env, body.projectId).getGraph(roomCaller(auth, access));
    if (isRoomError(graph)) roomFailure(graph);
    const missing = body.nodeIds.filter((id) => !graph.state.nodes.some((n) => n.id === id));
    if (missing.length) throw new ApiError(404, "NOT_FOUND", "Node not found", { nodeIds: missing });
    const g = selectionGraph(graph.state, body.nodeIds);
    const slots = inferSlots(g);
    const meta = summarizeGraph(g);
    const id = newId("template");
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO templates (id, workspace_id, title, category, graph, slots, preview_asset_id, uses, description, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)",
    )
      .bind(id, access.project.workspace_id, body.title, body.category ?? null, JSON.stringify(g), JSON.stringify(slots), body.description ?? null, JSON.stringify(meta), now, now)
      .run();
    const row = await getTemplateRow(c.env, access.project.workspace_id, id);
    return c.json({ template: await templateDetail(c.env, row!) }, 201);
  })
  .delete("/:id", validate("param", z.object({ id: Id })), async (c) => {
    const auth = await requireAuth(c);
    requireEditor(auth);
    const id = c.req.valid("param").id;
    const r = await c.env.DB.prepare("DELETE FROM templates WHERE id = ? AND workspace_id = ?").bind(id, auth.workspaceId).run();
    // Built-in templates and other workspaces' templates are not deletable here.
    if (!r.meta.changes) throw new ApiError(404, "NOT_FOUND", "Template not found");
    return c.json({ ok: true });
  });
