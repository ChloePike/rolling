import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Pill.module.css';

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Emphasized state (first model pill, selected chip). */
  selected?: boolean;
  size?: 'sm' | 'md';
  /** Render a non-interactive span instead of a button. */
  static?: boolean;
}

/** Rounded chip used for parameters, filters and references. */
export function Pill({ icon, selected, size = 'md', static: isStatic, className, children, type = 'button', ...rest }: PillProps) {
  const cls = cx(styles.pill, selected && styles.selected, size === 'sm' && styles.sm, className);
  const content = (
    <>
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {children}
    </>
  );
  if (isStatic) return <span className={cls}>{content}</span>;
  return (
    <button type={type} className={cls} {...rest}>
      {content}
    </button>
  );
}
