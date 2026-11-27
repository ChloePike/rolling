import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isMockApi } from '@/features/overlays/backend';
import { mockData } from '@/lib/api/mode';

/**
 * Character page data (D-032): `GET /api/characters/:id` and the rename
 * (`PATCH`). The descriptor is locked: a new version or an outfit variant is a
 * sheet run (`POST /api/runs/quote` with `promptSpec.sheet`).
 */
export type DriftVerdict = 'consistent' | 'minor' | 'drift' | 'no_face';

export interface DriftSummary {
  checks: number;
  scored: number;
  mean: number | null;
  min: number | null;
  drifted: number;
  verdict: DriftVerdict | null;
}

export interface SheetPicture {
  view: string;
  assetId: string;
  url: string | null;
  thumbUrl: string | null;
}

export interface CharacterDescriptor {
  kind: 'person' | 'animal' | 'object';
  face: string;
  hair?: string;
  build?: string;
  outfit?: string;
  style?: string;
}

export interface CharacterDetail {
  id: string;
  name: string;
  kind: string;
  coverUrl: string | null;
  descriptor: CharacterDescriptor | null;
  descriptorVersion: number;
  sheet: SheetPicture[];
  realFace: boolean;
  drift: DriftSummary | null;
  createdAt: number;
  versions: Array<{ n: number; descriptorVersion: number; createdAt: number; current: boolean; views: SheetPicture[]; drift: DriftSummary }>;
  outfits: Array<{ id: string; name: string; outfit: string; createdAt: number; views: SheetPicture[] }>;
  usedIn: Array<{ projectId: string; title: string; uses: number; lastUsedAt: number }>;
  checks: Array<{ id: string; version: number; assetId: string; projectId: string | null; score: number | null; verdict: string; faces: number; createdAt: number; thumbUrl: string | null }>;
  training: { available: boolean; appliesLoras: string[] };
}

export const characterKey = (id: string) => ['characters', id] as const;

export function useCharacter(id: string) {
  return useQuery({
    queryKey: characterKey(id),
    queryFn: async (): Promise<CharacterDetail> => {
      if (isMockApi()) return structuredClone(mockData().character.characterDetailMock(id)) as CharacterDetail;
      return (await apiFetch<{ character: CharacterDetail }>(`/characters/${encodeURIComponent(id)}`)).character;
    },
    staleTime: 15_000,
  });
}

export function useRenameCharacter(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<CharacterDetail | null> => {
      if (isMockApi()) return null;
      return (await apiFetch<{ character: CharacterDetail }>(`/characters/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } })).character;
    },
    onSuccess: (c, name) => {
      qc.setQueryData<CharacterDetail>(characterKey(id), (old) => (c ?? (old ? { ...old, name } : old)));
      void qc.invalidateQueries({ queryKey: ['characters'], exact: true });
    },
  });
}
