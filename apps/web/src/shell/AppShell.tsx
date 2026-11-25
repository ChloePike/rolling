import { Outlet } from '@tanstack/react-router';
import { FormattedMessage } from 'react-intl';
import { Header } from './Header';
import styles from './AppShell.module.css';

/** Layout for every page with the shared header. */
export function AppShell() {
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        <FormattedMessage id="app.skipToContent" />
      </a>
      <Header />
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
