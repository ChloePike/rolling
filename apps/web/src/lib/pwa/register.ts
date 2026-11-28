/**
 * Service worker registration and silent updates (owner, 2026-11-28: no update
 * prompt; replaces handoff 8's "A new version is ready · Reload").
 *
 * - Registered only in production builds (`vite build`), never under
 *   `vite dev`. In mock builds (`VITE_API_MODE=mock`, the Playwright specs)
 *   it stays off unless a test opts in with localStorage `rolling.sw = "on"`.
 * - A new worker that finished installing waits; nothing is shown. It is
 *   activated at the next safe moment, and the page loads the new version:
 *   - the next in-app navigation (the target URL loads in full), or
 *   - the tab has been hidden for `HIDDEN_RELOAD_MS` (not on a canvas or the editor),
 *   and only while nothing would be lost: no upload or download in flight and
 *   no other busy check (`addBusyCheck`) says otherwise. Otherwise it waits
 *   for the next such moment; closing every tab also activates it.
 * - Checks for a new version every hour and when the tab becomes visible.
 * - `workbox-window` loads on demand (after the page's `load` event), so it is
 *   not in the entry chunk.
 */
import type { Workbox } from 'workbox-window';
import { isMockApi } from '@/lib/api/mode';
import { SKIP_WAITING } from './swRules';

export const SW_OPT_IN_KEY = 'rolling.sw';
const UPDATE_CHECK_MS = 60 * 60 * 1000;
/** A hidden tab this long with a waiting worker reloads into the new version. */
export const HIDDEN_RELOAD_MS = 60 * 1000;
/** How long a switch waits for the new worker to take control before it loads anyway. */
const ACTIVATE_WAIT_MS = 4000;

let updateWaiting = false;
let workbox: Workbox | null = null;
let applying = false;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
const busyChecks = new Set<() => boolean>();

/** A source of work a reload would lose (transfers, unsaved edits). Returns the unsubscribe. */
export function addBusyCheck(check: () => boolean): () => void {
  busyChecks.add(check);
  return () => busyChecks.delete(check);
}

function busy(): boolean {
  for (const check of busyChecks) {
    try {
      if (check()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** A new version is installed and waits for a safe moment (tests and debugging). */
export function updatePending(): boolean {
  return updateWaiting;
}

/** Mock builds: a test opted into the PWA layer (service worker and install signal). */
export function pwaOptedIn(): boolean {
  try {
    return window.localStorage.getItem(SW_OPT_IN_KEY) === 'on';
  } catch {
    return false;
  }
}

export function serviceWorkerEnabled(): boolean {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (import.meta.env.DEV) return false;
  if (isMockApi()) return pwaOptedIn();
  return true;
}

let registering = false;

export function registerServiceWorker(): void {
  if (registering || workbox || !serviceWorkerEnabled()) return;
  registering = true;
  void import('workbox-window').then(({ Workbox }) => startWorkbox(new Workbox('/sw.js', { scope: '/' })));
}

function startWorkbox(wb: Workbox): void {
  workbox = wb;
  // A worker finished installing while another controls the page: switch at the next safe moment.
  wb.addEventListener('waiting', () => {
    updateWaiting = true;
    if (document.visibilityState === 'hidden') scheduleHiddenReload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleHiddenReload();
    else if (hiddenTimer) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
  });
  void wb.register().then((registration) => {
    if (!registration) return;
    const check = () => void registration.update().catch(() => undefined);
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  });
}

function scheduleHiddenReload(): void {
  if (!updateWaiting || hiddenTimer) return;
  hiddenTimer = setTimeout(() => {
    hiddenTimer = null;
    // Never on a hidden canvas or editor: edits made offline may not have synced yet (handoff 8).
    if (document.visibilityState === 'hidden' && !window.location.pathname.startsWith('/p/')) applyUpdate();
  }, HIDDEN_RELOAD_MS);
}

/**
 * Called before an in-app navigation (a history blocker, so the next page never starts
 * rendering and fetching on the old version): with a version waiting and nothing busy, the
 * navigation becomes a full load of `href` on the new version. Returns true when it took over.
 */
export function updateOnNavigation(href: string): boolean {
  if (!updateWaiting) return false;
  return applyUpdate(href);
}

/**
 * Activates the waiting worker and loads `href` (default: this page) on the new version.
 * Does nothing while busy, or when no worker waits; returns whether it started.
 */
export function applyUpdate(href?: string): boolean {
  if (applying || !updateWaiting || busy()) return false;
  const wb = workbox;
  if (!wb) return false;
  applying = true;
  let done = false;
  const load = () => {
    if (done) return;
    done = true;
    if (href && href !== window.location.href) window.location.assign(href);
    else window.location.reload();
  };
  wb.addEventListener('controlling', load);
  navigator.serviceWorker.addEventListener('controllerchange', load);
  void navigator.serviceWorker.getRegistration('/').then((reg) => {
    if (reg?.waiting) reg.waiting.postMessage({ type: SKIP_WAITING });
    else load();
  });
  // The old worker activates the new one only once its in-flight requests end (a playing
  // video can hold one open): load anyway after a moment; the new version then applies on a later load.
  setTimeout(load, ACTIVATE_WAIT_MS);
  return true;
}
