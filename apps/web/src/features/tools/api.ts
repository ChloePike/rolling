import { useQuery } from '@tanstack/react-query';
import { avatarFeed } from './avatar/mocks';
import { characterFeed } from './character/mocks';
import { quickFeed } from './quick/mocks';
import { remixFeed } from './remix/mocks';
import type { FeedItem, ToolId } from './types';

/**
 * Tool history feed. Mocked until the runs API lands (docs/api.md, `GET /api/runs?tool=`);
 * the real client replaces `fetchToolFeed` only.
 */
const MOCK_FEEDS: Record<ToolId, FeedItem[]> = { quick: quickFeed, remix: remixFeed, avatar: avatarFeed, character: characterFeed };

export async function fetchToolFeed(tool: ToolId): Promise<FeedItem[]> {
  return MOCK_FEEDS[tool];
}

export function useToolFeed(tool: ToolId): FeedItem[] {
  const q = useQuery({ queryKey: ['tools', 'feed', tool], queryFn: () => fetchToolFeed(tool), initialData: MOCK_FEEDS[tool] });
  return q.data;
}
