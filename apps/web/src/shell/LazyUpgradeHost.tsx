import { Suspense, useEffect, useState } from 'react';
import { lazyComponent, preloadWhenIdle } from '@/lib/lazy';
import { installPlanErrorHandler, useUpgrade } from '@/lib/upgrade';

const UpgradeHost = lazyComponent(() => import('@/features/account/upgrade/UpgradeModal'), (m) => m.UpgradeHost);

/**
 * The root route's upgrade layer, without the modal in the entry chunk. The
 * plan-error handler (a command answered `NO_PLAN` etc. opens the modal) is
 * installed at once; the modal's chunk (plans, Paywall, motion) is fetched when
 * the browser is idle after the first load, and mounted on the first
 * `openUpgrade`.
 */
export function LazyUpgradeHost() {
  useEffect(() => installPlanErrorHandler(), []);
  useEffect(() => preloadWhenIdle(UpgradeHost), []);
  const request = useUpgrade();
  const [mounted, setMounted] = useState(false);
  if (request && !mounted) setMounted(true);
  return mounted ? (
    <Suspense fallback={null}>
      <UpgradeHost />
    </Suspense>
  ) : null;
}
