import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** `pill` (999 radius) for creation UIs, `rounded` (10px) for account pages. */
  shape?: 'pill' | 'rounded';
  /** Stretch to the container width. */
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', shape = 'pill', block, icon, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], styles[shape], block && styles.block, className)}
      {...rest}
    >
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
});
