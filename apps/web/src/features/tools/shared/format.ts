import type { IntlShape } from 'react-intl';

/** `00:15` style clock for media durations. */
export function formatClock(intl: IntlShape, seconds: number): string {
  const two = (n: number) => intl.formatNumber(n, { minimumIntegerDigits: 2, useGrouping: false });
  return intl.formatMessage({ id: 'tools.clock' }, { m: two(Math.floor(seconds / 60)), s: two(seconds % 60) });
}

/** Compact relative time used in the history feed: “10 min ago”, “1h ago”, “Yesterday”, “3d ago”. */
export function formatAgo(intl: IntlShape, minutes: number): string {
  if (minutes < 60) return intl.formatMessage({ id: 'tools.ago.minutes' }, { n: minutes });
  if (minutes < 24 * 60) return intl.formatMessage({ id: 'tools.ago.hours' }, { n: Math.floor(minutes / 60) });
  const days = Math.floor(minutes / (24 * 60));
  if (days === 1) return intl.formatMessage({ id: 'tools.ago.yesterday' });
  return intl.formatMessage({ id: 'tools.ago.days' }, { n: days });
}
