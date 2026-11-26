import { imageExtension, libraryR2Key } from './posewear';
import type { PublicLibraryItem } from './types';

/**
 * Row builders for importing library items into D1 (`assets`, `public_items`,
 * `asset_search` in db/d1.sql). Ids are deterministic so the import is
 * idempotent: re-running it updates rows in place.
 */

export interface LibraryAssetRow {
  id: string;
  workspace_id: null;
  kind: 'image';
  source: 'public';
  name: string;
  r2_key: string;
  meta: string;
  license: string;
  project_id: null;
  created_by: null;
  created_at: number;
  /** 0/1 (`assets.mature`): mature library images are only signed for viewers allowed to see them (D-005, D-008). */
  mature: number;
}

export interface LibraryPublicItemRow {
  id: string;
  category: string;
  sub: string | null;
  title: string;
  prompt_en: string | null;
  prompt_zh: string | null;
  angles: string;
  asset_id: string;
  license: string;
  source: string;
  tags: string;
  depth_key: string | null;
  /** 0/1. Mature items are never served on public surfaces (D-005). */
  mature: number;
}

export interface LibrarySearchRow {
  id: string;
  name: string;
  tags: string;
}

export interface LibraryD1Rows {
  assets: LibraryAssetRow[];
  publicItem: LibraryPublicItemRow;
  search: LibrarySearchRow;
}

/** One asset per angle (one R2 object each). */
export function libraryAssetId(itemId: string, angle: string): string {
  return `ast_${itemId}_${angle}`;
}

/** The JSON stored in `public_items.angles`. */
export interface LibraryAngleRecord {
  name: string;
  label: { en: string; zh?: string };
  assetId: string;
  r2Key: string;
  /** R2 key of the matching depth map (pose items), when known. */
  depthR2Key?: string;
}

export function toLibraryD1Rows(
  item: PublicLibraryItem,
  opts: { importedAt: number; depthR2KeyFor?: (item: PublicLibraryItem, angle: string) => string | undefined },
): LibraryD1Rows {
  const assets: LibraryAssetRow[] = item.angles.map((angle) => ({
    id: libraryAssetId(item.id, angle.name),
    workspace_id: null,
    kind: 'image',
    source: 'public',
    name: `${item.title.en} · ${angle.label.en}`,
    r2_key: angle.r2Key,
    meta: JSON.stringify({
      publicItemId: item.id,
      category: item.category,
      angle: angle.name,
      sourceUrl: angle.fullUrl,
      sourceThumbUrl: angle.thumbUrl,
      mature: item.mature,
      attribution: item.attribution,
    }),
    license: item.license,
    project_id: null,
    created_by: null,
    created_at: opts.importedAt,
    mature: item.mature ? 1 : 0,
  }));

  const angles: LibraryAngleRecord[] = item.angles.map((angle) => {
    const depthR2Key = opts.depthR2KeyFor?.(item, angle.name);
    return {
      name: angle.name,
      label: angle.label,
      assetId: libraryAssetId(item.id, angle.name),
      r2Key: angle.r2Key,
      ...(depthR2Key ? { depthR2Key } : {}),
    };
  });

  return {
    assets,
    publicItem: {
      id: item.id,
      category: item.category,
      sub: item.sub ?? null,
      title: item.title.en,
      prompt_en: item.prompt.en ?? null,
      prompt_zh: item.prompt.zh ?? null,
      angles: JSON.stringify(angles),
      asset_id: assets[0]!.id,
      license: item.license,
      source: item.sourceUrl,
      tags: JSON.stringify(item.tags),
      depth_key: angles.find((a) => 'depthR2Key' in a)?.depthR2Key ?? null,
      mature: item.mature ? 1 : 0,
    },
    search: {
      id: item.id,
      name: [item.title.en, item.title.zh].filter(Boolean).join(' '),
      // FTS column: tags plus the English prompt so free-text search hits descriptions.
      tags: [item.category, item.sub, ...item.tags, item.prompt.en].filter(Boolean).join(' '),
    },
  };
}

/** For pose items: the R2 key of the pose_depth counterpart's angle with the same name. */
export function poseDepthR2Key(item: PublicLibraryItem, angle: string): string | undefined {
  if (item.category === 'pose_depth') return item.angles.find((a) => a.name === angle)?.r2Key;
  if (item.category !== 'pose' || !item.counterpartId) return undefined;
  const depthUrl = item.angles.find((a) => a.name === angle)?.depthUrl;
  if (!depthUrl) return undefined;
  return libraryR2Key('pose_depth', item.counterpartId, angle, imageExtension(depthUrl));
}
