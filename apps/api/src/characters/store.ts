/**
 * Characters (D-032), Worker side: rows, the locked descriptor and versions,
 * outfit variants, the sheet-picture index, and saving a sheet run.
 *
 * A character's descriptor is locked: a sheet run in `version` mode makes a
 * new version (descriptor version + 1), an `outfit` run adds an outfit
 * variant, and nothing edits either in place. D-005: a sheet drawn from an
 * uploaded photo that shows (or may show) a real face is marked `real_face`;
 * its pictures are then treated as uploads, never as platform assets, so the
 * real-person rules apply to every run that uses them.
 */
import { CharacterDescriptorSchema, OUTFIT_VIEWS, sheetViews, type CharacterDescriptor, type SheetAssets, type SheetView } from "@rolling/core/characters";
import type { CharacterSheetSpec, PromptSpec } from "@rolling/core/generation";
import { ApiError } from "../lib/errors";

export interface CharacterRow {
  id: string;
  workspace_id: string;
  name: string;
  meta: string | null;
  cover_asset_id: string | null;
  versions: string;
  created_at: number;
  created_by: string | null;
  kind: string | null;
  descriptor: string | null;
  descriptor_version: number | null;
  sheet: string | null;
  outfits: string | null;
  real_face: number | null;
  ref_face_key: string | null;
  updated_at: number | null;
}

/** One version of a character. Older rows have only `n`, `assetIds` and `createdAt`. */
export interface CharacterVersion {
  n: number;
  assetIds: string[];
  createdAt: number;
  descriptorVersion?: number;
  descriptor?: CharacterDescriptor;
  views?: SheetAssets;
  /** Runs that made this version (a retry completes the same version). */
  runIds?: string[];
}

export interface StoredOutfit {
  id: string;
  name: string;
  outfit: string;
  views: SheetAssets;
  runIds: string[];
  createdAt: number;
}

export function parseJsonSafe<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function descriptorOf(row: Pick<CharacterRow, "descriptor" | "kind">): CharacterDescriptor | null {
  const raw = parseJsonSafe<unknown>(row.descriptor, null);
  if (!raw) return null;
  const parsed = CharacterDescriptorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function versionsOf(row: Pick<CharacterRow, "versions">): CharacterVersion[] {
  return parseJsonSafe<CharacterVersion[]>(row.versions, []).filter((v) => typeof v?.n === "number");
}

export function outfitsOf(row: Pick<CharacterRow, "outfits">): StoredOutfit[] {
  return parseJsonSafe<StoredOutfit[]>(row.outfits, []).filter((o) => typeof o?.id === "string");
}

export function sheetOf(row: Pick<CharacterRow, "sheet">): SheetAssets {
  return parseJsonSafe<SheetAssets>(row.sheet, {});
}

export async function getCharacter(env: Env, workspaceId: string, id: string): Promise<CharacterRow | null> {
  return env.DB.prepare("SELECT * FROM characters WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<CharacterRow>();
}

/**
 * Quote time: a `version` or `outfit` sheet request names a saved character.
 * The server fills what the client may not choose: the locked descriptor for
 * an outfit (only the outfit changes), the kind, and the base picture (the
 * current full body for an outfit, the current front view for a version).
 */
export async function resolveSheetSpec(env: Env, workspaceId: string, spec: PromptSpec): Promise<PromptSpec> {
  const sheet = spec.kind === "character" ? spec.sheet : undefined;
  if (!sheet || sheet.mode === "new") return sheet ? { ...spec, sheet: { ...sheet, baseAssetId: undefined } as CharacterSheetSpec } : spec;
  if (!sheet.characterId) throw new ApiError(400, "VALIDATION_FAILED", "Choose the character first", { field: "sheet.characterId" });
  const row = await getCharacter(env, workspaceId, sheet.characterId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Character not found", { characterId: sheet.characterId });
  const locked = descriptorOf(row);
  const views = sheetOf(row);
  const kind = (row.kind ?? "person") as CharacterDescriptor["kind"];
  const base = sheet.mode === "outfit" ? (views.full_body ?? row.cover_asset_id) : (views.front ?? views.full_body ?? row.cover_asset_id);
  if (!base) throw new ApiError(409, "CONFLICT", "This character has no sheet yet", { characterId: row.id, reason: "NO_SHEET" });
  const descriptor: CharacterDescriptor =
    sheet.mode === "outfit" ? (locked ?? { ...sheet.descriptor, kind }) : { ...sheet.descriptor, kind };
  return { ...spec, name: row.name, sheet: { ...sheet, descriptor, baseAssetId: base } };
}

/**
 * D-005: true when any picture the sheet was drawn from is an upload that
 * shows a face, or one whose face detection did not run (fail safe), or a
 * picture of another real-face character.
 */
export async function realFaceInputs(env: Env, workspaceId: string, assetIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(assetIds)].filter(Boolean);
  if (ids.length === 0) return false;
  const marks = ids.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(`SELECT id, kind, source, meta FROM assets WHERE id IN (${marks}) AND (workspace_id = ? OR workspace_id IS NULL)`).bind(...ids, workspaceId).all<{ id: string; kind: string; source: string; meta: string | null }>()
  ).results;
  for (const r of rows) {
    if (r.kind !== "image") continue;
    const meta = parseJsonSafe<{ faces?: { status?: string; count?: number }; characterSheet?: { realFace?: boolean } }>(r.meta, {});
    if (meta.characterSheet?.realFace) return true;
    if (r.source === "generated" || r.source === "public" || r.source === "builtin") continue;
    if (!(meta.faces?.status === "done" && meta.faces.count === 0)) return true;
  }
  const sheet = (
    await env.DB.prepare(`SELECT 1 AS hit FROM character_sheet_assets s JOIN characters c ON c.id = s.character_id WHERE s.asset_id IN (${marks}) AND c.real_face = 1 LIMIT 1`).bind(...ids).first<{ hit: number }>()
  );
  return !!sheet;
}

/** Sheet pictures among `assetIds`, with their character. */
export interface SheetLink {
  assetId: string;
  characterId: string;
  version: number;
  view: SheetView;
  outfitId: string | null;
  name: string;
  kind: string;
  realFace: boolean;
}

export async function sheetLinks(env: Env, workspaceId: string, assetIds: readonly string[]): Promise<SheetLink[]> {
  const ids = [...new Set(assetIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = (
    await env.DB.prepare(
      `SELECT s.asset_id, s.character_id, s.version, s.view, s.outfit_id, c.name, c.kind, c.real_face FROM character_sheet_assets s JOIN characters c ON c.id = s.character_id
       WHERE s.asset_id IN (${ids.map(() => "?").join(",")}) AND s.workspace_id = ?`,
    )
      .bind(...ids, workspaceId)
      .all<{ asset_id: string; character_id: string; version: number; view: string; outfit_id: string | null; name: string; kind: string | null; real_face: number | null }>()
  ).results;
  return rows.map((r) => ({ assetId: r.asset_id, characterId: r.character_id, version: r.version, view: r.view as SheetView, outfitId: r.outfit_id, name: r.name, kind: r.kind ?? "person", realFace: r.real_face === 1 }));
}

/** Asset ids of every real-face character's pictures among `assetIds` (D-005: they count as uploads). */
export async function realFaceAssets(env: Env, workspaceId: string, assetIds: readonly string[]): Promise<Set<string>> {
  return new Set((await sheetLinks(env, workspaceId, assetIds)).filter((l) => l.realFace).map((l) => l.assetId));
}

export interface SheetRunResult {
  characterId: string;
  version: number;
  outfitId: string | null;
}

/**
 * Saves the pictures of a finished sheet run (`byRef`: item ref = view →
 * asset id, earlier runs' pictures included on a retry).
 * - `new`: a character with version 1 (a retry completes the same version).
 * - `version`: version n + 1 with the new descriptor; the sheet moves to it.
 * - `outfit`: an outfit variant (its body views).
 */
export async function saveSheetRun(
  env: Env,
  run: { id: string; workspace_id: string; created_by: string },
  spec: PromptSpec,
  byRef: Record<string, string>,
  opts: { retryChain: readonly string[]; existingId: string | null; newId: string },
): Promise<SheetRunResult | null> {
  const sheet = spec.sheet!;
  const views = (sheet.mode === "outfit" ? OUTFIT_VIEWS : sheetViews(sheet.descriptor.kind, sheet.expressions)).filter((v) => !!byRef[v]);
  if (views.length === 0) return null;
  const assets: SheetAssets = Object.fromEntries(views.map((v) => [v, byRef[v]!]));
  const refs = [...(spec.inputs.referenceAssetIds ?? []), ...(spec.inputs.inputAssetIds ?? []), ...(sheet.baseAssetId ? [sheet.baseAssetId] : [])];
  const now = Date.now();
  const runIds = [...new Set([...opts.retryChain, run.id])];
  const touches = (ids: readonly string[] | undefined) => (ids ?? []).some((r) => runIds.includes(r));
  let id: string;
  let version: number;
  let outfitId: string | null = null;
  let realFace = await realFaceInputs(env, run.workspace_id, refs);

  if (sheet.mode === "new") {
    id = opts.existingId ?? opts.newId;
    const existing = await getCharacter(env, run.workspace_id, id);
    if (existing) {
      // A retry of the same sheet: complete version 1 with the views made now.
      const versions = versionsOf(existing);
      const v = versions.find((x) => touches(x.runIds)) ?? versions[versions.length - 1];
      if (!v) return null;
      v.views = { ...(v.views ?? {}), ...assets };
      v.assetIds = Object.values(v.views);
      v.runIds = [...new Set([...(v.runIds ?? []), run.id])];
      version = v.n;
      realFace ||= existing.real_face === 1;
      const current = v.n === versions[versions.length - 1]!.n;
      await env.DB.prepare("UPDATE characters SET versions = ?, sheet = CASE WHEN ? THEN ? ELSE sheet END, cover_asset_id = CASE WHEN ? THEN ? ELSE cover_asset_id END, real_face = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(versions), current ? 1 : 0, JSON.stringify(v.views), current ? 1 : 0, v.views.front ?? v.views.full_body ?? null, realFace ? 1 : 0, now, id)
        .run();
    } else {
      version = 1;
      const v: CharacterVersion = { n: 1, assetIds: Object.values(assets), createdAt: now, descriptorVersion: 1, descriptor: sheet.descriptor, views: assets, runIds };
      await env.DB.prepare(
        `INSERT OR IGNORE INTO characters (id, workspace_id, name, meta, cover_asset_id, versions, created_at, created_by, kind, descriptor, descriptor_version, sheet, outfits, real_face, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', ?, ?)`,
      )
        .bind(
          id,
          run.workspace_id,
          (spec.name ?? spec.title ?? "Character").slice(0, 80),
          JSON.stringify({ prompt: spec.prompt, runId: run.id, description: [sheet.descriptor.face, sheet.descriptor.hair, sheet.descriptor.build].filter(Boolean).join("; ").slice(0, 300) }),
          assets.front ?? assets.full_body ?? null,
          JSON.stringify([v]),
          now,
          run.created_by,
          sheet.descriptor.kind,
          JSON.stringify(sheet.descriptor),
          JSON.stringify(assets),
          realFace ? 1 : 0,
          now,
        )
        .run();
    }
  } else {
    const row = sheet.characterId ? await getCharacter(env, run.workspace_id, sheet.characterId) : null;
    if (!row) return null;
    id = row.id;
    realFace ||= row.real_face === 1;
    if (sheet.mode === "version") {
      const versions = versionsOf(row);
      let v = versions.find((x) => touches(x.runIds));
      const dv = (row.descriptor_version ?? 1) + (v ? 0 : 1);
      if (v) {
        v.views = { ...(v.views ?? {}), ...assets };
        v.assetIds = Object.values(v.views);
        v.runIds = [...new Set([...(v.runIds ?? []), run.id])];
      } else {
        v = { n: (versions[versions.length - 1]?.n ?? 0) + 1, assetIds: Object.values(assets), createdAt: now, descriptorVersion: dv, descriptor: sheet.descriptor, views: assets, runIds };
        versions.push(v);
      }
      version = v.n;
      // The sheet moves to the new version; its reference head crop is taken again on the next check.
      await env.DB.prepare("UPDATE characters SET versions = ?, descriptor = ?, descriptor_version = ?, sheet = ?, cover_asset_id = ?, ref_face_key = NULL, real_face = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(versions), JSON.stringify(sheet.descriptor), dv, JSON.stringify(v.views), v.views!.front ?? v.views!.full_body ?? row.cover_asset_id, realFace ? 1 : 0, now, id)
        .run();
    } else {
      const outfits = outfitsOf(row);
      let o = outfits.find((x) => touches(x.runIds));
      if (o) {
        o.views = { ...o.views, ...assets };
        o.runIds = [...new Set([...o.runIds, run.id])];
      } else {
        o = { id: `out_${run.id.replace(/^run_/, "")}`, name: sheet.outfit!.name, outfit: sheet.outfit!.outfit, views: assets, runIds, createdAt: now };
        outfits.push(o);
      }
      outfitId = o.id;
      version = versionsOf(row).at(-1)?.n ?? 1;
      await env.DB.prepare("UPDATE characters SET outfits = ?, real_face = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(outfits), realFace ? 1 : 0, now, id).run();
    }
  }

  // The sheet-picture index and each picture's own mark (runs read them for D-005 provenance and consistency).
  const statements = views.map((view) =>
    env.DB.prepare("INSERT OR REPLACE INTO character_sheet_assets (asset_id, character_id, workspace_id, version, view, outfit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      assets[view]!,
      id,
      run.workspace_id,
      version,
      view,
      outfitId,
      now,
    ),
  );
  for (const view of views) {
    statements.push(
      env.DB.prepare("UPDATE assets SET meta = json_set(COALESCE(meta, '{}'), '$.characterSheet', json(?)) WHERE id = ?").bind(
        JSON.stringify({ characterId: id, version, view, ...(outfitId && { outfitId }), realFace }),
        assets[view]!,
      ),
    );
  }
  await env.DB.batch(statements);
  return { characterId: id, version, outfitId };
}
