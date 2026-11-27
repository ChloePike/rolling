import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useCase, useCaseAction } from './api';
import { Priority, ReasonAction, useFormat } from './shared';
import styles from './Admin.module.css';

/**
 * `/admin/cases/$id`. Child-safety cases (admins only) show the minimum: the
 * evidence manifest (ids, hashes, sizes; never the files or the prompt) and the
 * prefilled CyberTipline packet for a human to submit by hand.
 */
export function CasePage({ id }: { id: string }) {
  const intl = useIntl();
  const f = useFormat();
  const q = useCase(id);
  const act = useCaseAction(id);
  const [action, setAction] = useState('');
  const [scope, setScope] = useState<'user' | 'workspace'>('user');
  const [reportId, setReportId] = useState('');
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (d === null) return <p className={styles.empty}><FormattedMessage id="admin.case.missing" /></p>;
  if (!d) return <div className={styles.card} aria-busy="true" style={{ height: 200 }} />;
  const c = d.case;
  const child = c.kind === 'child_safety';
  const chosen = action || d.actions[0] || '';
  return (
    <>
      <div className={styles.row}>
        <h1 className={styles.h1}><FormattedMessage id={`admin.kind.${c.kind}`} /></h1>
        <Priority p={c.priority} />
        <span className={styles.chip} data-testid="case-status"><FormattedMessage id={`admin.status.${c.status}`} /></span>
        <span className={styles.mono}>{c.id}</span>
      </div>
      {child && (
        <p className={styles.notice} role="note">
          <FormattedMessage id="admin.case.childNote" />
        </p>
      )}
      <div className={styles.grid2}>
        <section className={`${styles.card} ${child ? styles.restricted : ''}`}>
          <h2 className={styles.h2}><FormattedMessage id="admin.case.details" /></h2>
          <table className={styles.table}>
            <tbody>
              <tr><th><FormattedMessage id="admin.queue.category" /></th><td>{c.category ? intl.formatMessage({ id: `admin.category.${c.category}`, defaultMessage: c.category }) : '—'}</td></tr>
              <tr><th><FormattedMessage id="admin.case.user" /></th><td>{d.user ? <Link to="/admin/users/$id" params={{ id: d.user.id }} className={styles.link}>{d.user.email}</Link> : '—'}</td></tr>
              <tr><th><FormattedMessage id="admin.case.workspace" /></th><td>{d.workspace ? <Link to="/admin/workspaces/$id" params={{ id: d.workspace.id }} className={styles.link}>{d.workspace.name}</Link> : '—'}</td></tr>
              <tr><th><FormattedMessage id="admin.case.target" /></th><td>{c.targetUrl ? <a href={c.targetUrl} className={styles.link} target="_blank" rel="noreferrer">{c.targetUrl}</a> : c.targetKind ? `${c.targetKind} ${c.targetId ?? ''}` : '—'}</td></tr>
              <tr><th><FormattedMessage id="admin.queue.opened" /></th><td>{f.date(c.createdAt)}</td></tr>
              {c.reporterEmail && <tr><th><FormattedMessage id="admin.case.reporter" /></th><td>{c.reporterEmail}</td></tr>}
              {c.resolution && <tr><th><FormattedMessage id="admin.case.resolution" /></th><td>{c.resolution}</td></tr>}
            </tbody>
          </table>
          {c.details && <p className={styles.notice}>{c.details}</p>}
        </section>
        <section className={styles.card}>
          <h2 className={styles.h2}><FormattedMessage id="admin.case.actions" /></h2>
          {d.actions.length === 0 ? (
            <p className={styles.empty}><FormattedMessage id="admin.case.noActions" /></p>
          ) : (
            <ReasonAction
              testId="case-action-form"
              danger={chosen === 'suspend' || chosen === 'delete_content' || chosen === 'takedown'}
              label={intl.formatMessage({ id: `admin.action.${chosen}` })}
              onSubmit={(reason) => act.mutateAsync({ action: chosen, reason, ...(chosen === 'suspend' && { scope }), ...(chosen === 'mark_submitted' && { reportId }) })}
            >
              <label className={styles.field}>
                <FormattedMessage id="admin.case.action" />
                <select className={styles.select} value={chosen} onChange={(e) => setAction(e.target.value)}>
                  {d.actions.map((a) => <option key={a} value={a}>{intl.formatMessage({ id: `admin.action.${a}` })}</option>)}
                </select>
              </label>
              {chosen === 'suspend' && (
                <label className={styles.field}>
                  <FormattedMessage id="admin.case.scope" />
                  <select className={styles.select} value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'workspace')}>
                    <option value="user">{intl.formatMessage({ id: 'admin.case.scope.user' })}</option>
                    <option value="workspace">{intl.formatMessage({ id: 'admin.case.scope.workspace' })}</option>
                  </select>
                </label>
              )}
              {chosen === 'mark_submitted' && (
                <label className={styles.field}>
                  <FormattedMessage id="admin.case.reportId" />
                  <input className={styles.input} value={reportId} onChange={(e) => setReportId(e.target.value)} required />
                </label>
              )}
            </ReasonAction>
          )}
        </section>
      </div>
      {child && (
        <>
          <section className={`${styles.card} ${styles.restricted}`}>
            <h2 className={styles.h2}><FormattedMessage id="admin.case.evidence" /></h2>
            <table className={styles.table} data-testid="evidence-manifest">
              <tbody>
                {d.evidence.map((e) => (
                  <tr key={e.id}>
                    <td className={styles.mono}>{e.id}</td>
                    <td>{e.kind}</td>
                    <td className={styles.mono}>{e.contentType}</td>
                    <td className={styles.num}>{e.size === null ? '—' : intl.formatNumber(e.size, { style: 'unit', unit: 'byte', unitDisplay: 'narrow' })}</td>
                    <td className={styles.mono}>{e.sha256}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className={styles.card}>
            <h2 className={styles.h2}><FormattedMessage id="admin.case.packet" /></h2>
            <p className={styles.sub}><FormattedMessage id="admin.case.packetSub" /></p>
            <pre className={styles.pre} data-testid="ncmec-packet">{JSON.stringify(c.data.packet ?? null, null, 2)}</pre>
            <a className={styles.link} href="https://report.cybertip.org/" target="_blank" rel="noreferrer"><FormattedMessage id="admin.case.openCybertip" /></a>
          </section>
        </>
      )}
      {d.events.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.h2}><FormattedMessage id="admin.ws.safety" /></h2>
          <table className={styles.table}>
            <tbody>
              {d.events.map((e) => (
                <tr key={e.id}>
                  <td>{e.stage}</td>
                  <td>{Array.isArray(e.codes) ? e.codes.join(', ') : String(e.codes)}</td>
                  <td>{e.excerpt ?? ''}</td>
                  <td className={styles.mono}>{f.date(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
