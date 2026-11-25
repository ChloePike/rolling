import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Swap.module.css';

interface SwapProps {
  /** Changes when the shown value changes (e.g. the formatted price). */
  id: string;
  children: ReactNode;
  className?: string;
}

/**
 * Animated value swap (Motion.dc.html): the old value leaves in 140ms with the
 * exit curve, moving up 4px, while the new one enters in 200ms with the
 * standard curve from 4px below. Both share one grid cell so layout does not
 * jump. Reduced motion: opacity only (the movement tokens collapse to 0).
 */
export function Swap({ id, children, className }: SwapProps) {
  const [cur, setCur] = useState({ id, changed: false });
  const [old, setOld] = useState<{ id: string; node: ReactNode } | null>(null);
  const last = useRef<ReactNode>(children);
  if (id !== cur.id) {
    setOld({ id: cur.id, node: last.current });
    setCur({ id, changed: true });
  }
  useLayoutEffect(() => {
    last.current = children;
  });
  return (
    <span className={className ? `${styles.swap} ${className}` : styles.swap} data-swap={id}>
      {old && (
        <span key={`old-${old.id}`} className={styles.leave} aria-hidden="true" onAnimationEnd={() => setOld(null)}>
          {old.node}
        </span>
      )}
      <span key={`cur-${cur.id}`} className={cur.changed ? styles.enter : styles.still}>
        {children}
      </span>
    </span>
  );
}
