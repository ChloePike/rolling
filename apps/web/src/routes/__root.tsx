import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { InstallCard, OfflinePage, UpdatePrompt, useOfflineGate } from '@/features/pwa';
import { TrustBanner } from '@/features/trust/TrustBanner';
import { loadEnglishRest } from '@/i18n/messages';
import { guardRoute } from '@/lib/session/guard';
import { SessionRuntime } from '@/lib/session/SessionRuntime';
import { NotFound } from '@/pages/NotFound';
import { LazyTransfersDock } from '@/shell/LazyTransfersDock';
import { LazyUpgradeHost } from '@/shell/LazyUpgradeHost';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Real API: app routes need a session (public: login, sign-up, share, invite, plans).
  beforeLoad: ({ location }) => guardRoute(location),
  // English outside Home's first paint (i18n/messages.ts) loads after the first render; every
  // other route waits for it here, in parallel with its own chunks and loaders.
  loader: ({ location }) => (location.pathname === '/' ? undefined : loadEnglishRest().catch(() => undefined)),
  component: Root,
  notFoundComponent: NotFound,
});

/**
 * Every route: the page plus the transfers dock (shared upload/download queue,
 * D-011) and the PWA layer (offline page, update prompt, install card).
 */
function Root() {
  const { offline, retry } = useOfflineGate();
  // After the first render (Home does not wait for it).
  useEffect(() => void loadEnglishRest().catch(() => undefined), []);
  return (
    <>
      {/* D-025, D-029: incident or degraded status, suspension, staff notices. */}
      {offline ? null : <TrustBanner />}
      {offline ? <OfflinePage onRetry={retry} /> : <Outlet />}
      <SessionRuntime />
      <LazyUpgradeHost />
      <LazyTransfersDock />
      <UpdatePrompt />
      <InstallCard />
    </>
  );
}
