import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TransfersDock } from '@/features/transfers';
import { guardRoute } from '@/lib/session/guard';
import { SessionRuntime } from '@/lib/session/SessionRuntime';
import { NotFound } from '@/pages/NotFound';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Real API: app routes need a session (public: login, sign-up, share, invite, plans).
  beforeLoad: ({ location }) => guardRoute(location),
  component: Root,
  notFoundComponent: NotFound,
});

/** Every route: the page plus the transfers dock (shared upload/download queue, D-011). */
function Root() {
  return (
    <>
      <Outlet />
      <SessionRuntime />
      <TransfersDock />
    </>
  );
}
