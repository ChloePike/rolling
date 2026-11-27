import type { CSSProperties } from 'react';
import { cx } from '../cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** Width (px number or any CSS length). Defaults to 100%. */
  width?: number | string;
  /** Height (px number or any CSS length). Defaults to 1em of text for `text`, else 16px. */
  height?: number | string;
  /** Corner radius; `round` for pills and avatars. */
  radius?: number | string;
  round?: boolean;
  /** A line of text: text-height bar with a small radius. */
  text?: boolean;
  /** Delay before it appears (default 150ms, so fast loads never flash). */
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * A placeholder block shaped like the content it stands in for. Size it like
 * the final element so nothing shifts when data arrives. Flat theme fill
 * (`--c-surface-5`, light and dark), appears after ~150ms, then a subtle
 * pulse; static under `prefers-reduced-motion`. Decorative (`aria-hidden`):
 * put `aria-busy` on the region that is loading.
 */
export function Skeleton({ width, height, radius, round, text, delayMs, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      // Token-based: keeps its 150ms delay under reduced motion (the safety net in tokens.css would zero it and flash it).
      data-motion=""
      className={cx(styles.skeleton, text && styles.text, round && styles.round, className)}
      style={{
        width: width ?? (text ? '100%' : undefined),
        height: height ?? (text ? undefined : 16),
        ...(radius !== undefined ? { borderRadius: radius } : {}),
        ...(delayMs !== undefined ? ({ '--rl-skeleton-delay': `${delayMs}ms` } as CSSProperties) : {}),
        ...style,
      }}
    />
  );
}
