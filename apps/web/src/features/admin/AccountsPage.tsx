import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useSearch } from './api';
import { useFormat } from './shared';
import styles from './Admin.module.css';

/** `/admin/accounts`: search users (email, name, id) and workspaces (name, id). */
export function AccountsPage() {
  const intl = useIntl();
  const f = useFormat();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const r = useSearch(submitted);
  return (
    <>
      <h1 className={styles.h1}>
        <FormattedMessage id="admin.accounts.title" />
      </h1>
      <form
        className={styles.row}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <input className={styles.input} style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} aria-label={intl.formatMessage({ id: 'admin.accounts.search' })} placeholder={intl.formatMessage({ id: 'admin.accounts.placeholder' })} />
        <button type="submit" className={`${styles.btn} ${styles.primary}`}>
          <FormattedMessage id="admin.accounts.search" />
        </button>
      </form>
      {r.data && (
        <div className={styles.grid2}>
          <section className={styles.card}>
            <h2 className={styles.h2}>
              <FormattedMessage id="admin.accounts.users" />
            </h2>
            {r.data.users.length === 0 ? (
              <p className={styles.empty}><FormattedMessage id="admin.empty" /></p>
            ) : (
              <table className={styles.table}>
                <tbody>
                  {r.data.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <Link to="/admin/users/$id" params={{ id: u.id }} className={styles.link}>
                          {u.email}
                        </Link>
                        <div className={styles.mono}>{u.name}</div>
                      </td>
                      <td className={styles.mono}>{f.date(u.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className={styles.card}>
            <h2 className={styles.h2}>
              <FormattedMessage id="admin.accounts.workspaces" />
            </h2>
            {r.data.workspaces.length === 0 ? (
              <p className={styles.empty}><FormattedMessage id="admin.empty" /></p>
            ) : (
              <table className={styles.table}>
                <tbody>
                  {r.data.workspaces.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link to="/admin/workspaces/$id" params={{ id: w.id }} className={styles.link}>
                          {w.name}
                        </Link>
                        <div className={styles.mono}>{w.id}</div>
                      </td>
                      <td>{w.safety_flag ? <span className={`${styles.chip} ${styles.chipHigh}`}><FormattedMessage id="admin.flagged" /></span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </>
  );
}
