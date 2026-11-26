/**
 * Install prompt rules (PWA.dc.html "Install prompt"):
 * - Chromium browsers fire `beforeinstallprompt`; we keep the event and show
 *   our own card instead of the browser's mini bar.
 * - iOS Safari has no install API: the card shows "tap Share, then Add to
 *   Home Screen" once.
 * - The card opens on its own once, after the user's first finished video,
 *   never on first visit (`noteFinishedVideo`). It is also available any time
 *   from the account menu (`openInstall`) while the app can be installed.
 */
import { isMockApi } from '@/lib/api/mode';
import { pwaOptedIn } from './register';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallKind = 'prompt' | 'ios' | null;

const OFFERED_KEY = 'rolling.installOffered';

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let open = false;
let started = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/**
 * Starts listening for the browser's install signal. Call once, early
 * (main.tsx). Mock builds (Playwright) only listen when a test opts in, like
 * the service worker, so the account menu and screenshots stay stable.
 */
export function startInstallWatch(): void {
  if (started || typeof window === 'undefined') return;
  if (isMockApi() && !pwaOptedIn()) return;
  started = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    open = false;
    emit();
  });
}

export function installKind(): InstallKind {
  if (!started || installed || isStandalone()) return null;
  if (deferred) return 'prompt';
  return isIosSafari() ? 'ios' : null;
}

export function installOpen(): boolean {
  return open && installKind() !== null;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Account menu: show the install card now. */
export function openInstall(): void {
  open = true;
  emit();
}

export function closeInstall(): void {
  open = false;
  emit();
}

/** A video run finished: offer the install card once, if the app can be installed. */
export function noteFinishedVideo(): void {
  if (!installKind()) return;
  try {
    if (window.localStorage.getItem(OFFERED_KEY)) return;
    window.localStorage.setItem(OFFERED_KEY, '1');
  } catch {
    return;
  }
  openInstall();
}

/** The Install button (Chromium): the browser's own confirm. */
export async function promptInstall(): Promise<void> {
  const e = deferred;
  open = false;
  emit();
  if (!e) return;
  deferred = null;
  await e.prompt().catch(() => undefined);
  const choice = await e.userChoice.catch(() => null);
  if (choice?.outcome === 'accepted') installed = true;
  emit();
}
