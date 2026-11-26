import { useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';

/** Routes that keep working offline (handoff 8: canvas and timeline editing). */
const OFFLINE_CAPABLE: readonly RegExp[] = [/^\/p\//, /^\/dev\/editor/];

export function worksOffline(pathname: string): boolean {
  return OFFLINE_CAPABLE.some((r) => r.test(pathname));
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Whether to show the offline page instead of the route: the app opened, or
 * moved to a page that needs the network, while offline. A connection lost on
 * a page that is already showing keeps that page (its requests wait). Clears
 * when the connection is back or on "Try again" once online.
 */
export function useOfflineGate(): { offline: boolean; retry: () => void } {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [offline, setOffline] = useState(() => isOffline() && !worksOffline(pathname));

  useEffect(() => {
    setOffline(isOffline() && !worksOffline(pathname));
  }, [pathname]);

  const retry = useCallback(() => {
    if (isOffline()) return;
    setOffline(false);
    void router.invalidate();
  }, [router]);

  useEffect(() => {
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [retry]);

  return { offline, retry };
}
