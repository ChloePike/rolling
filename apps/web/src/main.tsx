import { ToastProvider } from '@rolling/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useIntl } from 'react-intl';
import { I18nProvider } from '@/i18n/I18nProvider';
import { routeTree } from '@/routeTree.gen';
import { queryClient } from '@/lib/api/queryClient';
import { loadMockData } from '@/lib/api/mode';
import { startInstallWatch } from '@/lib/pwa/install';
import { registerServiceWorker } from '@/lib/pwa/register';
import '@/styles/app.css';

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

// PWA (handoff 8): catch the install signal early; register the service worker after load.
startInstallWatch();
if (document.readyState === 'complete') registerServiceWorker();
else window.addEventListener('load', registerServiceWorker, { once: true });

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

// Mock builds load their data first (a no-op that ships nothing in real builds, lib/api/mode.ts).
void loadMockData().then(() =>
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
  ),
);
