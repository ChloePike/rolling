import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import { getPrefs, resolvedTheme } from '@/lib/prefs';
import { refetchMe } from '@/lib/session';

/**
 * Google sign-in without leaving the page (D-016, docs/api.md → Auth):
 *
 * 1. `GET /api/auth/nonce?redirect=` → a single-use nonce (5 minutes).
 * 2. Google Identity Services (loaded lazily, auth pages only) renders the official
 *    button (popup) and One Tap (FedCM), both with that nonce.
 * 3. The credential (an ID token) goes to `POST /api/auth/sign-in/social`
 *    `{ provider: 'google', idToken: { token, nonce } }`; the response sets the session cookie.
 *
 * Fallbacks: GIS redirect mode (`ux_mode: 'redirect'`, Google posts the token to
 * `login_uri`) after a closed or blocked popup and in the installed app; the
 * script-free `GET /api/auth/google/start` when the script cannot load at all.
 *
 * Mock mode: GIS is only loaded when `window.__rollingMocks.googleSdk` is true
 * (the e2e specs stub the script by route interception); otherwise the design
 * button runs the mock redirect as before.
 */

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
const LOAD_TIMEOUT_MS = 8000;
/** After a GIS button click, a credential should arrive this soon after focus returns, or the popup was closed. */
const POPUP_GRACE_MS = 1500;

export interface GoogleConfig {
  clientId: string;
  loginUri: string;
}

interface CredentialResponse {
  credential?: string;
}

interface GisId {
  initialize(config: Record<string, unknown>): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
  prompt(listener?: (n: unknown) => void): void;
  cancel(): void;
  disableAutoSelect?(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GisId } };
  }
}

interface MockSeams {
  googleSdk?: boolean;
  delayMs?: number;
}

function seams(): MockSeams {
  return ((typeof window !== 'undefined' && (window as unknown as { __rollingMocks?: MockSeams }).__rollingMocks) || {}) as MockSeams;
}

function wait(): Promise<void> {
  const ms = typeof seams().delayMs === 'number' ? seams().delayMs! : 400;
  return new Promise((r) => setTimeout(r, ms));
}

/** GIS is used in real mode, and in mock mode only behind the `googleSdk` seam. */
export function gisEnabled(): boolean {
  return !isMockApi() || seams().googleSdk === true;
}

let loading: Promise<GisId> | null = null;

/** Loads the GIS script once. Rejects when it is blocked, fails or takes too long. */
export function loadGis(): Promise<GisId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (loading) return loading;
  loading = new Promise<GisId>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    const timer = window.setTimeout(() => fail(new Error('GIS load timeout')), LOAD_TIMEOUT_MS);
    function fail(err: Error) {
      window.clearTimeout(timer);
      script.remove();
      loading = null;
      reject(err);
    }
    script.onload = () => {
      window.clearTimeout(timer);
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else fail(new Error('GIS loaded without google.accounts.id'));
    };
    script.onerror = () => fail(new Error('GIS failed to load'));
    document.head.appendChild(script);
  });
  return loading;
}

/** A fresh nonce for one attempt. `redirect` is kept server-side for the redirect fallback. */
export async function fetchNonce(redirect: string): Promise<string> {
  if (isMockApi()) return `mock-nonce-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const r = await api.get<{ nonce: string }>(`/auth/nonce?redirect=${encodeURIComponent(redirect)}`, { noWorkspace: true });
  return r.nonce;
}

/**
 * Signs in with a Google ID token; resolves once `/api/me` reflects the session.
 * Rejects with `UNAUTHENTICATED` (`data.reason`: `INVALID_TOKEN` | `NONCE`) or
 * `FORBIDDEN` (`EMAIL_NOT_VERIFIED`). Mock: the token `mock-invalid` is refused.
 */
export async function signInWithGoogleIdToken(token: string, nonce: string, redirect: string): Promise<{ redirectTo: string }> {
  if (isMockApi()) {
    await wait();
    if (token === 'mock-invalid') throw new ApiError('UNAUTHENTICATED', 'Invalid ID token', 401, { reason: 'INVALID_TOKEN' } as never);
    return { redirectTo: redirect };
  }
  const r = await api.post<{ redirectTo?: string }>('/auth/sign-in/social', { provider: 'google', idToken: { token, nonce }, callbackURL: redirect }, { noWorkspace: true });
  await refetchMe();
  return { redirectTo: r.redirectTo ?? redirect };
}

/** Where the script-free fallback starts (`intent=link` from Settings). */
export function googleStartUrl(redirect: string, intent?: 'link'): string {
  const q = new URLSearchParams({ redirect });
  if (intent) q.set('intent', intent);
  return `/api/auth/google/start?${q}`;
}

/** Full-page navigation (test seam `window.__rollingRedirect`). */
export function leaveTo(url: string): void {
  const seam = (window as unknown as { __rollingRedirect?: (u: string) => void }).__rollingRedirect;
  if (seam) seam(url);
  else window.location.assign(url);
}

/**
 * Script-free fallback: the window goes to Google and comes back signed in.
 * Mock without the redirect seam: resolves where the return would land.
 */
export async function startGoogleRedirect(redirect: string): Promise<{ redirectTo: string }> {
  const hasSeam = !!(window as unknown as { __rollingRedirect?: unknown }).__rollingRedirect;
  if (isMockApi() && !hasSeam) {
    await wait();
    return { redirectTo: redirect };
  }
  leaveTo(googleStartUrl(redirect));
  return new Promise(() => {});
}

export type GisState = 'loading' | 'ready' | 'unavailable';

export interface UseGoogleOptions {
  config: GoogleConfig | null;
  /** App path to land on after signing in. */
  redirect: string;
  /** Show One Tap (signed-out visitors only). */
  oneTap: boolean;
  /** Where the official button goes (popup or redirect mode). */
  buttonRef?: React.RefObject<HTMLDivElement | null>;
  /** `signin` (login) or `signup`: One Tap and button wording. */
  context?: 'signin' | 'signup';
  onCredential: (token: string, nonce: string) => Promise<void> | void;
  /** The popup closed without a credential (the next try uses redirect mode). */
  onPopupClosed?: () => void;
}

function standalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Loads GIS, initializes it with a fresh nonce, renders the button and shows One Tap.
 * `refresh()` starts over with a new nonce (after a failed attempt, or when it expires).
 */
export function useGoogleIdentity(opts: UseGoogleOptions): { state: GisState; refresh: () => void } {
  const [state, setState] = useState<GisState>(opts.config && gisEnabled() ? 'loading' : 'unavailable');
  const [round, setRound] = useState(0);
  const latest = useRef(opts);
  latest.current = opts;
  const redirectMode = useRef(false);
  const config = opts.config;
  const clientId = config?.clientId;

  useEffect(() => {
    if (!config || !gisEnabled()) {
      setState('unavailable');
      return;
    }
    setState((s) => (s === 'ready' ? s : 'loading'));
    let live = true;
    let clickedAt = 0;
    let gotCredential = false;
    let id: GisId | null = null;
    const onFocus = () => {
      if (!clickedAt) return;
      window.setTimeout(() => {
        if (!live || gotCredential || !clickedAt) return;
        clickedAt = 0;
        // Closed or blocked popup: switch to redirect mode for the next try.
        redirectMode.current = true;
        latest.current.onPopupClosed?.();
        setRound((r) => r + 1);
      }, POPUP_GRACE_MS);
    };
    window.addEventListener('focus', onFocus);
    Promise.all([loadGis(), fetchNonce(latest.current.redirect)])
      .then(([gis, nonce]) => {
        if (!live) return;
        id = gis;
        const o = latest.current;
        const redirect = redirectMode.current || standalone();
        gis.initialize({
          client_id: config.clientId,
          nonce,
          callback: (r: CredentialResponse) => {
            if (!r.credential) return;
            gotCredential = true;
            void latest.current.onCredential(r.credential, nonce);
          },
          ux_mode: redirect ? 'redirect' : 'popup',
          login_uri: config.loginUri,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true,
          itp_support: true,
          context: o.context ?? 'signin',
        });
        const el = o.buttonRef?.current;
        if (el) {
          el.replaceChildren();
          const width = Math.max(200, Math.min(400, Math.round(el.getBoundingClientRect().width) || 360));
          gis.renderButton(el, {
            type: 'standard',
            // Matches the design's primary button: light on dark, dark on light.
            theme: resolvedTheme(getPrefs().theme) === 'dark' ? 'outline' : 'filled_black',
            size: 'large',
            text: o.context === 'signup' ? 'signup_with' : 'continue_with',
            shape: 'rectangular',
            logo_alignment: 'center',
            width,
            click_listener: () => {
              clickedAt = Date.now();
            },
          });
        }
        if (o.oneTap) gis.prompt();
        setState('ready');
      })
      .catch(() => {
        if (live) setState('unavailable');
      });
    // Nonces live 5 minutes: start over a little before.
    const expiry = window.setTimeout(() => live && setRound((r) => r + 1), 270_000);
    return () => {
      live = false;
      window.clearTimeout(expiry);
      window.removeEventListener('focus', onFocus);
      try {
        id?.cancel();
      } catch {
        /* GIS already gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, round, opts.oneTap]);

  return { state, refresh: () => setRound((r) => r + 1) };
}
