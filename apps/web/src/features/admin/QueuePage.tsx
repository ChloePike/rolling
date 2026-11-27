import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useCases } from './api';
import { useStaff } from './AdminLayout';
import { Priority, useFormat } from './shared';
import styles from './Admin.module.css';

const KINDS = ['', 'child_safety', 'safety', 'report', 'appeal', 'dmca', 'counter_notice'] as const;

/** `/admin/queue`: open cases, most urgent first (child safety, then hard limits and flagged workspaces). */
export function QueuePage() {
  const intl = useIntl();
  const f = useFormat();
  const me = useStaff();
  const [kind, setKind] = useState<string>('');
  const q = useCases(me.role, kind || undefined);
  const kinds = KINDS.filter((k) => k !== 'child_safety' || me.permissions.includes('child_safety'));
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  return (
    <>
      <div className={styles.row}>
        <h1 className={styles.h1}><FormattedMessage id="admin.queue.title" /></h1>
        {q.data ? <span className={styles.sub}><FormattedMessage id="admin.queue.flagged" values={{ n: q.data.flaggedWorkspaces }} /></span> : null}
        <select className={styles.select} style={{ marginLeft: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={intl.formatMessage({ id: 'admin.queue.filter' })}>
          {kinds.map((k) => <option key={k} value={k}>{intl.formatMessage({ id: k ? `admin.kind.${k}` : 'admin.queue.all' })}</option>)}
        </select>
      </div>
      <section className={styles.card}>
        {!q.data ? (
          <div aria-busy="true" style={{ height: 160 }} />
        ) : q.data.items.length === 0 ? (
          <p className={styles.empty}><FormattedMessage id="admin.queue.empty" /></p>
        ) : (
          <table className={styles.table} data-testid="admin-queue">
            <thead>
              <tr>
                <th><FormattedMessage id="admin.queue.priority" /></th>
                <th><FormattedMessage id="admin.queue.kind" /></th>
                <th><FormattedMessage id="admin.queue.category" /></th>
                <th><FormattedMessage id="admin.queue.subject" /></th>
                <th><FormattedMessage id="admin.queue.opened" /></th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id} data-case={c.kind}>
                  <td><Priority p={c.priority} /></td>
                  <td>
                    <Link to="/admin/cases/$id" params={{ id: c.id }} className={styles.link}>
                      <FormattedMessage id={`admin.kind.${c.kind}`} />
                    </Link>
                  </td>
                  <td>{c.category ? intl.formatMessage({ id: `admin.category.${c.category}`, defaultMessage: c.category }) : ''}</td>
                  <td className={styles.mono}>{c.targetKind ? `${c.targetKind} ${c.targetId ?? ''}` : c.workspaceId}</td>
                  <td className={styles.mono}>{f.date(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
