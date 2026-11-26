import { redirect } from '@tanstack/react-router';
import { isMockApi } from '@/lib/api/mode';
import { ensureMe } from './real';

/**
 * Route guard (real API): app routes need a session; signed-out visitors go to
 * `/login?redirect=<where they were going>`. Public: login and sign-up, share
 * links, invite landings, public profiles, the read-only plans page and the
 * legal pages.
 */
const PUBLIC: readonly RegExp[] = [
  /^\/login\/?$/,
  /^\/signup\/?$/,
  /^\/share\/[^/]+\/?$/,
  /^\/invite\/[^/]+\/?$/,
  /^\/upgrade\/?$/,
  /^\/u\/[^/]+\/?$/,
  // Legal pages (`/terms` and `/privacy` are registered with Google OAuth) and the old `/legal/<doc>` redirects.
  /^\/(terms|privacy|acceptable-use|subprocessors)\/?$/,
  /^\/legal\/[^/]+\/?$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((r) => r.test(pathname));
}

/** A same-site path to return to after sign-in, or `/`. */
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/^\/(login|signup)(\/|\?|$)/.test(raw)) return '/';
  return raw;
}

export async function guardRoute(location: { pathname: string; href: string }): Promise<void> {
  if (isMockApi()) return;
  if (isPublicPath(location.pathname)) {
    // Public pages still show who is signed in; never block them on it.
    void ensureMe().catch(() => undefined);
    return;
  }
  // Offline (the service worker served the app shell): the session cannot be
  // checked and the query would wait for the network; the root shows the
  // offline page, and coming back online re-runs this guard.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const me = await ensureMe();
  if (!me) throw redirect({ to: '/login', search: { redirect: location.href } });
}

/** `/login` and `/signup` when already signed in: go where the user was headed. */
export async function redirectIfSignedIn(target: unknown): Promise<void> {
  if (isMockApi()) return;
  const me = await ensureMe().catch(() => null);
  if (me) throw redirect({ href: safeRedirect(target) });
}
