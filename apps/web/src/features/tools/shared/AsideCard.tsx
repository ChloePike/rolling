import type { ReactNode } from 'react';
import styles from './ToolLayout.module.css';

interface Props {
  title?: ReactNode;
  hint?: ReactNode;
  /** Extra control at the end of the title row (e.g. a language select). */
  end?: ReactNode;
  /** Lay children out in a row (switch rows, template card). */
  row?: boolean;
  gap?: number;
  children?: ReactNode;
  testId?: string;
}

/** A card in the tool's left panel. */
export function AsideCard({ title, hint, end, row, gap, children, testId }: Props) {
  return (
    <div className={row ? styles.cardRow : styles.card} style={gap !== undefined ? { gap } : undefined} data-card={testId}>
      {title !== undefined && (
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{title}</h2>
          <span className={styles.spacer} />
          {hint !== undefined && <span className={styles.cardHint}>{hint}</span>}
          {end}
        </div>
      )}
      {children}
    </div>
  );
}
