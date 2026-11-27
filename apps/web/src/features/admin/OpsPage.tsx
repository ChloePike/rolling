import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useBreakerReset, useIncident, useOpsStatus } from './api';
import { useCan } from './AdminLayout';
import { ReasonAction, useFormat } from './shared';
import styles from './Admin.module.css';

/** `/admin/ops`: component status, gateway breaker, incident banner, nightly backups. */
export function OpsPage() {
  const intl = useIntl();
  const f = useFormat();
  const q = useOpsStatus();
  const canOps = useCan('ops');
  const incident = useIncident();
  const reset = useBreakerReset();
  const [message, setMessage] = useState<string | null>(null);
  const [level, setLevel] = useState<'info' | 'degraded' | 'outage'>('degraded');
  const [saved, setSaved] = useState(false);
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return <div className={styles.card} aria-busy="true" style={{ height: 200 }} />;
  const text = message ?? d.incident?.message ?? '';
  return (
    <>
      <h1 className={styles.h1}><FormattedMessage id="admin.ops.title" /></h1>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ops.components" /></h2>
        <table className={styles.table} data-testid="ops-components">
          <tbody>
            {d.components.map((c) => (
              <tr key={c.id}>
                <td><FormattedMessage id={`status.component.${c.id}`} /></td>
                <td><span className={`${styles.chip} ${c.status === 'operational' ? styles.chipOk : c.status === 'down' ? styles.chipUrgent : styles.chipHigh}`}><FormattedMessage id={`status.state.${c.status}`} /></span></td>
                <td className={styles.num}>{c.latencyMs === null ? '—' : intl.formatMessage({ id: 'admin.ms' }, { n: c.latencyMs })}</td>
                <td className={styles.mono}>{f.date(c.checkedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.row}>
          <span className={styles.sub}><FormattedMessage id={`admin.ops.breaker.${d.generation.breaker}`} /></span>
        </div>
        {canOps && d.generation.breaker !== 'closed' && <ReasonAction label={intl.formatMessage({ id: 'admin.ops.breaker.reset' })} onSubmit={(reason) => reset.mutateAsync({ reason })} />}
      </section>
      {canOps && (
        <section className={styles.card}>
          <h2 className={styles.h2}><FormattedMessage id="admin.ops.incident" /></h2>
          <p className={styles.sub}><FormattedMessage id="admin.ops.incidentSub" /></p>
          <form
            className={styles.form}
            data-testid="incident-form"
            onSubmit={(e) => {
              e.preventDefault();
              setSaved(false);
              void incident.mutateAsync({ message: text, level }).then(() => setSaved(true));
            }}
          >
            <label className={styles.field}>
              <FormattedMessage id="admin.ops.incidentText" />
              <textarea className={styles.textarea} maxLength={280} value={text} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <label className={styles.field}>
              <FormattedMessage id="admin.ops.level" />
              <select className={styles.select} value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
                {(['info', 'degraded', 'outage'] as const).map((l) => <option key={l} value={l}>{intl.formatMessage({ id: `admin.ops.level.${l}` })}</option>)}
              </select>
            </label>
            <div className={styles.row}>
              <button type="submit" className={`${styles.btn} ${styles.primary}`}><FormattedMessage id={text ? 'admin.ops.publish' : 'admin.ops.clear'} /></button>
              {saved && <span role="status" className={styles.sub}><FormattedMessage id="admin.action.done" /></span>}
            </div>
          </form>
        </section>
      )}
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ops.backups" /></h2>
        <table className={styles.table}>
          <tbody>
            {d.backups.map((b) => (
              <tr key={String(b.id)}>
                <td>{String(b.id)}</td>
                <td>{String(b.status)}</td>
                <td className={styles.num}><FormattedMessage id="admin.ops.backupCounts" values={{ credits: Number(b.credit_accounts), projects: Number(b.project_rooms) }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
