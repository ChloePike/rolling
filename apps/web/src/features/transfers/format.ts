import type { IntlShape } from 'react-intl';
import type { TransferItem } from '@/lib/transfers';

const UNITS = [
  ['byte', 1],
  ['kilobyte', 1e3],
  ['megabyte', 1e6],
  ['gigabyte', 1e9],
] as const;

/** Decimal byte units through Intl (e.g. “12.4 MB”). */
export function formatBytes(intl: IntlShape, bytes: number): string {
  const [unit, div] = [...UNITS].reverse().find(([, d]) => bytes >= d) ?? UNITS[0];
  const v = bytes / div;
  return intl.formatNumber(v, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: v >= 100 || unit === 'byte' ? 0 : 1 });
}

/** “1 min 20 sec” style, via Intl units (no sentence concatenation). */
export function formatEta(intl: IntlShape, seconds: number): string {
  if (seconds >= 3600) {
    return intl.formatNumber(Math.round(seconds / 360) / 10, { style: 'unit', unit: 'hour', unitDisplay: 'short', maximumFractionDigits: 1 });
  }
  if (seconds >= 60) return intl.formatNumber(Math.round(seconds / 60), { style: 'unit', unit: 'minute', unitDisplay: 'short' });
  return intl.formatNumber(Math.max(1, seconds), { style: 'unit', unit: 'second', unitDisplay: 'short' });
}

export const isActive = (i: TransferItem) => ['queued', 'preparing', 'running', 'retrying', 'completing', 'paused', 'needsFile'].includes(i.status);
export const isRunning = (i: TransferItem) => ['preparing', 'running', 'retrying', 'completing'].includes(i.status);
