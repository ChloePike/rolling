import { useQuery } from '@tanstack/react-query';
import { activityMock } from './mocks';
import type { ActivityData } from './types';

/** Activity list (`GET /api/runs`). Runs on mock data until the Runs API lands. */
export async function fetchActivity(): Promise<ActivityData> {
  return structuredClone(activityMock);
}

export function useActivity() {
  return useQuery({ queryKey: ['activity'], queryFn: fetchActivity, staleTime: Infinity });
}
