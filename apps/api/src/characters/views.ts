/**
 * Character responses (D-032): the list row, and the detail page (sheet,
 * locked descriptor, versions with their drift badge, outfit variants,
 * "used in" projects, recent checks, training availability).
 */
import { SHEET_VIEWS, summarizeDrift, trainingAvailability, type DriftSummary, type SheetAssets, type SheetView } from "@rolling/core/characters";
import type { AuthContext } from "../lib/access";
import { assetView, type AssetRow } from "../lib/mediaUrls";
import { loadCatalog } from "../models/catalog";
import { descriptorOf, outfitsOf, parseJsonSafe, sheetOf, versionsOf, type CharacterRow } from "./store";

export interface SheetPicture {
  view: SheetView;
  assetId: string;
  url: string | null;
  thumbUrl: string | null;
}

async function pictures(env: Env, auth: AuthContext, views: SheetAssets, rows: Map<string, AssetRow>): Promise<SheetPicture[]> {
  const out: SheetPicture[] = [];
  for (const view of SHEET_VIEWS) {
    const id = views[view];
    if (!id) continue;
    const row = rows.get(id);
    const v = row ? await assetView(env, row, { mayViewMature: auth.matureAllowed }) : null;
    out.push({ view, assetId: id, url: v?.url ?? null, thumbUrl: v?.thumbUrl ?? null });
  }
  return out;
}

async function assetRows(env: Env, workspaceId: string, ids: readonly string[]): Promise<Map<string, AssetRow>> {
  const uniq = [...new Set(ids)].filter(Boolean).slice(0, 90);
  if (uniq.length === 0) return new Map();
  const rows = (await env.DB.prepare(`SELECT * FROM assets WHERE id IN (${uniq.map(() => "?").join(",")}) AND workspace_id = ?`).bind(...uniq, workspaceId).all<AssetRow>()).results;
  return new Map(rows.map((r) => [r.id, r]));
}

async function driftByVersion(env: Env, characterId: string): Promise<Map<number, DriftSummary>> {
  const rows = (await env.DB.prepare("SELECT version, score, verdict FROM character_checks WHERE character_id = ? AND verdict != 'error' ORDER BY created_at DESC LIMIT 500").bind(characterId).all<{ version: number; score: number | null; verdict: string }>()).results;
  const by = new Map<number, (number | null)[]>();
  for (const r of rows) by.set(r.version, [...(by.get(r.version) ?? []), r.score]);
  return new Map([...by].map(([v, scores]) => [v, summarizeDrift(scores)]));
}

/** List row: what the Assets page and pickers show. */
export async function characterListView(env: Env, auth: AuthContext, r: CharacterRow) {
  const views = sheetOf(r);
  const rows = await assetRows(env, r.workspace_id, [r.cover_asset_id ?? "", ...Object.values(views)]);
  const cover = r.cover_asset_id ? rows.get(r.cover_asset_id) : undefined;
  const coverUrl = cover ? (await assetView(env, cover, { mayViewMature: auth.matureAllowed })).thumbUrl : null;
  const versions = versionsOf(r);
  const drift = (await driftByVersion(env, r.id)).get(versions.at(-1)?.n ?? 1) ?? null;
  const uses = await env.DB.prepare("SELECT COUNT(*) AS n FROM character_uses WHERE character_id = ?").bind(r.id).first<{ n: number }>();
  return {
    id: r.id,
    name: r.name,
    kind: r.kind ?? "person",
    meta: parseJsonSafe<Record<string, unknown>>(r.meta, {}),
    coverAssetId: r.cover_asset_id,
    coverUrl,
    versions,
    descriptor: descriptorOf(r),
    descriptorVersion: r.descriptor_version ?? 1,
    sheet: await pictures(env, auth, views, rows),
    outfits: outfitsOf(r).map((o) => ({ id: o.id, name: o.name })),
    realFace: r.real_face === 1,
    drift,
    projects: uses?.n ?? 0,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

/** Detail page. */
export async function characterDetailView(env: Env, auth: AuthContext, r: CharacterRow) {
  const versions = versionsOf(r);
  const outfits = outfitsOf(r);
  const ids = [r.cover_asset_id ?? "", ...Object.values(sheetOf(r)), ...versions.flatMap((v) => Object.values(v.views ?? {})), ...outfits.flatMap((o) => Object.values(o.views))];
  const checks = (
    await env.DB.prepare("SELECT id, version, asset_id, project_id, score, verdict, faces, created_at FROM character_checks WHERE character_id = ? ORDER BY created_at DESC LIMIT 20").bind(r.id).all<{
      id: string;
      version: number;
      asset_id: string;
      project_id: string | null;
      score: number | null;
      verdict: string;
      faces: number;
      created_at: number;
    }>()
  ).results;
  const rows = await assetRows(env, r.workspace_id, [...ids, ...checks.map((c) => c.asset_id)]);
  const drift = await driftByVersion(env, r.id);
  const used = (
    await env.DB.prepare(
      "SELECT u.project_id, u.uses, u.last_used_at, p.title FROM character_uses u JOIN projects p ON p.id = u.project_id WHERE u.character_id = ? AND p.workspace_id = ? ORDER BY u.last_used_at DESC LIMIT 50",
    )
      .bind(r.id, r.workspace_id)
      .all<{ project_id: string; uses: number; last_used_at: number; title: string }>()
  ).results;
  let training: { available: boolean; appliesLoras: string[] } = { available: false, appliesLoras: [] };
  try {
    const t = trainingAvailability((await loadCatalog(env)).models);
    training = { available: t.available, appliesLoras: t.appliesLoras };
  } catch {
    // Catalog unavailable: training stays off.
  }
  const base = await characterListView(env, auth, r);
  return {
    ...base,
    versions: await Promise.all(
      [...versions].reverse().map(async (v) => ({
        n: v.n,
        descriptorVersion: v.descriptorVersion ?? 1,
        descriptor: v.descriptor ?? null,
        createdAt: v.createdAt,
        current: v.n === versions.at(-1)?.n,
        views: await pictures(env, auth, v.views ?? Object.fromEntries((v.assetIds ?? []).map((id, i) => [i === 0 ? "full_body" : "front", id])), rows),
        drift: drift.get(v.n) ?? summarizeDrift([]),
      })),
    ),
    outfits: await Promise.all(outfits.map(async (o) => ({ id: o.id, name: o.name, outfit: o.outfit, createdAt: o.createdAt, views: await pictures(env, auth, o.views, rows) }))),
    usedIn: used.map((u) => ({ projectId: u.project_id, title: u.title, uses: u.uses, lastUsedAt: u.last_used_at })),
    checks: await Promise.all(
      checks.map(async (c) => {
        const row = rows.get(c.asset_id);
        const v = row ? await assetView(env, row, { mayViewMature: auth.matureAllowed }) : null;
        return { id: c.id, version: c.version, assetId: c.asset_id, projectId: c.project_id, score: c.score, verdict: c.verdict, faces: c.faces, createdAt: c.created_at, thumbUrl: v?.thumbUrl ?? null };
      }),
    ),
    training,
  };
}
