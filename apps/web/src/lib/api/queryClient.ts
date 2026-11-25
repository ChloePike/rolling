import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './errors';

/**
 * The app's one QueryClient (main.tsx provides it). Exported so non-React code
 * (the user socket, the session store, checkout returns) can read and write
 * the same cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Client errors (signed out, forbidden, missing) do not get better by retrying.
      retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 1,
    },
  },
});
