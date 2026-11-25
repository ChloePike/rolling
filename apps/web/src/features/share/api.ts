import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { ShareNode, ShareSnapshot } from '@/lib/api/types';
import { isMatureRating, type ContentRating } from '@/lib/media';

/**
 * Public share snapshot (`GET /api/share/:id`, no auth). The server drops
 * mature nodes and signs media URLs for 1 h; nodes whose params still carry a
 * mature flag or a suggestive/explicit rating are dropped here too (D-005: no
 * mature output on public surfaces).
 */
export async function fetchShare(id: string): Promise<ShareSnapshot | null> {
  if (isMockApi()) return id === 'shr_missing' ? null : mockShare(id);
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

function mockShare(id: string): ShareSnapshot {
  const node = (n: number, kind: string, title: string, x: number, y: number, extra: Partial<ShareNode> = {}): ShareNode => ({
    id: `node_${n}`,
    kind,
    title,
    params: {},
    position: { x, y },
    groupId: null,
    media: null,
    ...extra,
  });
  return {
    shareId: id,
    title: 'Ridgeline Sparkling, 15s',
    revision: 12,
    createdAt: Date.now() - 3_600_000,
    allowDownload: true,
    nodes: [
      node(1, 'script', 'Script', 0, 0, { params: { rows: [{ n: 1, title: 'Morning light' }] } }),
      node(2, 'image', 'Keyframe 1', 320, -80),
      node(3, 'video', 'Shot 1', 640, -80),
      node(4, 'image', 'Keyframe 2', 320, 160),
      node(5, 'video', 'Shot 2', 640, 160),
      node(6, 'video', 'Late night (hidden)', 960, 40, { params: { rating: 'explicit' } }),
    ],
    edges: [
      { id: 'e1', from: { node: 'node_1', port: 'out' }, to: { node: 'node_2', port: 'prompt' } },
      { id: 'e2', from: { node: 'node_2', port: 'out' }, to: { node: 'node_3', port: 'frame' } },
      { id: 'e3', from: { node: 'node_1', port: 'out' }, to: { node: 'node_4', port: 'prompt' } },
      { id: 'e4', from: { node: 'node_4', port: 'out' }, to: { node: 'node_5', port: 'frame' } },
    ],
    groups: [],
  };
}
