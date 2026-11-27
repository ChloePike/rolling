import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import styles from './Trust.module.css';

/** Header + centered column for the public trust pages. */
export function PageFrame({ children }: { children: ReactNode }) {
  const intl = useIntl();
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link to="/" className={styles.brand} aria-label={intl.formatMessage({ id: 'header.home' })}>
          <svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
            <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
          </svg>
          Rolling
        </Link>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
