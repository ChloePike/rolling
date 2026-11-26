/**
 * Service worker registration and the update state behind the update prompt
 * (handoff 8: "A new version is ready · Reload").
 *
 * - Registered only in production builds (`vite build`), never under
 *   `vite dev`. In mock builds (`VITE_API_MODE=mock`, the Playwright specs)
 *   it stays off unless a test opts in with localStorage `rolling.sw = "on"`.
 * - A new worker that finished installing waits. `needsReload` turns true and
 *   the prompt shows; nothing reloads on its own (no skipWaiting mid-session).
 *   `applyUpdate()` (the Reload button) tells the waiting worker to activate
 *   and reloads once it controls the page.
 * - Checks for a new version every hour and when the tab becomes visible.
 */
import { Workbox } from 'workbox-window';
import { isMockApi } from '@/lib/api/mode';
import { SKIP_WAITING } from './swRules';

export const SW_OPT_IN_KEY = 'rolling.sw';
const UPDATE_CHECK_MS = 60 * 60 * 1000;

type Listener = () => void;

let needsReload = false;
let workbox: Workbox | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNeedsReload(): boolean {
  return needsReload;
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

export function registerServiceWorker(): void {
  if (workbox || !serviceWorkerEnabled()) return;
  const wb = new Workbox('/sw.js', { scope: '/' });
  workbox = wb;
  // A worker finished installing while another controls the page: offer the reload.
  wb.addEventListener('waiting', () => {
    needsReload = true;
    emit();
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

/** The Reload button: activate the waiting worker, then reload into the new version. */
export function applyUpdate(): void {
  const wb = workbox;
  if (!wb) return window.location.reload();
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };
  wb.addEventListener('controlling', reload);
  navigator.serviceWorker.addEventListener('controllerchange', reload);
  void navigator.serviceWorker.getRegistration('/').then((reg) => {
    if (reg?.waiting) reg.waiting.postMessage({ type: SKIP_WAITING });
    else reload();
  });
}
