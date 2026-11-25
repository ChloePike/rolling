import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assetsMock, charactersMock, foldersMock, storageMock, uploadMock, voicesMock, type AssetItem, type AssetType, type VoiceItem } from './assetsMocks';

/**
 * My assets (`GET /api/assets?scope=mine`, `/api/characters`, `/api/voices`,
 * `POST /api/uploads`, `PATCH/DELETE /api/assets/:id`). Mock data until those
 * routes land; keep the hooks, swap the fetchers.
 */
const q = <T>(key: readonly string[], data: T) => ({ queryKey: key, queryFn: async () => structuredClone(data), staleTime: Infinity });

export const assetsKey = ['assets', 'mine'] as const;
export const voicesKey = ['voices'] as const;

export const useFolders = () => useQuery(q(['assets', 'folders'], foldersMock));
export const useAssets = () => useQuery(q(assetsKey, assetsMock));
export const useCharacters = () => useQuery(q(['characters'], charactersMock));
export const useVoices = () => useQuery(q(voicesKey, voicesMock));
export const useUpload = () => useQuery(q(['assets', 'upload'], uploadMock));
export const useStorage = () => useQuery(q(['assets', 'storage'], storageMock));

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
    remove: useMutation({
      mutationFn: async (id: string) => id,
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
