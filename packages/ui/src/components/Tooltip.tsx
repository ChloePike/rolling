import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  /** When false, nothing renders and the child behaves normally. */
  enabled?: boolean;
  /** Hover delay in ms. Keyboard focus shows it immediately. */
  delay?: number;
  /** Gap below the anchor, px. */
  offset?: number;
  className?: string;
  /**
   * The child must carry its own accessible name; by default the tooltip is a
   * visual echo of it. Set `describe` to link it with aria-describedby instead.
   */
  describe?: boolean;
  children: (props: { 'aria-describedby'?: string }) => ReactNode;
}

/**
 * Small label shown below an element on hover and keyboard focus; Escape hides it.
 * Rendered in a portal with fixed positioning so scroll containers never clip it.
 */
export function Tooltip({ content, enabled = true, delay = 300, offset = 8, describe = false, className, children }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pos) return;
    const hideNow = () => setPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideNow();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hideNow, true);
    window.addEventListener('resize', hideNow);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hideNow, true);
      window.removeEventListener('resize', hideNow);
    };
  }, [pos]);

  if (!enabled) return <>{children({})}</>;

  const show = (wait: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + offset });
    }, wait);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPos(null);
  };

  return (
    <span
      ref={anchorRef}
      className={cx(styles.wrap, className)}
      onPointerEnter={() => show(delay)}
      onPointerLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
    >
      {children(describe && pos ? { 'aria-describedby': id } : {})}
      {pos
        ? createPortal(
            <span role="tooltip" id={id} data-motion="" className={styles.tip} style={{ left: pos.x, top: pos.y }}>
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
