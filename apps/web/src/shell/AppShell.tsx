import { Outlet, useMatches } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { shouldPlaySplash, Splash } from '@/features/splash/Splash';
import { Header } from './Header';
import styles from './AppShell.module.css';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /**
     * The page fills the area under the header edge to edge (no page padding),
     * e.g. the tool screens. Set as `staticData: { fullBleed: true }` on the route.
     */
    fullBleed?: boolean;
  }
}

/** Layout for every page with the shared header (72px, Main.dc.html). */
export function AppShell() {
  const [splash, setSplash] = useState(shouldPlaySplash);
  const fullBleed = useMatches({ select: (matches) => matches.some((m) => m.staticData?.fullBleed) });
  return (
    <div className={styles.shell}>
      {splash ? <Splash mode={splash} onDone={() => setSplash(false)} /> : null}
      <a href="#main" className={styles.skip}>
        <FormattedMessage id="app.skipToContent" />
      </a>
      <Header />
      <main id="main" className={fullBleed ? styles.fullBleed : styles.main} tabIndex={-1} data-full-bleed={fullBleed || undefined}>
        <Outlet />
      </main>
    </div>
  );
}
