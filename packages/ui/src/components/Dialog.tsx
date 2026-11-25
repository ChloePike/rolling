import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { focusableIn } from './focus';
import { duration, presenceProps, usePresence } from '../motion';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible title. Required unless `bare` (then pass `label`). */
  title?: ReactNode;
  /** Accessible name when there is no visible title (bare dialogs). */
  label?: string;
  /** Id of an element inside `children` that names the dialog (bare dialogs). */
  labelledBy?: string;
  /**
   * Drop the default panel chrome and header; `children` render the whole
   * panel. Backdrop, focus trap, Escape and motion still apply.
   */
  bare?: boolean;
  /** Extra class for the backdrop (e.g. a different scrim or padding). */
  overlayClassName?: string;
  description?: ReactNode;
  /** Accessible name of the close button; omit to hide the button. */
  closeLabel?: string;
  /** Close when the backdrop is clicked. */
  dismissOnBackdrop?: boolean;
  width?: number;
  className?: string;
  children?: ReactNode;
}

/**
 * Modal dialog: focus trap, Escape to close, focus restored on close.
 * Motion: the panel enters in 320ms (rise 8px, scale from .96) with the
 * standard curve and leaves in 140ms with the exit curve; the scrim fades.
 * Reduced motion: fades only.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  label,
  labelledBy,
  bare = false,
  overlayClassName,
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

  const presence = usePresence(open, duration.fast);
  if (!presence.mounted) return null;
  const closing = presence.state === 'closed';
  return createPortal(
    <div
      {...presenceProps(presence.state)}
      className={cx('rl-fade', styles.overlay, overlayClassName)}
      onPointerDown={(e) => {
        if (!closing && dismissOnBackdrop && e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={bare && !labelledBy ? label : undefined}
        aria-labelledby={bare ? labelledBy : titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        {...presenceProps(presence.state)}
        className={cx('rl-modal', bare ? styles.bare : styles.panel, className)}
        style={width ? { width } : undefined}
      >
        {bare ? children : (<>
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
        </>)}
      </div>
    </div>,
    document.body,
  );
}
