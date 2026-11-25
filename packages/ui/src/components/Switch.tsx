import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../cx';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
}

/** On/off toggle. Give it an accessible name with `aria-label` or `aria-labelledby`. */
export function Switch({ checked, onCheckedChange, size = 'md', className, onClick, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx(styles.switch, size === 'sm' && styles.sm, className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange(!checked);
      }}
      {...rest}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
