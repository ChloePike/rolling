import { useToast } from '@rolling/ui';
import { Suspense, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useTransferToasts } from '@/features/transfers/toasts';
import { lazyComponent, preloadWhenIdle } from '@/lib/lazy';
import { useTransfers } from '@/lib/transfers';

const TransfersDock = lazyComponent(() => import('@/features/transfers/TransfersDock'), (m) => m.TransfersDock);

/**
 * The root route's transfers dock (D-011) without its UI in the entry chunk. The
 * queue itself (`lib/transfers`) stays eager, so transfers from another tab are
 * tracked from the start. The dock mounts as soon as its chunk arrives (fetched
 * when the browser is idle) or at once when a transfer is queued, and then stays
 * mounted. The completion, failure and refusal toasts listen from the first render.
 */
export function LazyTransfersDock() {
  useTransferToasts(useIntl(), useToast());
  const { items } = useTransfers();
  const [mounted, setMounted] = useState(false);
  if (items.length > 0 && !mounted) setMounted(true);
  useEffect(() => {
    let live = true;
    const cancel = preloadWhenIdle({ preload: () => TransfersDock.preload().then(() => void (live && setMounted(true))) });
    return () => {
      live = false;
      cancel();
    };
  }, []);
  return mounted ? (
    <Suspense fallback={null}>
      <TransfersDock />
    </Suspense>
  ) : null;
}
