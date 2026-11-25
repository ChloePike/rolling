import { cx, duration, presenceProps, usePresence } from '@rolling/ui';
import { useRef, type CSSProperties, type ReactNode } from 'react';

export interface PresenceProps {
  open: boolean;
  /** Positioning class for the floating layer. */
  className?: string;
  style?: CSSProperties;
  /** `below` (default) enters downward from the trigger; `above` enters upward. */
  placement?: 'below' | 'above';
  children: ReactNode;
}

/**
 * Floating layer with the shared popover motion (Motion.dc.html: 200ms
 * standard, y 6px in; 140ms exit curve out) built on `usePresence` +
 * `rl-pop` from `@rolling/ui`. While closing it keeps rendering the last
 * children it saw open, so content derived from the closing condition
 * (e.g. the `/` query) does not change during the exit.
 */
export function Presence({ open, className, style, placement = 'below', children }: PresenceProps) {
  const { mounted, state } = usePresence(open, duration.fast);
  const last = useRef<ReactNode>(children);
  if (open) last.current = children;
  if (!mounted) return null;
  return (
    <div
      className={cx('rl-pop', className)}
      style={{ ...style, ['--rl-pop-dir' as string]: placement === 'above' ? 1 : -1 }}
      {...presenceProps(state)}
    >
      {open ? children : last.current}
    </div>
  );
}
