import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TransfersDock } from '@/features/transfers';
import { NotFound } from '@/pages/NotFound';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});

/** Every route: the page plus the transfers dock (shared upload/download queue, D-011). */
function Root() {
  return (
    <>
      <Outlet />
      <TransfersDock />
    </>
  );
}
