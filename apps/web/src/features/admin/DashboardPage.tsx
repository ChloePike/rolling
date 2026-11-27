import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useDashboard } from './api';
import type { DailyRow } from './types';
import styles from './Admin.module.css';

/** One series per chart (no legend; the title names it), hover shows the day and value. */
function DailyBars({ rows, value, label, format }: { rows: DailyRow[]; value: (r: DailyRow) => number; label: string; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <figure className={styles.card} style={{ margin: 0 }}>
      <figcaption className={styles.h2}>{label}</figcaption>
      <div className={styles.chart} role="img" aria-label={label}>
        {rows.map((r) => (
          <div key={r.day} className={styles.bar1} style={{ height: `${Math.max(2, (value(r) / max) * 100)}%` }} title={`${r.day}: ${format(value(r))}`} />
        ))}
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>{rows[0]?.day}</span>
        <span>{rows[rows.length - 1]?.day}</span>
      </div>
    </figure>
  );
}

/** `/admin`: product metrics (D-029). Business and generation metrics; no error-rate charts. */
export function DashboardPage() {
  const intl = useIntl();
  const [days, setDays] = useState(30);
  const q = useDashboard(days);
  const n = (v: number) => intl.formatNumber(v);
  const usd = (v: number) => intl.formatNumber(v, { style: 'currency', currency: 'USD' });
  const pct = (v: number | null) => (v === null ? '—' : intl.formatNumber(v, { style: 'percent', maximumFractionDigits: 1 }));
  const ms = (v: number | null) => (v === null ? '—' : intl.formatMessage({ id: 'admin.ms' }, { n: v }));
  if (q.isError) return <LoadError onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <>
      <div className={styles.row}>
        <h1 className={styles.h1}>
          <FormattedMessage id="admin.overview.title" />
        </h1>
        <label className={styles.field} style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' }}>
          <FormattedMessage id="admin.overview.range" />
          <select className={styles.select} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90].map((v) => (
              <option key={v} value={v}>
                {intl.formatMessage({ id: 'admin.overview.days' }, { n: v })}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!d ? (
        <div className={styles.card} aria-busy="true" style={{ height: 240 }} />
      ) : (
        <>
          <div className={styles.grid} data-testid="admin-totals">
            {(
              [
                ['signups', n(d.totals.signups)],
                ['planStarts', n(d.totals.planStarts)],
                ['activePlans', n(d.totals.activePlans)],
                ['creditsSpent', n(d.totals.creditsSpent)],
                ['revenue', usd(d.totals.revenueUsd)],
                ['gatewayCost', usd(d.totals.gatewayCostUsd + d.totals.agentCostUsd)],
                ['margin', `${usd(d.totals.marginUsd)} · ${pct(d.totals.marginPct)}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className={`${styles.card} ${styles.stat}`}>
                <span className={styles.statLabel}>
                  <FormattedMessage id={`admin.stat.${k}`} />
                </span>
                <span className={styles.statValue}>{v}</span>
              </div>
            ))}
          </div>
          <div className={styles.grid2}>
            <DailyBars rows={d.daily} value={(r) => r.signups} label={intl.formatMessage({ id: 'admin.chart.signups' })} format={n} />
            <DailyBars rows={d.daily} value={(r) => r.started} label={intl.formatMessage({ id: 'admin.chart.generations' })} format={n} />
            <DailyBars rows={d.daily} value={(r) => r.agentTurns} label={intl.formatMessage({ id: 'admin.chart.agentTurns' })} format={n} />
            <DailyBars rows={d.daily} value={(r) => r.creditsSpent} label={intl.formatMessage({ id: 'admin.chart.spend' })} format={n} />
          </div>
          <section className={styles.card}>
            <h2 className={styles.h2}>
              <FormattedMessage id="admin.models.title" />
            </h2>
            <table className={styles.table} data-testid="admin-models">
              <thead>
                <tr>
                  <th><FormattedMessage id="admin.models.model" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.started" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.success" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.credits" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.cost" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.margin" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.p50" /></th>
                  <th className={styles.num}><FormattedMessage id="admin.models.p90" /></th>
                </tr>
              </thead>
              <tbody>
                {d.models.map((r) => {
                  const revenue = r.creditsSpent / 100;
                  return (
                    <tr key={r.model}>
                      <td>{r.model}</td>
                      <td className={styles.num}>{n(r.started)}</td>
                      <td className={styles.num}>{pct(r.successRate)}</td>
                      <td className={styles.num}>{n(r.creditsSpent)}</td>
                      <td className={styles.num}>{usd(r.gatewayCostUsd)}</td>
                      <td className={styles.num}>{pct(revenue > 0 ? (revenue - r.gatewayCostUsd) / revenue : null)}</td>
                      <td className={styles.num}>{ms(r.p50Ms)}</td>
                      <td className={styles.num}>{ms(r.p90Ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <section className={styles.card}>
            <h2 className={styles.h2}>
              <FormattedMessage id="admin.latency.title" />
            </h2>
            {!d.latency.available ? (
              <p className={styles.sub}>{d.latency.reason}</p>
            ) : (
              <table className={styles.table} data-testid="admin-latency">
                <thead>
                  <tr>
                    <th><FormattedMessage id="admin.latency.colo" /></th>
                    <th className={styles.num}><FormattedMessage id="admin.latency.requests" /></th>
                    <th className={styles.num}><FormattedMessage id="admin.models.p50" /></th>
                    <th className={styles.num}><FormattedMessage id="admin.models.p90" /></th>
                  </tr>
                </thead>
                <tbody>
                  {d.latency.colos.map((c) => (
                    <tr key={c.colo}>
                      <td>{c.colo}</td>
                      <td className={styles.num}>{n(c.requests)}</td>
                      <td className={styles.num}>{ms(c.p50Ms)}</td>
                      <td className={styles.num}>{ms(c.p90Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
