/**
 * What the service worker (src/sw.ts) may touch. Pure, so it is unit tested
 * without a browser.
 *
 * The worker only answers three kinds of requests:
 * - precached app-shell files (hashed `assets/*`, icons, `index.html`), by
 *   Workbox's precache route, which matches nothing outside its manifest;
 * - same-origin SPA navigations, answered with the precached `index.html`
 *   (`isAppNavigation`);
 * - same-origin static files that are not precached (fonts, icons, images),
 *   cache first (`isRuntimeStatic`);
 * - the hashed chunks left out of the precache on purpose (translations and
 *   the admin console, `ON_DEMAND_DIRS`), cache first once fetched
 *   (`isOnDemandChunk`).
 *
 * Everything else goes straight to the network untouched: `/api/*` (REST,
 * GraphQL, auth callbacks, WebSocket upgrades — WebSockets never pass through
 * a service worker anyway), `/media/*` signed media, and every cross-origin
 * request: the media hosts (`media*.rolling.actor`, `cdn-private*`), R2
 * presigned PUTs from the transfers SharedWorker (D-011), Google Identity
 * Services (`accounts.google.com`) and Stripe. Authenticated API responses
 * are never cached.
 */

/** Same-origin path prefixes the Worker answers itself; never served from the cache. */
export const NETWORK_ONLY_PATHS: readonly RegExp[] = [/^\/api(\/|$)/, /^\/media(\/|$)/];

/** The worker script and the manifest: the browser fetches them itself; never a navigation or runtime-cache hit. */
const SW_OWN_FILES = /^\/(sw\.js|manifest\.webmanifest)$/;

function hasFileExtension(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]+$/i.test(last);
}

export function isNetworkOnlyPath(pathname: string): boolean {
  return NETWORK_ONLY_PATHS.some((r) => r.test(pathname)) || SW_OWN_FILES.test(pathname);
}

/**
 * A top-level navigation to an SPA route: same origin, GET, not an API or
 * media path, not a file. Answered with the precached `index.html`.
 */
export function isAppNavigation(req: { url: string; method: string; mode: string }, origin: string): boolean {
  if (req.mode !== 'navigate' || req.method !== 'GET') return false;
  const url = new URL(req.url);
  if (url.origin !== origin) return false;
  if (isNetworkOnlyPath(url.pathname)) return false;
  return !hasFileExtension(url.pathname);
}

const STATIC_DESTINATIONS = new Set(['font', 'image']);
const STATIC_EXT = /\.(woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/i;

/**
 * Same-origin fonts and static images that are not in the precache (e.g. a
 * public icon added after the build). Cache first, size-capped.
 */
export function isRuntimeStatic(req: { url: string; method: string; destination: string }, origin: string): boolean {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url);
  if (url.origin !== origin) return false;
  if (isNetworkOnlyPath(url.pathname)) return false;
  // Query strings mark dynamic or signed URLs: never cache those.
  if (url.search) return false;
  return STATIC_DESTINATIONS.has(req.destination) && STATIC_EXT.test(url.pathname);
}

/**
 * Build output folders that are not precached (vite.config.ts `chunkFileNames`,
 * `injectManifest.globIgnores`): a visitor needs at most one translation, and
 * only staff open the admin console, so neither weighs on the first install.
 * Once fetched they are cached like the precache, so offline use keeps working.
 */
export const ON_DEMAND_DIRS = ['assets/locales', 'assets/admin'] as const;
const ON_DEMAND = new RegExp(`^/(${ON_DEMAND_DIRS.join('|')})/[\\w.-]+\\.(js|css)$`);

/** A same-origin GET for a hashed chunk under `ON_DEMAND_DIRS` (file names change on every build). */
export function isOnDemandChunk(req: { url: string; method: string }, origin: string): boolean {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url);
  return url.origin === origin && !url.search && ON_DEMAND.test(url.pathname);
}

/** Message the page posts to the waiting worker when the user chose Reload. */
export const SKIP_WAITING = 'SKIP_WAITING';
