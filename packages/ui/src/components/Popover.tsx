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
 * and on pointer down outside.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  role = 'dialog',
  align = 'end',
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

  const layerStyle = {
    ...style,
    '--popover-offset': `${offset}px`,
    '--popover-align-offset': `${-alignOffset}px`,
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
      {open ? (
        <div
          ref={contentRef}
          id={id}
          role={role}
          aria-label={label}
          tabIndex={-1}
          className={cx(styles.content, styles[align], className)}
          style={layerStyle}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
