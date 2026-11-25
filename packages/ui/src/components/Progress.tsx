import type { CSSProperties } from 'react';
import { cx } from '../cx';

export interface ProgressProps {
  /** Real progress from 0 to 1. Never fake it: no shimmer, no indeterminate loop. */
  value: number;
  /** Accessible name, e.g. "Generating shot A". */
  label: string;
  /** Track height in px (default 4). */
  height?: number;
  /** Fill color (default accent). */
  color?: string;
  /** Track color (default surface-5). */
  trackColor?: string;
  className?: string;
  style?: CSSProperties;
}

/** Linear progress bar; width changes animate linearly (Motion.dc.html "Generating → result"). */
export function Progress({ value, label, height = 4, color, trackColor, className, style }: ProgressProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cx('rl-progress', className)}
      style={{ height, background: trackColor, ...style }}
    >
      <span className="rl-progress-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
