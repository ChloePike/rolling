import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi, mockData } from '@/lib/api/mode';
import type { ShareNode, ShareSnapshot } from '@/lib/api/types';
import { isMatureRating, type ContentRating } from '@/lib/media';

/**
 * Public share snapshot (`GET /api/share/:id`, no auth). The server drops
 * mature nodes and signs media URLs for 1 h; nodes whose params still carry a
 * mature flag or a suggestive/explicit rating are dropped here too (D-005: no
 * mature output on public surfaces).
 */
export async function fetchShare(id: string): Promise<ShareSnapshot | null> {
  if (isMockApi()) return id === 'shr_missing' ? null : mockData().share.mockShare(id);
  try {
    return await api.get<ShareSnapshot>(`/share/${encodeURIComponent(id)}`, { noWorkspace: true });
  } catch (e) {
    if (isApiError(e, 'NOT_FOUND')) return null;
    throw e;
  }
}

export function useShare(id: string) {
  return useQuery({ queryKey: ['share', id], queryFn: () => fetchShare(id), staleTime: 5 * 60_000, refetchOnWindowFocus: false });
}

/** Nodes a public viewer may see. */
export function publicNodes(s: ShareSnapshot): ShareNode[] {
  return s.nodes.filter((n) => {
    const p = n.params ?? {};
    return p.mature !== true && !isMatureRating(p.rating as ContentRating | undefined);
  });
}
