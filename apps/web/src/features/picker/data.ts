import type { LibraryCategoryKey } from '@rolling/core/library/types';
import { useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { apiFetch, gql, isMockApi } from '@/features/overlays/backend';
import { ASSET_FIELDS, assetsKey, type GqlAsset } from '@/features/library/assetsApi';
import type { AssetItem } from '@/features/library/assetsMocks';
import { mockData } from '@/lib/api/mode';
import { queryClient as appQueryClient } from '@/lib/api/queryClient';
import type { PublicItem } from '@/lib/publicLibrary';
import { uploadFiles, type UploadHandle, type UploadOptions, type UploadResult } from '@/lib/transfers';
import { pushRecent } from './state';
import type { AssetPick, PickKind } from './types';

/**
 * Data behind the asset picker. Real mode: the workspace's assets through
 * GraphQL `assets(scope: TEAM, kind, q, first, after)` (paged, newest first,
 * mature only for allowed viewers, D-005), saved Characters through
 * `GET /api/characters` (their cover asset is what a run references). Mock
 * mode: the Assets page's mock list. Uploads go through the shared transfer
 * queue (D-011), which creates the asset in the user's Assets.
 */
export const MINE_PAGE = 48;

export const pickerKeys = {
  mine: (kind: PickKind | 'all', q: string) => ['picker', 'mine', kind, q] as const,
};

function durationMeta(sec: number | null | undefined): string | undefined {
  return sec ? `${Math.round(sec)}s` : undefined;
}

export function pickFromAsset(a: GqlAsset): AssetPick {
  const kind = a.kind === 'VIDEO' ? 'video' : a.kind === 'AUDIO' ? 'audio' : 'image';
  const mature = a.mature || a.rating === 'suggestive' || a.rating === 'explicit';
  return {
    id: a.id,
    assetId: a.id,
    kind,
    name: a.name.replace(/\.[a-z0-9]{2,5}$/i, '') || a.name,
    source: a.source === 'builtin' ? 'builtin' : a.source === 'team' ? 'team' : a.source === 'generated' ? 'generated' : a.source === 'public' ? 'public' : 'mine',
    thumbUrl: a.thumbUrl ?? (kind === 'image' ? a.url : null),
    meta: a.meta.width && a.meta.height ? `${a.meta.width}×${a.meta.height}` : durationMeta(a.meta.durationSec),
    mature,
    durationSec: a.meta.durationSec,
  };
}

export function pickFromPublic(item: PublicItem): AssetPick {
  return {
    id: item.id,
    assetId: item.assetId,
    kind: 'image',
    name: item.title,
    source: 'public',
    thumbUrl: item.thumbUrl,
    category: item.category,
    promptEn: item.promptEn,
    mature: !!item.mature,
  };
}

/** The mock asset list (Assets page) as picks. */
function pickFromMock(a: AssetItem): AssetPick | null {
  if (a.type === 'text') return null;
  return { id: a.id, assetId: a.id, kind: a.type, name: a.name.replace(/\.[a-z0-9]{2,5}$/i, '') || a.name, source: a.source === 'canvas' ? 'generated' : 'mine', thumbUrl: a.thumbUrl ?? null, meta: a.meta, mature: !!a.mature };
}

/** A finished upload as a pick: from the server's asset when it sent one, else from the file. */
export function pickFromUpload(file: File, result: UploadResult): AssetPick {
  const asset = result.asset as Partial<GqlAsset & { kind: string }> | undefined;
  if (asset && typeof asset.id === 'string' && asset.kind && asset.meta) {
    const kind = String(asset.kind).toUpperCase() as GqlAsset['kind'];
    return { ...pickFromAsset({ ...(asset as GqlAsset), kind, name: asset.name ?? file.name }), id: result.assetId, assetId: result.assetId };
  }
  const t = file.type.split('/')[0];
  const kind: PickKind = t === 'video' ? 'video' : t === 'audio' ? 'audio' : 'image';
  return {
    id: result.assetId,
    assetId: result.assetId,
    kind,
    name: file.name.replace(/\.[^.]+$/, '') || file.name,
    source: 'mine',
    thumbUrl: kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null,
  };
}

interface MinePage {
  items: AssetPick[];
  next: string | null;
}

const GQL_KIND: Record<'image' | 'video' | 'audio', GqlAsset['kind']> = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO' };

async function fetchRealMine(kind: PickKind | 'all', q: string, after: string | null): Promise<MinePage> {
  if (kind === 'character') {
    const r = await apiFetch<{ items: Array<{ id: string; name: string; coverAssetId: string | null; coverUrl: string | null; versions: Array<{ assetIds?: string[] }> }> }>('/characters');
    const items = r.items.flatMap((c): AssetPick[] => {
      const assetId = c.coverAssetId ?? c.versions.at(-1)?.assetIds?.[0] ?? null;
      if (!assetId) return [];
      if (q && !c.name.toLowerCase().includes(q.toLowerCase())) return [];
      return [{ id: c.id, assetId, kind: 'character', name: c.name, source: 'mine', thumbUrl: c.coverUrl }];
    });
    return { items, next: null };
  }
  const r = await gql<{ assets: { edges: Array<{ node: GqlAsset }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
    `query PickerAssets($scope: AssetScope, $kind: AssetKind, $q: String, $first: Int, $after: String) { assets(scope: $scope, kind: $kind, q: $q, first: $first, after: $after) { edges { node { ${ASSET_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
    { scope: 'TEAM', kind: kind === 'all' ? null : GQL_KIND[kind], q: q || null, first: MINE_PAGE, after },
  );
  const items = r.assets.edges.map((e) => e.node).filter((a) => a.kind !== 'TEXT' && a.status !== 'failed').map(pickFromAsset);
  return { items, next: r.assets.pageInfo.hasNextPage ? r.assets.pageInfo.endCursor : null };
}

function fetchMockMine(qc: QueryClient, kind: PickKind | 'all', q: string): MinePage {
  const lib = mockData().library;
  // The Assets page's cache first, so uploads it (or this picker) added show here too.
  const assets = qc.getQueryData<AssetItem[]>(assetsKey) ?? lib.assetsMock;
  const needle = q.toLowerCase();
  const files = assets.flatMap((a) => {
    const p = pickFromMock(a);
    return p ? [p] : [];
  });
  const chars = lib.charactersMock.map((c): AssetPick => ({ id: c.id, assetId: `ast_${c.id}`, kind: 'character', name: c.name, source: 'mine', thumbUrl: null, meta: c.meta || undefined }));
  const items = [...files, ...chars].filter((p) => (kind === 'all' || p.kind === kind) && (!needle || p.name.toLowerCase().includes(needle)));
  return { items, next: null };
}

/**
 * My assets for a kind filter (`all`: every file kind plus Characters when
 * the caller takes them). Paged; `fetchNextPage` loads the next 48.
 */
export function useMineAssets(kind: PickKind | 'all', q: string, opts: { enabled: boolean; withCharacters: boolean }) {
  const qc = useQueryClient();
  const mock = isMockApi();
  return useInfiniteQuery({
    queryKey: [...pickerKeys.mine(kind, q), opts.withCharacters],
    queryFn: async ({ pageParam }): Promise<MinePage> => {
      if (mock) return fetchMockMine(qc, kind, q);
      if (kind === 'all' && opts.withCharacters && !pageParam) {
        // First page of "All": files and saved Characters.
        const [files, chars] = await Promise.all([fetchRealMine('all', q, null), fetchRealMine('character', q, null).catch(() => ({ items: [], next: null }))]);
        return { items: [...files.items, ...chars.items], next: files.next };
      }
      return fetchRealMine(kind, q, pageParam);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: opts.enabled,
    staleTime: mock ? Infinity : 15_000,
    retry: 1,
  });
}

/* ------------------------------------------------------------------ recent */

const RECENT_KEY = 'rolling.picker.recent';
const recentListeners = new Set<() => void>();
let recentCache: AssetPick[] | null = null;

function readRecent(): AssetPick[] {
  if (recentCache) return recentCache;
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    // Object URLs of finished uploads do not survive a reload.
    recentCache = Array.isArray(parsed) ? (parsed as AssetPick[]).filter((p) => p && typeof p.assetId === 'string').map((p) => (p.thumbUrl?.startsWith('blob:') ? { ...p, thumbUrl: null } : p)) : [];
  } catch {
    recentCache = [];
  }
  return recentCache;
}

/** Remembers picks for the Recent tab (this browser only, a convenience). */
export function rememberPicks(picks: AssetPick[]) {
  if (!picks.length) return;
  recentCache = pushRecent(readRecent(), picks);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(recentCache));
  } catch {
    /* storage unavailable: recent stays in memory */
  }
  for (const l of recentListeners) l();
}

export function useRecentPicks(): AssetPick[] {
  return useSyncExternalStore(
    (cb) => {
      recentListeners.add(cb);
      return () => recentListeners.delete(cb);
    },
    readRecent,
    readRecent,
  );
}

/* ------------------------------------------------------------------ uploads */

/** A mock-mode asset row for a finished upload, so the Assets page and the picker list it. */
function mockAssetItem(pick: AssetPick, file: File): AssetItem {
  return {
    id: pick.assetId,
    name: file.name,
    type: pick.kind === 'character' ? 'image' : pick.kind,
    meta: `${Math.max(0.1, file.size / 1e6).toFixed(1)} MB`,
    ar: pick.kind === 'image' ? '1/1' : '16/10',
    refs: 0,
    source: 'upload',
    version: 1,
    uploadedAt: new Date().toISOString(),
    usedIn: [],
    thumbUrl: pick.thumbUrl,
  };
}

export interface AssetUpload {
  /** Transfer id (`upl_…`), also a provisional reference id (`resolveAssetId`). */
  id: string;
  file: File;
  /** The asset in the user's Assets, once the server has it. */
  done: Promise<AssetPick>;
}

/**
 * Every upload in the app goes through here: the shared transfer queue
 * (chunked, resumable, straight to R2, D-011) creates the asset in the
 * user's Assets (`POST /api/assets/uploads` → `ast_…`; the server runs
 * media processing and the face / safety checks on it). When an upload
 * finishes, the Assets lists refresh (mock mode: the asset is added to them).
 */
export function uploadToAssets(files: File[], opts: Partial<UploadOptions> = {}, qc: QueryClient = appQueryClient): { items: AssetUpload[]; refused: File[] } {
  const { items, rejected } = uploadFiles(files, { purpose: 'library', priority: 'high', quiet: true, ...opts });
  return {
    refused: rejected.map((r) => r.file),
    items: items.map((h: UploadHandle) => ({
      id: h.id,
      file: h.file,
      done: h.done.then((r) => {
        const pick = pickFromUpload(h.file, r);
        if (isMockApi()) qc.setQueryData<AssetItem[]>(assetsKey, (all) => [mockAssetItem(pick, h.file), ...(all ?? mockData().library.assetsMock)].filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i));
        else void qc.invalidateQueries({ queryKey: assetsKey });
        void qc.invalidateQueries({ queryKey: ['picker', 'mine'] });
        void qc.invalidateQueries({ queryKey: ['prompt', 'references'] });
        return pick;
      }),
    })),
  };
}

/** `uploadToAssets` bound to this app's query client. */
export function useUploadToAssets() {
  const qc = useQueryClient();
  return useCallback((files: File[], opts?: Partial<UploadOptions>) => uploadToAssets(files, opts, qc), [qc]);
}

export type { LibraryCategoryKey };
