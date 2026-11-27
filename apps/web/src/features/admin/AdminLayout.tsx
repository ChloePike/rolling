import { Link, Outlet } from '@tanstack/react-router';
import { createContext, useContext } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAdminMe } from './api';
import type { AdminMe, Permission } from './types';
import styles from './Admin.module.css';

const MeContext = createContext<AdminMe | null>(null);

/** The staff caller (inside the admin layout). */
export function useStaff(): AdminMe {
  const me = useContext(MeContext);
  if (!me) throw new Error('useStaff outside the admin layout');
  return me;
}

export function useCan(p: Permission): boolean {
  return useStaff().permissions.includes(p);
}

const NAV = [
  { to: '/admin', key: 'overview', exact: true },
  { to: '/admin/accounts', key: 'accounts' },
  { to: '/admin/queue', key: 'queue' },
  { to: '/admin/ops', key: 'ops' },
  { to: '/admin/audit', key: 'audit' },
] as const;

/**
 * `/admin` (D-025): staff only. The server decides (`GET /api/admin/me` is 404
 * for everyone else); non-staff see the regular not-found state.
 */
export function AdminLayout() {
  const intl = useIntl();
  const me = useAdminMe();
  if (me.isPending) return <div className={styles.page} aria-busy="true" />;
  if (!me.data) {
    return (
      <div className={styles.page}>
        <div className={styles.state} data-testid="admin-not-found">
          <h1 className={styles.h1}>
            <FormattedMessage id="admin.notFound.title" />
          </h1>
          <p className={styles.sub}>
            <FormattedMessage id="admin.notFound.sub" />
          </p>
          <Link to="/" className={styles.link}>
            <FormattedMessage id="admin.notFound.home" />
          </Link>
        </div>
      </div>
    );
  }
  return (
    <MeContext.Provider value={me.data}>
      <div className={styles.page}>
        <header className={styles.bar}>
          <Link to="/" className={styles.brand} aria-label={intl.formatMessage({ id: 'admin.home' })}>
            <svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
              <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
            </svg>
            <FormattedMessage id="admin.title" />
          </Link>
          <nav className={styles.nav} aria-label={intl.formatMessage({ id: 'admin.nav.label' })}>
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className={styles.navItem} activeOptions={{ exact: 'exact' in n }} activeProps={{ 'data-status': 'active', 'aria-current': 'page' } as Record<string, string>}>
                <FormattedMessage id={`admin.nav.${n.key}`} />
              </Link>
            ))}
          </nav>
          <span className={styles.who}>
            <FormattedMessage id={`admin.role.${me.data.role}`} />
            {me.data.email ? ` · ${me.data.email}` : ''}
          </span>
        </header>
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </MeContext.Provider>
  );
}
