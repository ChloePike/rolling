/**
 * Loading UX (no mock data in real mode, ever):
 * - while a query has no data yet, render a skeleton shaped like the final
 *   layout (`Skeleton` from `@rolling/ui`, which appears after ~150ms and
 *   pulses subtly; static under reduced motion);
 * - cached TanStack Query data renders at once, and refetches keep the
 *   previous data on screen (`keepPreviousData` where the key changes);
 * - truly empty data shows the screen's empty state; a failed load shows
 *   `LoadError` with Retry.
 */
export { LoadError, type LoadErrorProps } from './LoadError';
export { Skeleton, type SkeletonProps } from '@rolling/ui';

/** Loading phase of a query result: first load, error without data, or ready (possibly empty). */
export type LoadPhase = 'loading' | 'error' | 'ready';

export function loadPhase(q: { data?: unknown; isError?: boolean; isPending?: boolean }): LoadPhase {
  if (q.data !== undefined) return 'ready';
  if (q.isError) return 'error';
  return 'loading';
}
