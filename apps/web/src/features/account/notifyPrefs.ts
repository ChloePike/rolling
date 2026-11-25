import { setPref, usePrefs } from '@/lib/prefs';

/**
 * Notification preferences besides "Generation finished" (`notifyWhenDone`):
 * credits low, plan renewal, product updates. They live in lib/prefs with the
 * rest, so they sync to `PATCH /api/me/prefs` (`notifications.low|renewal|product`).
 */
export type NotifyKey = 'creditsLow' | 'planRenewal' | 'productUpdates';
export type NotifyPrefs = Record<NotifyKey, boolean>;

const PREF = { creditsLow: 'notifyCreditsLow', planRenewal: 'notifyPlanRenewal', productUpdates: 'notifyProductUpdates' } as const;

export function setNotifyPref(key: NotifyKey, value: boolean) {
  setPref(PREF[key], value);
}

export function useNotifyPrefs(): NotifyPrefs {
  const p = usePrefs();
  return { creditsLow: p.notifyCreditsLow, planRenewal: p.notifyPlanRenewal, productUpdates: p.notifyProductUpdates };
}
