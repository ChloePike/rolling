import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { idbGet, idbSet } from '../idbCache';

/**
 * Model catalog from `GET /api/models` (D-002), cached in IndexedDB.
 *
 * Stale-while-revalidate: the last saved catalog renders immediately (also
 * offline), then a background request revalidates with `If-None-Match`. A 304
 * keeps the cached copy; a 200 replaces it. The server catalog changes only on
 * sync (every 6 hours), so revalidation is cheap and rarely changes anything.
 *
 * Use `useModels(kind)` everywhere a model list is needed (model picker, Auto,
 * cost lines); never call the endpoint directly.
 */
export type ModelKind = 'image' | 'video' | 'chat';

export interface CreditPoint {
  resolution: string | null;
  seconds: number | null;
  credits: number;
}

export interface CatalogModel {
  id: string;
  kind: ModelKind;
  name: string;
  tags: string[];
  default: boolean;
  auto: boolean;
  mature: boolean;
  matureOnly: boolean;
  requiresIdentitySafety: boolean;
  operations: string[];
  seconds: { min: number; max: number } | null;
  defaultSeconds: number | null;
  resolutions: string[];
  defaultResolution: string | null;
  ratios: string[];
  audio: boolean;
  lipSync: boolean;
  credits: CreditPoint[];
  [extra: string]: unknown;
}

interface ModelsResponse {
  models: CatalogModel[];
}

const CACHE_VERSION = 1;
const cacheKey = (kind: ModelKind | undefined) => `models:v${CACHE_VERSION}:${kind ?? 'all'}`;
const queryKey = (kind: ModelKind | undefined) => ['models', kind ?? 'all'] as const;

async function fetchModels(kind: ModelKind | undefined): Promise<CatalogModel[]> {
  const key = cacheKey(kind);
  const cached = await idbGet<CatalogModel[]>(key);
  const url = kind ? `/api/models?kind=${kind}` : '/api/models';
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
    });
  } catch (err) {
    if (cached) return cached.value; // Offline: keep serving the cached catalog.
    throw err;
  }
  if (res.status === 304 && cached) {
    void idbSet(key, { ...cached, savedAt: Date.now() });
    return cached.value;
  }
  if (!res.ok) {
    if (cached) return cached.value;
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  const body = (await res.json()) as ModelsResponse;
  void idbSet(key, { value: body.models, etag: res.headers.get('etag'), savedAt: Date.now() });
  return body.models;
}

export function useModels(kind?: ModelKind) {
  const queryClient = useQueryClient();

  // Hydrate from IndexedDB before the network answers, without blocking render.
  useEffect(() => {
    let cancelled = false;
    void idbGet<CatalogModel[]>(cacheKey(kind)).then((entry) => {
      if (cancelled || !entry) return;
      if (queryClient.getQueryData(queryKey(kind)) === undefined) {
        queryClient.setQueryData(queryKey(kind), entry.value, { updatedAt: entry.savedAt });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [kind, queryClient]);

  return useQuery({
    queryKey: queryKey(kind),
    queryFn: () => fetchModels(kind),
    staleTime: 5 * 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Warm the cache at app start so the first model picker opens instantly. */
export function prefetchModels(queryClient: ReturnType<typeof useQueryClient>, kind?: ModelKind): Promise<void> {
  return queryClient.prefetchQuery({ queryKey: queryKey(kind), queryFn: () => fetchModels(kind), staleTime: 5 * 60_000 });
}
