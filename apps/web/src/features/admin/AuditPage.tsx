import { FormattedMessage } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useAudit } from './api';
import { useFormat } from './shared';
import styles from './Admin.module.css';

/** `/admin/audit`: the immutable admin audit log, newest first. */
export function AuditPage() {
  const f = useFormat();
  const q = useAudit();
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  return (
    <>
      <h1 className={styles.h1}><FormattedMessage id="admin.audit.title" /></h1>
      <section className={styles.card}>
        <table className={styles.table} data-testid="audit-log">
          <thead>
            <tr>
              <th><FormattedMessage id="admin.audit.when" /></th>
              <th><FormattedMessage id="admin.audit.who" /></th>
              <th><FormattedMessage id="admin.audit.action" /></th>
              <th><FormattedMessage id="admin.audit.target" /></th>
              <th><FormattedMessage id="admin.reason" /></th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <td className={styles.mono}>{f.date(r.created_at)}</td>
                <td>{r.actor_kind === 'staff' ? r.actor_id : r.actor_kind}</td>
                <td>{r.action}</td>
                <td className={styles.mono}>{r.target_kind} {r.target_id}</td>
                <td>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
