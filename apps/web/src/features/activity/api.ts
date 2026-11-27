import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isMockApi, userEvents } from '@/features/overlays/backend';
import { chainOf, listRuns, resultItems, type RunView } from '@/features/overlays/runs';
import { mockData } from '@/lib/api/mode';
import type { ActivityData, RunRow } from './types';

/**
 * Activity list. Real mode: `GET /api/runs` (newest first, up to 100 in the
 * window), refreshed on `activity.updated` from the user channel and every
 * few seconds while something runs. Mock mode: the design's rows.
 */

const KEY = ['activity'] as const;

function rowFrom(r: RunView, now: number): RunRow {
  const results = resultItems(r);
  const first = results.find((i) => i.assetId) ?? results[0];
  const chain = chainOf(r);
  return {
    id: r.id,
    ref: r.ref,
    name: r.name,
    source: r.tool === 'remix' ? 'remix' : r.tool === 'avatar' ? 'avatar' : r.tool === 'character' ? 'characters' : r.source,
    ...(r.projectTitle ? { projectTitle: r.projectTitle } : {}),
    params: r.params,
    status: r.status,
    ...(r.progress !== null && (r.status === 'running' || r.status === 'queued') ? { progress: r.progress } : {}),
    credits: r.credits,
    refunded: r.refunded,
    ...(r.error ? { error: r.error } : {}),
    minutesAgo: Math.max(0, Math.round((now - r.createdAt) / 60_000)),
    projectId: r.projectId,
    assetId: first?.assetId ?? null,
    mediaKind: first?.kind === 'image' ? 'image' : 'video',
    failedNodeIds: r.items.filter((i) => (i.status === 'failed' || i.status === 'canceled' || i.status === 'skipped') && i.nodeId).map((i) => i.nodeId!),
    ...(chain && { chain: { step: chain.current, failed: chain.failed } }),
  };
}

export async function fetchActivity(): Promise<ActivityData> {
  if (isMockApi()) return structuredClone(mockData().activity.activityMock);
  const page = await listRuns({ first: 100, from: Date.now() - 90 * 24 * 3600_000 });
  const now = Date.now();
  const s = page.stats;
  return {
    stats: {
      usedThisMonth: s.usedThisMonth,
      // A fraction (−0.12 = down 12%), as the message formats it with `::percent`.
      usedChange: s.usedLastMonth ? Math.round(((s.usedThisMonth - s.usedLastMonth) / s.usedLastMonth) * 100) / 100 : 0,
      running: s.running,
      runningEtaMinutes: s.running ? 2 : 0,
      successRate: s.successRate ?? 0,
      runsLast7Days: s.runsLast7Days,
      refunded: s.refundedThisMonth,
    },
    runs: page.runs.map((r) => rowFrom(r, now)),
  };
}

export function useActivity() {
  const qc = useQueryClient();
  const mock = isMockApi();
  const q = useQuery({
    queryKey: KEY,
    queryFn: fetchActivity,
    staleTime: mock ? Infinity : 5_000,
    refetchInterval: (query) => (!mock && query.state.data?.runs.some((r) => r.status === 'running' || r.status === 'queued') ? 4_000 : false),
  });
  useEffect(
    () =>
      userEvents((msg) => {
        if (msg.type === 'activity.updated') void qc.invalidateQueries({ queryKey: KEY });
      }),
    [qc],
  );
  return q;
}
