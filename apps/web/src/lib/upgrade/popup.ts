/**
 * Stripe Checkout (and the billing portal) without leaving the app: the
 * upgrade modal opens them in a popup, so the page, the brief and the modal
 * stay as they are. Stripe returns the popup to `…?rl_popup=1&checkout=…`;
 * that page tells the opener (BroadcastChannel, plus `postMessage` while the
 * opener link survives) and closes itself. When the popup is blocked the
 * modal falls back to the usual same-tab redirect (pending actions survive it).
 */

export const POPUP_PARAM = 'rl_popup';
const CHANNEL = 'rolling.checkout';
const MESSAGE = 'rolling.checkout.return';
const PENDING_PREFIX = 'rolling.pendingAction';

export interface PopupReturn {
  checkout: 'success' | 'canceled' | null;
  sessionId: string | null;
  portal: boolean;
}

/** A return path that marks the page as the checkout popup. */
export function popupReturnPath(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${POPUP_PARAM}=1`;
}

/**
 * Opens the (blank) checkout window synchronously from the click, before the
 * checkout request, so popup blockers allow it. Null when blocked. Test seam:
 * `window.__rollingCheckoutWindow` = false forces the blocked path.
 */
export function openCheckoutWindow(): Window | null {
  if ((window as unknown as { __rollingCheckoutWindow?: boolean }).__rollingCheckoutWindow === false) return null;
  try {
    const w = window.open('', 'rolling-checkout', 'popup,width=520,height=780');
    return w ?? null;
  } catch {
    return null;
  }
}

/** Points the popup at Stripe. */
export function navigateCheckoutWindow(w: Window, url: string): void {
  try {
    w.location.replace(url);
  } catch {
    w.location.href = url;
  }
}

/** Subscribes to popup returns (any tab of this origin). Returns the unsubscribe function. */
export function onPopupReturn(cb: (r: PopupReturn) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data as { type?: string } & PopupReturn;
    if (d?.type === MESSAGE) cb({ checkout: d.checkout, sessionId: d.sessionId, portal: d.portal });
  };
  window.addEventListener('message', onMessage);
  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (channel) channel.onmessage = (e: MessageEvent) => onMessage(new MessageEvent('message', { data: e.data, origin: window.location.origin }));
  } catch {
    channel = null;
  }
  return () => {
    window.removeEventListener('message', onMessage);
    channel?.close();
  };
}

/**
 * Runs first in `main.tsx`. On the popup's return page: tell the opener, drop
 * the pending actions this window copied from it (only the opener resumes),
 * strip the return params and close. Returns true on a popup return page (the
 * app still renders if the browser keeps the window open).
 */
export function handlePopupReturn(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get(POPUP_PARAM) !== '1') return false;
  const c = q.get('checkout');
  const msg = {
    type: MESSAGE,
    checkout: c === 'success' || c === 'canceled' ? c : null,
    sessionId: q.get('session_id'),
    portal: q.has('portal'),
  };
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PENDING_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* No storage. */
  }
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    /* No BroadcastChannel: postMessage below. */
  }
  try {
    window.opener?.postMessage(msg, window.location.origin);
  } catch {
    /* The opener link was severed. */
  }
  for (const k of [POPUP_PARAM, 'checkout', 'session_id', 'portal']) q.delete(k);
  const s = q.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`);
  window.close();
  return true;
}
