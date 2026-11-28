import { ToastProvider } from '@rolling/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useIntl } from 'react-intl';
import { I18nProvider, preloadLocale } from '@/i18n/I18nProvider';
import { routeTree } from '@/routeTree.gen';
import { queryClient } from '@/lib/api/queryClient';
import { loadMockData } from '@/lib/api/mode';
import { startInstallWatch } from '@/lib/pwa/install';
import { registerServiceWorker, updateOnNavigation } from '@/lib/pwa/register';
import { handlePopupReturn } from '@/lib/upgrade/popup';
import '@/styles/app.css';

// The checkout popup's return page tells the opener and closes (lib/upgrade/popup.ts); it runs before the router reads the URL.
handlePopupReturn();

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

// Silent updates (D-038): with a new version waiting, the next page change is held and becomes a full
// load of the target on the new version (lib/pwa/register.ts). Same-page changes (search, hash) pass.
router.history.block({
  enableBeforeUnload: false,
  blockerFn: ({ currentLocation, nextLocation }) =>
    nextLocation.pathname !== currentLocation.pathname && updateOnNavigation(new URL(nextLocation.href, window.location.origin).href),
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

// Mock builds load their data first (a no-op that ships nothing in real builds, lib/api/mode.ts);
// the saved or browser locale's messages load alongside, so the first paint is in that language.
void Promise.all([loadMockData(), preloadLocale()]).then(() =>
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
