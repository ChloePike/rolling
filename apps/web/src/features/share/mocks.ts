import type { ShareNode, ShareSnapshot } from '@/lib/api/types';

/** Mock share snapshot (mock mode only, through `mockData().share`). */
export function mockShare(id: string): ShareSnapshot {
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
