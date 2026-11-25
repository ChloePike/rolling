import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { focusableIn } from './focus';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name of the close button; omit to hide the button. */
  closeLabel?: string;
  /** Close when the backdrop is clicked. */
  dismissOnBackdrop?: boolean;
  width?: number;
  className?: string;
  children?: ReactNode;
}

/** Modal dialog: focus trap, Escape to close, focus restored on close. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  dismissOnBackdrop = true,
  width,
  className,
  children,
}: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) (focusableIn(panel)[0] ?? panel).focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = focusableIn(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onOpenChange]);

  if (!open) return null;
  return createPortal(
    <div
      className={styles.overlay}
      onPointerDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(styles.panel, className)}
        style={width ? { width } : undefined}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {closeLabel ? (
            <button type="button" className={styles.close} aria-label={closeLabel} onClick={() => onOpenChange(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18 M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        {description ? (
          <p id={descId} className={styles.description}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
