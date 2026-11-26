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
import { assetMeta, mediaUrlFor, reviewPending, type AssetRow } from "./mediaUrls";

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
  // Review-pending clips (unrated, D-005) never leave through a share: treated as mature here.
  return new Map(rows.map((r) => [r.id, reviewPending(r) ? { ...r, mature: 1 } : r]));
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

export type ShareAudience = "link" | "workspace";

export interface ShareSettings {
  /** `link`: anyone with the link; `workspace`: signed-in members of the project's workspace. */
  audience: ShareAudience;
  allowDownload: boolean;
  /** Prompts stay in the snapshot (and the public read) only when true. */
  showPrompt: boolean;
  /** "Publish to profile": the cover appears on the author's public profile (only when public-safe, D-005). */
  showOnProfile: boolean;
}

export const DEFAULT_SHARE_SETTINGS: ShareSettings = { audience: "link", allowDownload: false, showPrompt: true, showOnProfile: false };

export interface ShareInfo extends ShareSettings {
  shareId: string;
  url: string;
  apiUrl: string;
  createdAt: number;
}

/** `GET /api/projects/:id/share`. */
export interface ShareState extends ShareSettings {
  enabled: boolean;
  shareId: string | null;
  url: string | null;
  /** When the snapshot was last written (epoch ms), null without a link. */
  snapshotAt: number | null;
  /** No active link, but one existed and was stopped (the old URL no longer opens); false when never shared. */
  revoked: boolean;
}

interface LinkRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  snapshot_key: string;
  allow_download: number;
  show_on_profile: number;
  show_prompt: number;
  audience: ShareAudience;
  created_at: number;
}

function shareUrl(env: Env, id: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/+$/, "")}/share/${id}`;
}

function settingsOf(row: LinkRow): ShareSettings {
  return { audience: row.audience === "workspace" ? "workspace" : "link", allowDownload: row.allow_download === 1, showPrompt: row.show_prompt === 1, showOnProfile: row.show_on_profile === 1 };
}

function shareInfo(env: Env, id: string, settings: ShareSettings, createdAt: number): ShareInfo {
  return { shareId: id, url: shareUrl(env, id), apiUrl: `/api/share/${id}`, ...settings, createdAt };
}

async function activeLink(env: Env, projectId: string): Promise<LinkRow | null> {
  return env.DB.prepare("SELECT * FROM share_links WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(projectId).first<LinkRow>();
}

/** Profile cover of a share: the first video in the snapshot, else the first image (the profile re-checks its rating). */
export function shareCover(doc: ShareDoc): string | null {
  const withAsset = doc.nodes.filter((n) => n.assetId && doc.assets[n.assetId]);
  const pick = withAsset.find((n) => doc.assets[n.assetId!]!.kind === "video") ?? withAsset.find((n) => doc.assets[n.assetId!]!.kind === "image");
  return pick?.assetId ?? null;
}

const PROMPT_KEY = /prompt/i;

/** Drops prompt fields (`prompt`, `negativePrompt`, ...) from node params, at any depth. */
export function stripPrompts(params: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!PROMPT_KEY.test(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(params) as Record<string, unknown>;
}

/**
 * Creates the share link, or refreshes the snapshot of the project's active
 * link (same id). Settings not given keep the link's current values (defaults
 * for a new link). Prompts are left out of the snapshot unless `showPrompt`.
 */
export async function createShare(
  env: Env,
  input: { project: ProjectRow; userId: string; settings: Partial<ShareSettings>; graph: { state: GraphState; assets: Record<string, string>; ratings?: Record<string, string> } },
): Promise<ShareInfo> {
  const existing = await activeLink(env, input.project.id);
  const shareId = existing?.id ?? newId("share");
  const settings: ShareSettings = { ...(existing ? settingsOf(existing) : DEFAULT_SHARE_SETTINGS), ...input.settings };
  const doc = await buildShareDoc(env, { shareId, project: input.project, graph: input.graph });
  if (!settings.showPrompt) for (const n of doc.nodes) n.params = stripPrompts(n.params);
  await env.MEDIA.put(snapshotKey(shareId), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  const cover = shareCover(doc);
  const flags = [settings.allowDownload ? 1 : 0, settings.showOnProfile ? 1 : 0, settings.showPrompt ? 1 : 0, settings.audience, cover] as const;
  if (existing) {
    // Re-sharing publishes as the person sharing now.
    await env.DB.prepare("UPDATE share_links SET allow_download = ?, show_on_profile = ?, show_prompt = ?, audience = ?, cover_asset_id = ?, created_by = ?, created_at = ? WHERE id = ?")
      .bind(...flags, input.userId, doc.createdAt, shareId)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO share_links (id, project_id, snapshot_key, revoked_at, workspace_id, created_by, created_at, allow_download, show_on_profile, show_prompt, audience, cover_asset_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(shareId, input.project.id, snapshotKey(shareId), input.project.workspace_id, input.userId, doc.createdAt, ...flags)
      .run();
  }
  return shareInfo(env, shareId, settings, doc.createdAt);
}

/** The project's share state (`enabled: false` with default settings when there is no active link). */
export async function shareState(env: Env, projectId: string): Promise<ShareState> {
  const link = await activeLink(env, projectId);
  if (!link) {
    const stopped = await env.DB.prepare("SELECT 1 AS x FROM share_links WHERE project_id = ? AND revoked_at IS NOT NULL LIMIT 1").bind(projectId).first();
    return { enabled: false, shareId: null, url: null, snapshotAt: null, revoked: stopped !== null, ...DEFAULT_SHARE_SETTINGS };
  }
  return { enabled: true, shareId: link.id, url: shareUrl(env, link.id), snapshotAt: link.created_at, revoked: false, ...settingsOf(link) };
}

/**
 * Changes settings of the active link without re-publishing the snapshot.
 * Turning `showPrompt` on only affects the next publish (prompts were left out
 * of the current snapshot); turning it off hides them at once. Null when the
 * project has no active link.
 */
export async function updateShareSettings(env: Env, projectId: string, userId: string, patch: Partial<ShareSettings>): Promise<ShareState | null> {
  const link = await activeLink(env, projectId);
  if (!link) return null;
  const next = { ...settingsOf(link), ...patch };
  await env.DB.prepare("UPDATE share_links SET allow_download = ?, show_on_profile = ?, show_prompt = ?, audience = ?, created_by = CASE WHEN ? THEN ? ELSE created_by END WHERE id = ?")
    .bind(next.allowDownload ? 1 : 0, next.showOnProfile ? 1 : 0, next.showPrompt ? 1 : 0, next.audience, patch.showOnProfile === true ? 1 : 0, userId, link.id)
    .run();
  return { enabled: true, shareId: link.id, url: shareUrl(env, link.id), snapshotAt: link.created_at, revoked: false, ...next };
}

export async function revokeShares(env: Env, projectId: string): Promise<number> {
  const rows = await env.DB.prepare("SELECT id, snapshot_key FROM share_links WHERE project_id = ? AND revoked_at IS NULL").bind(projectId).all<{ id: string; snapshot_key: string }>();
  if (!rows.results.length) return 0;
  await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").bind(Date.now(), projectId).run();
  await env.MEDIA.delete(rows.results.map((r) => r.snapshot_key));
  return rows.results.length;
}

/** Public, signed-out view of a share: fresh signed URLs, mature re-checked now. Null when missing or revoked. */
export async function readShare(env: Env, shareId: string, viewer: { memberOf: (workspaceId: string) => boolean } | null = null) {
  const link = await env.DB.prepare("SELECT * FROM share_links WHERE id = ? AND revoked_at IS NULL").bind(shareId).first<LinkRow>();
  if (!link) return null;
  // `workspace` links open only for signed-in members of the project's workspace (others get 404).
  if (link.audience === "workspace" && (!viewer || !link.workspace_id || !viewer.memberOf(link.workspace_id))) return null;
  const obj = await env.MEDIA.get(link.snapshot_key);
  if (!obj) return null;
  const doc = (await obj.json()) as ShareDoc;
  const rows = await loadAssets(env, Object.keys(doc.assets));
  const publicViewer = { mayViewMature: false };
  const media: Record<string, { kind: string; url: string | null; thumbUrl: string | null }> = {};
  for (const [id, a] of Object.entries(doc.assets)) {
    const row = rows.get(id);
    if (!row || row.mature === 1) continue; // deleted or marked mature since sharing
    const ref = (key: string | null) => (key ? mediaUrlFor(env, { key, workspaceId: a.workspaceId, mature: false }, publicViewer, SHARE_URL_TTL_SECONDS) : Promise.resolve(null));
    media[id] = { kind: a.kind, url: await ref(a.r2Key), thumbUrl: await ref(a.thumbKey ?? (a.kind === "image" ? a.r2Key : null)) };
  }
  return {
    shareId: doc.shareId,
    title: doc.title,
    revision: doc.revision,
    createdAt: doc.createdAt,
    allowDownload: link.allow_download === 1,
    audience: link.audience,
    showPrompt: link.show_prompt === 1,
    nodes: doc.nodes.map((n) => {
      const m = n.assetId ? media[n.assetId] : undefined;
      return {
        id: n.id,
        kind: n.kind,
        title: n.title,
        params: link.show_prompt === 1 ? n.params : stripPrompts(n.params),
        position: n.position,
        groupId: n.groupId,
        media: m ? { kind: m.kind, url: m.url, thumbUrl: m.thumbUrl, downloadUrl: link.allow_download === 1 ? m.url : null } : null,
      };
    }),
    edges: doc.edges,
    groups: doc.groups,
  };
}
