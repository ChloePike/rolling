/**
 * Read-only share links (M3). A share is a JSON snapshot of the graph in R2
 * (`shares/<shareId>.json`) plus a `share_links` row. Mature outputs are never
 * included (D-005): nodes whose output, referenced asset or model is mature
 * are dropped with their edges, and mature asset ids are scrubbed from params.
 * The active version's content rating (ProjectRoom `node_versions.rating`)
 * counts too: `suggestive` / `explicit` versions are dropped even when the
 * D1 asset row is not (yet) marked mature.
 * The public route re-checks every asset at read time and signs fresh URLs.
 */
import type { GraphState } from "@rolling/core/graph";
import { newId } from "@rolling/core/ids";
import type { ProjectRow } from "./access";
import { assetMeta, mediaUrlFor, type AssetRow } from "./mediaUrls";

export const SHARE_URL_TTL_SECONDS = 3600;

interface ShareAsset {
  kind: string;
  r2Key: string;
  thumbKey: string | null;
  workspaceId: string | null;
}

export interface ShareDoc {
  v: 1;
  shareId: string;
  projectId: string;
  title: string;
  revision: number;
  createdAt: number;
  nodes: Array<{
    id: string;
    kind: string;
    title: string;
    params: Record<string, unknown>;
    position: { x: number; y: number };
    groupId: string | null;
    assetId: string | null;
  }>;
  edges: GraphState["edges"];
  groups: GraphState["groups"];
  assets: Record<string, ShareAsset>;
}

function snapshotKey(shareId: string): string {
  return `shares/${shareId}.json`;
}

function scrub(value: unknown, banned: ReadonlySet<string>): unknown {
  if (typeof value === "string") return banned.has(value) ? null : value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, banned)).filter((v) => v !== null);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = scrub(v, banned);
      if (s !== null) out[k] = s;
    }
    return out;
  }
  return value;
}

async function loadAssets(env: Env, ids: string[]): Promise<Map<string, AssetRow>> {
  if (!ids.length) return new Map();
  const rows: AssetRow[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await env.DB.prepare(`SELECT * FROM assets WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<AssetRow>();
    rows.push(...res.results);
  }
  return new Map(rows.map((r) => [r.id, r]));
}

function referencedAssetIds(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^ast_[A-Za-z0-9]+$/.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(params);
  return out;
}

/** Builds the share document from a graph; pure apart from the D1 lookups. */
export async function buildShareDoc(
  env: Env,
  input: { shareId: string; project: ProjectRow; graph: { state: GraphState; assets: Record<string, string>; ratings?: Record<string, string> } },
): Promise<ShareDoc> {
  const { state, assets: activeAssets } = input.graph;
  const ratings = input.graph.ratings ?? {};
  const referenced = new Set<string>(Object.values(activeAssets));
  for (const n of state.nodes) for (const id of referencedAssetIds(n.params)) referenced.add(id);
  const rows = await loadAssets(env, [...referenced]);
  const models = [...new Set(state.nodes.map((n) => n.params.model).filter((m): m is string => typeof m === "string"))];
  const matureModels = new Set<string>();
  if (models.length) {
    const res = await env.DB.prepare(`SELECT id FROM models WHERE mature = 1 AND id IN (${models.map(() => "?").join(",")})`).bind(...models).all<{ id: string }>();
    for (const r of res.results) matureModels.add(r.id);
  }
  const matureAssets = new Set([...rows.values()].filter((r) => r.mature === 1).map((r) => r.id));
  // Assets of another workspace (or unknown) never leave through a share.
  for (const id of referenced) {
    const r = rows.get(id);
    if (!r || (r.workspace_id !== null && r.workspace_id !== input.project.workspace_id)) matureAssets.add(id);
  }

  const dropped = new Set<string>();
  for (const n of state.nodes) {
    const own = activeAssets[n.id];
    const isMature =
      n.params.mature === true ||
      ratings[n.id] === "suggestive" ||
      ratings[n.id] === "explicit" ||
      (typeof n.params.model === "string" && matureModels.has(n.params.model)) ||
      (own !== undefined && matureAssets.has(own)) ||
      (n.kind === "asset" && referencedAssetIds(n.params).some((id) => matureAssets.has(id)));
    if (isMature) dropped.add(n.id);
  }

  const nodes = state.nodes
    .filter((n) => !dropped.has(n.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      params: scrub(n.params, matureAssets) as Record<string, unknown>,
      position: n.position,
      groupId: n.groupId,
      assetId: activeAssets[n.id] ?? (n.kind === "asset" && typeof n.params.assetId === "string" && !matureAssets.has(n.params.assetId) ? n.params.assetId : null),
    }));
  const assets: Record<string, ShareAsset> = {};
  for (const n of nodes) {
    const r = n.assetId ? rows.get(n.assetId) : undefined;
    if (!r || matureAssets.has(r.id)) {
      n.assetId = null;
      continue;
    }
    const meta = assetMeta(r);
    assets[r.id] = { kind: r.kind, r2Key: r.r2_key, thumbKey: typeof meta.thumbKey === "string" ? meta.thumbKey : null, workspaceId: r.workspace_id };
  }
  return {
    v: 1,
    shareId: input.shareId,
    projectId: input.project.id,
    title: input.project.title,
    revision: state.revision,
    createdAt: Date.now(),
    nodes,
    edges: state.edges.filter((e) => !dropped.has(e.from.node) && !dropped.has(e.to.node)),
    groups: state.groups.map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => !dropped.has(id)) })).filter((g) => g.nodeIds.length > 0),
    assets,
  };
}

export interface ShareInfo {
  shareId: string;
  url: string;
  apiUrl: string;
  allowDownload: boolean;
  createdAt: number;
}

function shareInfo(env: Env, id: string, allowDownload: boolean, createdAt: number): ShareInfo {
  return { shareId: id, url: `${env.PUBLIC_APP_URL.replace(/\/+$/, "")}/share/${id}`, apiUrl: `/api/share/${id}`, allowDownload, createdAt };
}

/** Creates the share link, or refreshes the snapshot of the project's active link (same id). */
export async function createShare(
  env: Env,
  input: { project: ProjectRow; userId: string; allowDownload: boolean; graph: { state: GraphState; assets: Record<string, string>; ratings?: Record<string, string> } },
): Promise<ShareInfo> {
  const existing = await env.DB.prepare("SELECT id FROM share_links WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(input.project.id)
    .first<{ id: string }>();
  const shareId = existing?.id ?? newId("share");
  const doc = await buildShareDoc(env, { shareId, project: input.project, graph: input.graph });
  await env.MEDIA.put(snapshotKey(shareId), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  if (existing) {
    await env.DB.prepare("UPDATE share_links SET allow_download = ?, created_at = ? WHERE id = ?").bind(input.allowDownload ? 1 : 0, doc.createdAt, shareId).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO share_links (id, project_id, snapshot_key, allow_download, revoked_at, workspace_id, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
    )
      .bind(shareId, input.project.id, snapshotKey(shareId), input.allowDownload ? 1 : 0, input.project.workspace_id, input.userId, doc.createdAt)
      .run();
  }
  return shareInfo(env, shareId, input.allowDownload, doc.createdAt);
}

export async function revokeShares(env: Env, projectId: string): Promise<number> {
  const rows = await env.DB.prepare("SELECT id, snapshot_key FROM share_links WHERE project_id = ? AND revoked_at IS NULL").bind(projectId).all<{ id: string; snapshot_key: string }>();
  if (!rows.results.length) return 0;
  await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").bind(Date.now(), projectId).run();
  await env.MEDIA.delete(rows.results.map((r) => r.snapshot_key));
  return rows.results.length;
}

/** Public, signed-out view of a share: fresh signed URLs, mature re-checked now. Null when missing or revoked. */
export async function readShare(env: Env, shareId: string) {
  const link = await env.DB.prepare("SELECT * FROM share_links WHERE id = ? AND revoked_at IS NULL")
    .bind(shareId)
    .first<{ id: string; project_id: string; snapshot_key: string; allow_download: number }>();
  if (!link) return null;
  const obj = await env.MEDIA.get(link.snapshot_key);
  if (!obj) return null;
  const doc = (await obj.json()) as ShareDoc;
  const rows = await loadAssets(env, Object.keys(doc.assets));
  const viewer = { mayViewMature: false };
  const media: Record<string, { kind: string; url: string | null; thumbUrl: string | null }> = {};
  for (const [id, a] of Object.entries(doc.assets)) {
    const row = rows.get(id);
    if (!row || row.mature === 1) continue; // deleted or marked mature since sharing
    const ref = (key: string | null) => (key ? mediaUrlFor(env, { key, workspaceId: a.workspaceId, mature: false }, viewer, SHARE_URL_TTL_SECONDS) : Promise.resolve(null));
    media[id] = { kind: a.kind, url: await ref(a.r2Key), thumbUrl: await ref(a.thumbKey ?? (a.kind === "image" ? a.r2Key : null)) };
  }
  return {
    shareId: doc.shareId,
    title: doc.title,
    revision: doc.revision,
    createdAt: doc.createdAt,
    allowDownload: link.allow_download === 1,
    nodes: doc.nodes.map((n) => {
      const m = n.assetId ? media[n.assetId] : undefined;
      return {
        id: n.id,
        kind: n.kind,
        title: n.title,
        params: n.params,
        position: n.position,
        groupId: n.groupId,
        media: m ? { kind: m.kind, url: m.url, thumbUrl: m.thumbUrl, downloadUrl: link.allow_download === 1 ? m.url : null } : null,
      };
    }),
    edges: doc.edges,
    groups: doc.groups,
  };
}
