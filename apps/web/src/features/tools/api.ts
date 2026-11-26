import { useQuery } from '@tanstack/react-query';
import { isMockApi, mockData } from '@/lib/api/mode';
import type { FeedItem, ToolId } from './types';

/**
 * Tool history feed seed. Real mode starts empty: ToolLayout fills it from
 * `GET /api/runs` (this tool's runs). Mock mode shows the designs' sample
 * feed from the mock adapter.
 */
function mockFeed(tool: ToolId): FeedItem[] {
  const m = mockData();
  return { quick: m.quick.quickFeed, remix: m.remix.remixFeed, avatar: m.avatar.avatarFeed, character: m.character.characterFeed }[tool];
}

export async function fetchToolFeed(tool: ToolId): Promise<FeedItem[]> {
  return isMockApi() ? mockFeed(tool) : [];
}

export function useToolFeed(tool: ToolId): FeedItem[] {
  const q = useQuery({ queryKey: ['tools', 'feed', tool, isMockApi()], queryFn: () => fetchToolFeed(tool), initialData: () => (isMockApi() ? mockFeed(tool) : []) });
  return q.data;
}
