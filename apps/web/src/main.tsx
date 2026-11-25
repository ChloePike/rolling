import { ToastProvider } from '@rolling/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useIntl } from 'react-intl';
import { I18nProvider } from './i18n/I18nProvider';
import { routeTree } from './routeTree.gen';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

function Toasts({ children }: { children: ReactNode }) {
  const intl = useIntl();
  return <ToastProvider dismissLabel={intl.formatMessage({ id: 'toast.dismiss' })}>{children}</ToastProvider>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <Toasts>
          <RouterProvider router={router} />
        </Toasts>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
