import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from '../cx';
import { focusableIn } from './focus';
import { presenceProps, usePresence } from '../motion';
import styles from './Popover.module.css';

export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  'aria-haspopup': 'dialog' | 'menu' | 'listbox';
  onClick: () => void;
}

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Renders the trigger; spread the given props onto a button. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Accessible name of the floating layer. */
  label: string;
  role?: 'dialog' | 'menu' | 'listbox';
  align?: 'start' | 'center' | 'end';
  /** Open below (default) or above the trigger. The layer rises from the trigger side. */
  side?: 'bottom' | 'top';
  /**
   * Drop the default chrome (padding, radius, background, shadow) so the
   * child supplies its own panel. Enter/exit motion and dismissal still apply.
   */
  bare?: boolean;
  /** Gap between trigger and layer, px. */
  offset?: number;
  /** Shift along the cross axis (positive moves away from the aligned edge), px. */
  alignOffset?: number;
  /** Move focus into the layer when it opens. */
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Anchored floating layer: closes on Escape (returning focus to the trigger)
 * and on pointer down outside. Motion (Motion.dc.html "Popover"): enters in
 * 200ms with the standard curve from 6px toward the trigger, leaves in 140ms
 * with the exit curve; reduced motion fades only.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  role = 'dialog',
  align = 'end',
  side = 'bottom',
  bare = false,
  offset = 8,
  alignOffset = 0,
  autoFocus = true,
  className,
  style,
  children,
}: PopoverProps) {
  const id = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const close = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && autoFocus && contentRef.current) {
      const first = focusableIn(contentRef.current)[0];
      (first ?? contentRef.current).focus();
    }
  }, [open, autoFocus]);

  const presence = usePresence(open);
  const layerStyle = {
    ...style,
    '--popover-offset': `${offset}px`,
    '--popover-align-offset': `${-alignOffset}px`,
    '--rl-pop-dir': side === 'top' ? 1 : -1,
  } as CSSProperties;

  return (
    <div ref={anchorRef} className={styles.anchor}>
      {trigger({
        ref: triggerRef,
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-haspopup': role,
        onClick: () => onOpenChange(!open),
      })}
      {presence.mounted ? (
        <div
          ref={contentRef}
          id={open ? id : undefined}
          role={role}
          aria-label={label}
          tabIndex={-1}
          {...presenceProps(presence.state)}
          className={cx('rl-pop', styles.content, styles[align], styles[side], bare && styles.bare, className)}
          style={layerStyle}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
