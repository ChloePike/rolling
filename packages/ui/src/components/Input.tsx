import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Visible label. Without it, pass `aria-label`. */
  label?: ReactNode;
  hint?: ReactNode;
  /** Error message; marks the input invalid. */
  error?: ReactNode;
  /** `card` (surface-4, inside cards) or `page` (surface-3, directly on the page). */
  surface?: 'card' | 'page';
  size?: 'sm' | 'md';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, surface = 'card', size = 'md', id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [rest['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx(styles.field, className)}>
      {label ? (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cx(styles.input, surface === 'page' && styles.page, size === 'sm' && styles.sm)}
        aria-invalid={error ? true : undefined}
        {...rest}
        aria-describedby={describedBy}
      />
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});
