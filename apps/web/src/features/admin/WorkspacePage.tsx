import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useAdjustCredits, useGrantPlan, useRefundRun, useSuspension, useWorkspace } from './api';
import { useCan } from './AdminLayout';
import { ReasonAction, useFormat } from './shared';
import styles from './Admin.module.css';

const PLANS = ['starter', 'plus', 'pro', 'team'] as const;

/** `/admin/workspaces/$id`: plan, balance, ledger, runs, safety events; comp plans, credits, refunds, suspension. */
export function WorkspacePage({ id }: { id: string }) {
  const intl = useIntl();
  const f = useFormat();
  const q = useWorkspace(id);
  const canCredits = useCan('credits');
  const canPlans = useCan('plans');
  const adjust = useAdjustCredits(id);
  const grant = useGrantPlan(id);
  const refund = useRefundRun();
  const suspension = useSuspension();
  const [amount, setAmount] = useState('');
  const [plan, setPlan] = useState<(typeof PLANS)[number]>('pro');
  const [months, setMonths] = useState('1');
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return <div className={styles.card} aria-busy="true" style={{ height: 200 }} />;
  const suspended = d.suspensions.some((s) => s.lifted_at === null);
  return (
    <>
      <div className={styles.row}>
        <h1 className={styles.h1}>{d.workspace.name}</h1>
        <span className={styles.mono}>{d.workspace.id}</span>
        {d.workspace.safety_flag ? <span className={`${styles.chip} ${styles.chipHigh}`}><FormattedMessage id="admin.flagged" /></span> : null}
        {suspended ? <span className={`${styles.chip} ${styles.chipUrgent}`}><FormattedMessage id="admin.suspended" /></span> : null}
      </div>
      <div className={styles.grid} data-testid="admin-balance">
        <div className={`${styles.card} ${styles.stat}`}>
          <span className={styles.statLabel}><FormattedMessage id="admin.ws.plan" /></span>
          <span className={styles.statValue}>{d.plan ? intl.formatMessage({ id: `admin.plan.${d.plan}` }) : intl.formatMessage({ id: 'admin.ws.noPlan' })}</span>
        </div>
        {(['plan', 'purchased', 'held'] as const).map((k) => (
          <div key={k} className={`${styles.card} ${styles.stat}`}>
            <span className={styles.statLabel}><FormattedMessage id={`admin.balance.${k}`} /></span>
            <span className={styles.statValue} data-testid={`balance-${k}`}>{f.n(d.balance[k])}</span>
          </div>
        ))}
      </div>
      <div className={styles.grid2}>
        {canCredits && (
          <section className={styles.card}>
            <h2 className={styles.h2}><FormattedMessage id="admin.credits.title" /></h2>
            <p className={styles.sub}><FormattedMessage id="admin.credits.sub" /></p>
            <ReasonAction testId="adjust-form" label={intl.formatMessage({ id: 'admin.credits.apply' })} onSubmit={(reason) => adjust.mutateAsync({ amount: Number(amount), reason }).then(() => setAmount(''))}>
              <label className={styles.field}>
                <FormattedMessage id="admin.credits.amount" />
                <input className={styles.input} type="number" step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </label>
            </ReasonAction>
          </section>
        )}
        {canPlans && (
          <section className={styles.card}>
            <h2 className={styles.h2}><FormattedMessage id="admin.grant.title" /></h2>
            <ReasonAction label={intl.formatMessage({ id: 'admin.grant.apply' })} onSubmit={(reason) => grant.mutateAsync({ planId: plan, months: Number(months), seats: 1, extraCredits: 0, reason })}>
              <div className={styles.row}>
                <label className={styles.field}>
                  <FormattedMessage id="admin.ws.plan" />
                  <select className={styles.select} value={plan} onChange={(e) => setPlan(e.target.value as (typeof PLANS)[number])}>
                    {PLANS.map((p) => <option key={p} value={p}>{intl.formatMessage({ id: `admin.plan.${p}` })}</option>)}
                  </select>
                </label>
                <label className={styles.field}>
                  <FormattedMessage id="admin.grant.months" />
                  <input className={styles.input} type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} />
                </label>
              </div>
            </ReasonAction>
          </section>
        )}
        <section className={styles.card}>
          <h2 className={styles.h2}><FormattedMessage id={suspended ? 'admin.suspend.liftTitle' : 'admin.suspend.title'} /></h2>
          <p className={styles.sub}><FormattedMessage id="admin.suspend.sub" /></p>
          <ReasonAction testId="suspend-form" danger={!suspended} label={intl.formatMessage({ id: suspended ? 'admin.suspend.lift' : 'admin.suspend.apply' })} onSubmit={(reason) => suspension.mutateAsync({ subjectKind: 'workspace', subjectId: id, action: suspended ? 'unsuspend' : 'suspend', reason })} />
        </section>
      </div>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ws.members" /></h2>
        <table className={styles.table}>
          <tbody>
            {d.members.map((m) => (
              <tr key={m.user_id}>
                <td><Link to="/admin/users/$id" params={{ id: m.user_id }} className={styles.link}>{m.email ?? m.user_id}</Link></td>
                <td>{m.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ws.runs" /></h2>
        <table className={styles.table} data-testid="admin-runs">
          <thead>
            <tr>
              <th><FormattedMessage id="admin.ws.run" /></th>
              <th><FormattedMessage id="admin.ws.status" /></th>
              <th className={styles.num}><FormattedMessage id="admin.ws.spent" /></th>
              <th className={styles.num}><FormattedMessage id="admin.ws.refunded" /></th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.id}>
                <td>{r.title ?? r.id}<div className={styles.mono}>{r.id} · {f.date(r.created_at)}</div></td>
                <td>{r.status}</td>
                <td className={styles.num}>{f.n(r.credits_spent)}</td>
                <td className={styles.num}>{f.n(r.credits_refunded)}</td>
                <td>
                  {canCredits && r.credits_spent > 0 && r.credits_refunded < r.credits_spent && (
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => {
                        const reason = window.prompt(intl.formatMessage({ id: 'admin.refund.prompt' }));
                        if (reason && reason.trim().length >= 3) void refund.mutateAsync({ runId: r.id, reason: reason.trim() });
                      }}
                    >
                      <FormattedMessage id="admin.refund.button" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className={styles.card}>
        <h2 className={styles.h2}><FormattedMessage id="admin.ws.ledger" /></h2>
        <table className={styles.table} data-testid="admin-ledger">
          <tbody>
            {d.ledger.map((l) => (
              <tr key={l.id}>
                <td>{l.kind}</td>
                <td>{l.bucket}</td>
                <td className={styles.num}>{f.n(l.amount)}</td>
                <td className={styles.mono}>{l.note ?? l.runId ?? ''}</td>
                <td className={styles.mono}>{f.date(l.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
                  <td>{e.codes.join(', ')}</td>
                  <td>{e.hard ? <span className={`${styles.chip} ${styles.chipHigh}`}><FormattedMessage id="admin.hard" /></span> : null}</td>
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
