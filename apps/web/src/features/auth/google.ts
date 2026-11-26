import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import { refetchMe } from '@/lib/session';

/**
 * Google sign-in without leaving the page (D-017, docs/api.md → Auth), no client secret:
 *
 * - **Our own button** (the design's "Continue with Google"): Google Identity Services'
 *   OAuth2 token client (`google.accounts.oauth2.initTokenClient`, initialized on mount so
 *   `requestAccessToken()` runs synchronously in the click and the popup is not blocked)
 *   opens Google's popup; the access token goes to `POST /api/auth/google/access-token`,
 *   which verifies it with Google and sets the session cookie.
 * - **One Tap** (Google's own prompt, FedCM): `GET /api/auth/nonce` → ID token →
 *   `POST /api/auth/sign-in/social` `{ provider: 'google', idToken: { token, nonce } }`.
 *
 * Fallback: the script-free `GET /api/auth/google/start` (full-page redirect) when the
 * script cannot load or the popup is blocked (`popup_failed_to_open`). A popup the user
 * closes (`popup_closed`) is quiet.
 *
 * Mock mode: GIS is only loaded when `window.__rollingMocks.googleSdk` is true
 * (the e2e specs stub the script by route interception); otherwise the button runs
 * the mock redirect.
 */

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
const LOAD_TIMEOUT_MS = 8000;
export const GOOGLE_SCOPE = 'openid email profile';

export interface GoogleConfig {
  clientId: string;
  loginUri: string;
}

interface CredentialResponse {
  credential?: string;
}

interface GisId {
  initialize(config: Record<string, unknown>): void;
  prompt(listener?: (n: unknown) => void): void;
  cancel(): void;
  disableAutoSelect?(): void;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: Record<string, unknown>): void;
}

interface GisOauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    prompt?: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type?: string; message?: string }) => void;
  }): TokenClient;
}

interface GisAccounts {
  id?: GisId;
  oauth2?: GisOauth2;
}

declare global {
  interface Window {
    google?: { accounts?: GisAccounts };
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

let loading: Promise<GisAccounts> | null = null;

/** Loads the GIS script once (One Tap and the token client). Rejects when it is blocked, fails or takes too long. */
export function loadGis(): Promise<GisAccounts> {
  if (window.google?.accounts?.id || window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts);
  if (loading) return loading;
  loading = new Promise<GisAccounts>((resolve, reject) => {
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
      const accounts = window.google?.accounts;
      if (accounts?.id || accounts?.oauth2) resolve(accounts);
      else fail(new Error('GIS loaded without google.accounts'));
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

/**
 * Signs in (or, with `intent: 'link'`, links Google to the signed-in user) with an
 * access token from the token client. Resolves once `/api/me` reflects the session.
 * Rejects with `UNAUTHENTICATED` (`data.reason`: `INVALID_TOKEN` | `SCOPE`),
 * `FORBIDDEN` (`EMAIL_NOT_VERIFIED`) or `CONFLICT` (`ACCOUNT_IN_USE`, linking).
 * Mock: the token `mock-invalid` is refused.
 */
export async function signInWithGoogleAccessToken(accessToken: string, redirect: string, intent?: 'link'): Promise<{ redirectTo: string }> {
  if (isMockApi()) {
    await wait();
    if (accessToken === 'mock-invalid') throw new ApiError('UNAUTHENTICATED', 'Invalid or expired Google access token', 401, { reason: 'INVALID_TOKEN' } as never);
    return { redirectTo: redirect };
  }
  const r = await api.post<{ redirectTo?: string }>('/auth/google/access-token', { accessToken, redirect, ...(intent ? { intent } : {}) }, { noWorkspace: true });
  await refetchMe();
  return { redirectTo: r.redirectTo ?? redirect };
}

/** Why the token client produced no token. `popup_closed` and `superseded` are quiet. */
export type GooglePopupFailure = 'popup_closed' | 'popup_failed_to_open' | 'unavailable' | 'denied' | 'superseded' | 'unknown';

export class GooglePopupError extends Error {
  constructor(readonly type: GooglePopupFailure) {
    super(`Google popup: ${type}`);
  }
}

/** One token client per page (GIS calls a fixed callback; it settles the pending request). */
let tokenClient: { clientId: string; client: TokenClient } | null = null;
let preparing: { clientId: string; promise: Promise<void> } | null = null;
let pending: { resolve: (token: string) => void; reject: (err: GooglePopupError) => void } | null = null;

function settle(fn: (p: NonNullable<typeof pending>) => void) {
  const p = pending;
  pending = null;
  if (p) fn(p);
}

/** Loads GIS and initializes the token client for `clientId` (idempotent). */
export function prepareGoogleTokenClient(clientId: string): Promise<void> {
  if (tokenClient?.clientId === clientId) return Promise.resolve();
  if (preparing?.clientId === clientId) return preparing.promise;
  const promise = loadGis().then((accounts) => {
    if (!accounts.oauth2) throw new Error('GIS loaded without google.accounts.oauth2');
    const client = accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPE,
      prompt: 'select_account',
      callback: (r) => {
        if (r.access_token) settle((p) => p.resolve(r.access_token!));
        else settle((p) => p.reject(new GooglePopupError(r.error === 'access_denied' ? 'denied' : 'unknown')));
      },
      error_callback: (e) => {
        const t = e?.type;
        settle((p) => p.reject(new GooglePopupError(t === 'popup_closed' || t === 'popup_failed_to_open' ? t : 'unknown')));
      },
    });
    tokenClient = { clientId, client };
  });
  preparing = { clientId, promise };
  promise.catch(() => {
    if (preparing?.promise === promise) preparing = null;
  });
  return promise;
}

/**
 * Opens Google's popup. Call it synchronously from the click handler (the token client
 * must be prepared already, or browsers block the popup). Rejects with `unavailable`
 * when it is not, so the caller can use the redirect fallback.
 */
export function requestGoogleAccessToken(): Promise<string> {
  if (!tokenClient) return Promise.reject(new GooglePopupError('unavailable'));
  settle((p) => p.reject(new GooglePopupError('superseded')));
  const promise = new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
  });
  try {
    tokenClient.client.requestAccessToken();
  } catch {
    settle((p) => p.reject(new GooglePopupError('popup_failed_to_open')));
  }
  return promise;
}

/** Test seam: forget the token client (a fresh page has none). */
export function resetGoogleTokenClient(): void {
  tokenClient = null;
  preparing = null;
  pending = null;
}

/** Prepares the token client on mount; `ready` once a click can open the popup. */
export function useGoogleTokenClient(config: GoogleConfig | null): GisState {
  const clientId = config?.clientId;
  const enabled = !!clientId && gisEnabled();
  const [state, setState] = useState<GisState>(enabled ? (tokenClient?.clientId === clientId ? 'ready' : 'loading') : 'unavailable');
  useEffect(() => {
    if (!clientId || !gisEnabled()) {
      setState('unavailable');
      return;
    }
    let live = true;
    prepareGoogleTokenClient(clientId).then(
      () => live && setState('ready'),
      () => live && setState('unavailable'),
    );
    return () => {
      live = false;
    };
  }, [clientId]);
  return state;
}

export interface UseGoogleOptions {
  config: GoogleConfig | null;
  /** App path to land on after signing in. */
  redirect: string;
  /** Show One Tap (signed-out visitors only). */
  oneTap: boolean;
  /** `signin` (login) or `signup`: One Tap wording. */
  context?: 'signin' | 'signup';
  onCredential: (token: string, nonce: string) => Promise<void> | void;
}

function standalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * One Tap: loads GIS, initializes it with a fresh nonce and prompts (when `oneTap`).
 * `refresh()` starts over with a new nonce (after a failed attempt, or when it expires).
 */
export function useGoogleIdentity(opts: UseGoogleOptions): { state: GisState; refresh: () => void } {
  const [state, setState] = useState<GisState>(opts.config && opts.oneTap && gisEnabled() ? 'loading' : 'unavailable');
  const [round, setRound] = useState(0);
  const latest = useRef(opts);
  latest.current = opts;
  const config = opts.config;
  const clientId = config?.clientId;

  useEffect(() => {
    if (!config || !opts.oneTap || !gisEnabled()) {
      setState('unavailable');
      return;
    }
    setState((s) => (s === 'ready' ? s : 'loading'));
    let live = true;
    let id: GisId | null = null;
    Promise.all([loadGis(), fetchNonce(latest.current.redirect)])
      .then(([accounts, nonce]) => {
        if (!live) return;
        if (!accounts.id) throw new Error('GIS loaded without google.accounts.id');
        id = accounts.id;
        const o = latest.current;
        id.initialize({
          client_id: config.clientId,
          nonce,
          callback: (r: CredentialResponse) => {
            if (!r.credential) return;
            void latest.current.onCredential(r.credential, nonce);
          },
          // The installed app: Google posts the credential to `login_uri` instead.
          ux_mode: standalone() ? 'redirect' : 'popup',
          login_uri: config.loginUri,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true,
          itp_support: true,
          context: o.context ?? 'signin',
        });
        id.prompt();
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
