import { useSyncExternalStore } from 'react';

/**
 * Notification preferences that `lib/prefs` does not hold yet (credits low,
 * plan renewal, product updates). "Generation finished" is `prefs.notifyWhenDone`.
 * Local adapter until lib/prefs (or `PATCH /api/me/prefs`) carries them; stored
 * in localStorage so they survive reload.
 */
export type NotifyKey = 'creditsLow' | 'planRenewal' | 'productUpdates';
export type NotifyPrefs = Record<NotifyKey, boolean>;

const KEY = 'rolling.account.notifications';
const EVENT = 'rolling:account-notifications';
export const DEFAULT_NOTIFY: NotifyPrefs = { creditsLow: true, planRenewal: true, productUpdates: false };

let raw: string | null | undefined;
let cache: NotifyPrefs = DEFAULT_NOTIFY;

export function getNotifyPrefs(): NotifyPrefs {
  let next: string | null = null;
  try {
    next = window.localStorage.getItem(KEY);
  } catch {
    next = null;
  }
  if (next !== raw) {
    raw = next;
    try {
      const o = next ? (JSON.parse(next) as Partial<NotifyPrefs>) : {};
      cache = {
        creditsLow: typeof o.creditsLow === 'boolean' ? o.creditsLow : DEFAULT_NOTIFY.creditsLow,
        planRenewal: typeof o.planRenewal === 'boolean' ? o.planRenewal : DEFAULT_NOTIFY.planRenewal,
        productUpdates: typeof o.productUpdates === 'boolean' ? o.productUpdates : DEFAULT_NOTIFY.productUpdates,
      };
    } catch {
      cache = DEFAULT_NOTIFY;
    }
  }
  return cache;
}

export function setNotifyPref(key: NotifyKey, value: boolean) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...getNotifyPrefs(), [key]: value }));
  } catch {
    /* Storage unavailable. */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(subscribe, getNotifyPrefs, () => DEFAULT_NOTIFY);
}
