import type { IntlShape } from 'react-intl';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** “2h ago”, “Yesterday”, “3d ago” (Main.dc.html project meta), via Intl. */
export function formatWhen(intl: IntlShape, iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < DAY) return intl.formatRelativeTime(-Math.max(1, Math.round(diff / HOUR)), 'hour', { style: 'narrow' });
  const days = Math.floor(diff / DAY);
  if (days === 1) return intl.formatMessage({ id: 'home.when.yesterday' });
  return intl.formatRelativeTime(-days, 'day', { style: 'narrow' });
}

/** “15s”. */
export function formatSeconds(intl: IntlShape, seconds: number): string {
  return intl.formatNumber(seconds, { style: 'unit', unit: 'second', unitDisplay: 'narrow' });
}
