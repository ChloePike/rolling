import { Outlet } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { shouldPlaySplash, Splash } from '../features/splash/Splash';
import { Header } from './Header';
import styles from './AppShell.module.css';

/** Layout for every page with the shared header. */
export function AppShell() {
  const [splash, setSplash] = useState(shouldPlaySplash);
  return (
    <div className={styles.shell}>
      {splash ? <Splash mode={splash} onDone={() => setSplash(false)} /> : null}
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
