import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name. Required because the button has no visible text. */
  label: string;
  icon: ReactNode;
  size?: 28 | 32 | 34 | 40;
  /** `filled` uses surface-3 (header controls), `secondary` surface-5, `ghost` is transparent. */
  variant?: 'filled' | 'secondary' | 'ghost';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 34, variant = 'filled', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(styles.iconButton, styles[`s${size}`], styles[variant], className)}
      {...rest}
    >
      {icon}
    </button>
  );
});
