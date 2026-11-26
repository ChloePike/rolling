import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, gql, isMockApi } from '@/features/overlays/backend';
import { mockData } from '@/lib/api/mode';
import type { AssetItem, AssetType, CharacterItem, FolderItem, VoiceItem } from './assetsMocks';

/**
 * My assets. Real mode: GraphQL `assets(scope: MINE)` (newest first), REST
 * `/api/characters`, `/api/voices`, `DELETE /api/assets/:id`; uploads go
 * through `lib/transfers` (D-011) and the list refetches when one completes.
 * Mock mode: the design's data.
 */
const q = <T>(key: readonly string[], data: T) => ({ queryKey: key, queryFn: async () => structuredClone(data), staleTime: Infinity });

export const assetsKey = ['assets', 'mine'] as const;
export const voicesKey = ['voices'] as const;

/** GraphQL `Asset` fields the creation side reads (assets page, `@` picker). */
export interface GqlAsset {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT';
  source: string;
  name: string;
  status: string;
  mature: boolean;
  /** D-005 content rating; null when unrated (an unrated mature asset still counts as suggestive). */
  rating: 'safe' | 'suggestive' | 'explicit' | null;
  size: number | null;
  contentType: string | null;
  license: string | null;
  projectId: string | null;
  createdAt: number;
  url: string | null;
  thumbUrl: string | null;
  meta: { width: number | null; height: number | null; durationSec: number | null };
}

export const ASSET_FIELDS = 'id kind source name status mature rating size contentType license projectId createdAt url thumbUrl meta { width height durationSec }';

export async function fetchAssets(vars: { scope: 'MINE' | 'TEAM' | 'BUILTIN' | 'PUBLIC' | 'ALL'; kind?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT'; q?: string; first?: number }): Promise<GqlAsset[]> {
  const r = await gql<{ assets: { edges: Array<{ node: GqlAsset }> } }>(
    `query Assets($scope: AssetScope, $kind: AssetKind, $q: String, $first: Int) { assets(scope: $scope, kind: $kind, q: $q, first: $first) { edges { node { ${ASSET_FIELDS} } } } }`,
    { first: 100, ...vars },
  );
  return r.assets.edges.map((e) => e.node);
}

function sizeMeta(a: GqlAsset): string {
  if (a.meta.durationSec) return `${Math.round(a.meta.durationSec)}s`;
  if (a.meta.width && a.meta.height) return `${a.meta.width}×${a.meta.height}`;
  return a.size ? `${(a.size / 1e6).toFixed(1)} MB` : '';
}

export function assetItemFrom(a: GqlAsset): AssetItem {
  const type = a.kind.toLowerCase() as AssetType;
  return {
    id: a.id,
    name: a.name,
    type,
    meta: sizeMeta(a),
    ar: a.meta.width && a.meta.height ? `${a.meta.width}/${a.meta.height}` : type === 'image' ? '1/1' : '16/10',
    refs: 0,
    source: a.source === 'generated' ? 'canvas' : 'upload',
    version: 1,
    uploadedAt: new Date(a.createdAt).toISOString(),
    usedIn: a.projectId ? [{ label: a.projectId, to: `/p/${a.projectId}` }] : [],
    ...(a.projectId ? { folder: a.projectId } : {}),
    projectId: a.projectId,
    thumbUrl: a.thumbUrl,
    mature: a.mature,
    rating: a.rating ?? (a.mature ? 'suggestive' : null),
  };
}

const realAssets = async () => (await fetchAssets({ scope: 'MINE' })).map(assetItemFrom);

const realCharacters = async (): Promise<CharacterItem[]> => {
  const r = await apiFetch<{ items: Array<{ id: string; name: string; meta: unknown; versions: unknown[] }> }>('/characters');
  return r.items.map((c) => ({ id: c.id, name: c.name, meta: typeof c.meta === 'string' ? c.meta : '', projects: c.versions.length }));
};

const realVoices = async (): Promise<VoiceItem[]> => {
  const r = await apiFetch<{ items: Array<{ id: string; name: string; language: string | null; kind: string; status: string }> }>('/voices');
  return r.items.map((v) => ({ id: v.id, name: v.name, meta: [v.kind === 'cloned' ? 'Cloned' : 'Built-in', v.language].filter(Boolean).join(' · '), state: v.status === 'pending' ? 'cloning' : 'ready' }));
};

const lib = () => mockData().library;
/** A query that never runs (real mode has no endpoint for it yet; the page hides that part). */
const none = <T>(key: readonly string[]) => ({ queryKey: key, queryFn: async (): Promise<T | null> => null, enabled: false });

export const useAssets = () => useQuery(isMockApi() ? q(assetsKey, lib().assetsMock) : { queryKey: assetsKey, queryFn: realAssets, staleTime: 15_000 });
export const useCharacters = () => useQuery(isMockApi() ? q(['characters'], lib().charactersMock) : { queryKey: ['characters'], queryFn: realCharacters, staleTime: 30_000 });
export const useVoices = () => useQuery(isMockApi() ? q(voicesKey, lib().voicesMock) : { queryKey: voicesKey, queryFn: realVoices, staleTime: 30_000 });
/** Mock only: the design's sample upload row (real uploads come from `lib/transfers`). */
export const useUpload = () => useQuery<{ name: string; sizeMb: number; progress: number } | null>(isMockApi() ? q(['assets', 'upload'], lib().uploadMock) : none(['assets', 'upload']));
/** Mock only until a storage endpoint exists; real mode hides the meter. */
export const useStorage = () => useQuery<{ usedGb: number; totalGb: number } | null>(isMockApi() ? q(['assets', 'storage'], lib().storageMock) : none(['assets', 'storage']));

/**
 * Folder rail. Mock mode: the design's folders. Real mode: the built-in
 * folders with counts from the lists themselves (`null` while a list loads,
 * shown as a skeleton).
 */
export function useFolders(): { data: FolderItem[] | undefined } {
  const mock = isMockApi();
  const m = useQuery(mock ? q(['assets', 'folders'], lib().foldersMock) : none<FolderItem[]>(['assets', 'folders']));
  const assets = useAssets();
  const chars = useCharacters();
  const voices = useVoices();
  if (mock) return { data: m.data ?? undefined };
  return {
    data: [
      { id: 'all', kind: 'all', count: assets.data?.length ?? null },
      { id: 'characters', kind: 'characters', count: chars.data?.length ?? null },
      { id: 'voices', kind: 'voices', count: voices.data?.length ?? null },
      { id: 'favorites', kind: 'favorites', count: assets.data ? assets.data.filter((a) => a.favorite).length : null },
    ],
  };
}

/** File type from a browser `File` (uploads are probed server-side later). */
export function assetTypeOf(file: File): AssetType {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'text';
}

let seq = 0;

/** A finished upload as a mock asset. */
export function assetFromFile(file: File, folder: string | undefined): AssetItem {
  seq += 1;
  const type = assetTypeOf(file);
  const mb = Math.max(0.1, file.size / 1e6);
  return {
    id: `ast_new${seq}`,
    name: file.name,
    type,
    meta: `${mb.toFixed(1)} MB`,
    ar: type === 'image' ? '1/1' : '16/10',
    refs: 0,
    source: 'upload',
    version: 1,
    uploadedAt: new Date().toISOString(),
    usedIn: [],
    folder: folder && folder.startsWith('prj_') ? folder : undefined,
  };
}

/** Rename, delete and add on the cached asset list. */
export function useAssetMutations() {
  const qc = useQueryClient();
  const edit = (fn: (all: AssetItem[]) => AssetItem[]) => qc.setQueryData<AssetItem[]>(assetsKey, (all) => fn(all ?? []));
  return {
    add: (a: AssetItem) => edit((all) => [a, ...all]),
    rename: useMutation({
      mutationFn: async (v: { id: string; name: string }) => v,
      onSuccess: (v) => edit((all) => all.map((a) => (a.id === v.id ? { ...a, name: v.name } : a))),
    }),
    /** Real mode: refetch after an upload completes (the new asset is `processing` first). */
    refresh: () => qc.invalidateQueries({ queryKey: assetsKey }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        if (!isMockApi()) await apiFetch(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return id;
      },
      onSuccess: (id) => edit((all) => all.filter((a) => a.id !== id)),
    }),
    toggleFavorite: (id: string) => edit((all) => all.map((a) => (a.id === id ? { ...a, favorite: !a.favorite } : a))),
  };
}

export function useVoiceMutations() {
  const qc = useQueryClient();
  return {
    add: (v: VoiceItem) => qc.setQueryData<VoiceItem[]>(voicesKey, (all) => [...(all ?? []), v]),
    update: (id: string, patch: Partial<VoiceItem>) => qc.setQueryData<VoiceItem[]>(voicesKey, (all) => (all ?? []).map((v) => (v.id === id ? { ...v, ...patch } : v))),
  };
}
