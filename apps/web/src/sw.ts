/// <reference lib="webworker" />
/**
 * Service worker (handoff 8, built by vite-plugin-pwa `injectManifest` into
 * `/sw.js`). What it may intercept is decided in `lib/pwa/swRules.ts`:
 * precached app shell, SPA navigations (→ `index.html`), same-origin static
 * fonts and images. `/api/*`, `/media/*` and every cross-origin request
 * (media hosts, R2 presigned uploads, Google sign-in, Stripe) have no route
 * here, so the browser handles them as if there were no worker.
 *
 * Updates: a new worker installs and waits. It activates only when the page
 * posts `SKIP_WAITING` at a safe moment (lib/pwa/register.ts: the next page
 * change, or a hidden tab; never mid-upload), and the page then loads the new version.
 */
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { isAppNavigation, isOnDemandChunk, isRuntimeStatic, SKIP_WAITING } from '@/lib/pwa/swRules';

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === SKIP_WAITING) void sw.skipWaiting();
});

// The build replaces `self.__WB_MANIFEST` with the precache list (hashed URLs and revisions).
precacheAndRoute((self as unknown as { __WB_MANIFEST: Array<PrecacheEntry | string> }).__WB_MANIFEST);
cleanupOutdatedCaches();
// Take control of open tabs on first install. On updates the worker only
// activates after the user's Reload, so claiming then is safe.
clientsClaim();

const origin = sw.location.origin;

registerRoute(({ request }) => isAppNavigation(request, origin), createHandlerBoundToURL('index.html'));

registerRoute(
  ({ request }) => isRuntimeStatic(request, origin),
  new CacheFirst({
    cacheName: 'rolling-static',
    plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true })],
  }),
);

// Translations and the admin console are not precached (vite.config.ts); cached once used.
registerRoute(
  ({ request }) => isOnDemandChunk(request, origin),
  new CacheFirst({
    cacheName: 'rolling-chunks',
    plugins: [new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 24 * 60 * 60, purgeOnQuotaError: true })],
  }),
);
