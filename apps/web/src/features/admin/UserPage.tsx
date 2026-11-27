import { Link } from '@tanstack/react-router';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useSuspension, useUser } from './api';
import { ReasonAction, useFormat } from './shared';
import styles from './Admin.module.css';

/** `/admin/users/$id`: memberships and plans, suspension, notices, safety events, cases. */
export function UserPage({ id }: { id: string }) {
  const intl = useIntl();
  const f = useFormat();
  const q = useUser(id);
  const suspension = useSuspension();
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return <div className={styles.card} aria-busy="true" style={{ height: 200 }} />;
  const suspended = d.suspensions.some((s) => s.lifted_at === null);
  return (
    <>
      <div className={styles.row}>
        <h1 className={styles.h1}>{d.user.email ?? d.user.id}</h1>
        <span className={styles.mono}>{d.user.id}</span>
        {suspended ? <span className={`${styles.chip} ${styles.chipUrgent}`}><FormattedMessage id="admin.suspended" /></span> : null}
      </div>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.user.workspaces" /></h2>
        <table className={styles.table}>
          <tbody>
            {d.memberships.map((m) => (
              <tr key={m.workspace_id}>
                <td><Link to="/admin/workspaces/$id" params={{ id: m.workspace_id }} className={styles.link}>{m.name}</Link></td>
                <td>{m.role}</td>
                <td>{m.plan ? intl.formatMessage({ id: `admin.plan.${m.plan}` }) : intl.formatMessage({ id: 'admin.ws.noPlan' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id={suspended ? 'admin.suspend.liftTitle' : 'admin.suspend.title'} /></h2>
        <p className={styles.sub}><FormattedMessage id="admin.suspend.sub" /></p>
        <ReasonAction testId="suspend-user-form" danger={!suspended} label={intl.formatMessage({ id: suspended ? 'admin.suspend.lift' : 'admin.suspend.apply' })} onSubmit={(reason) => suspension.mutateAsync({ subjectKind: 'user', subjectId: id, action: suspended ? 'unsuspend' : 'suspend', reason })} />
      </section>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ws.safety" /></h2>
        {d.safetyEvents.length === 0 ? (
          <p className={styles.empty}><FormattedMessage id="admin.empty" /></p>
        ) : (
          <table className={styles.table}>
            <tbody>
              {d.safetyEvents.map((e) => (
                <tr key={e.id}>
                  <td>{e.stage}</td>
                  <td>{e.codes}</td>
                  <td className={styles.mono}>{f.date(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
