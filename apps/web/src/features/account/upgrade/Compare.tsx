import { PLAN_ORDER, PLANS, type PlanConfig, type PlanId } from '@rolling/core/pricing/config';
import type { ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUsd } from '@/lib/topUp';
import type { BillingPeriod } from '../types';
import { PathIcon, paths, Swap } from '../shared';
import { howMany, type Rates } from './equivalents';
import { monthlyPrice } from './PlanCard';
import styles from './Upgrade.parts.module.css';

type Cell = (plan: PlanConfig) => ReactNode;

function Yes({ on }: { on: boolean }) {
  const intl = useIntl();
  return on ? (
    <span className={styles.yes}>
      <PathIcon d={paths.check} size={15} strokeWidth={2.6} />
      <span className="rl-visually-hidden">{intl.formatMessage({ id: 'account.upgrade.compare.yes' })}</span>
    </span>
  ) : (
    <span className={styles.no}>
      <PathIcon d={paths.minus} size={15} />
      <span className="rl-visually-hidden">{intl.formatMessage({ id: 'account.upgrade.compare.no' })}</span>
    </span>
  );
}

/** Feature comparison, every value from the plan config (D-006). */
export function Compare({ period, rates, recommended }: { period: BillingPeriod; rates: Rates; recommended: PlanId }) {
  const intl = useIntl();
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const rows: Array<{ id: string; values?: Record<string, string | number>; cell: Cell }> = [
    {
      id: 'price',
      cell: (p) => {
        const price = money(monthlyPrice(p, period));
        return (
          <Swap id={price}>
            <FormattedMessage id="account.upgrade.compare.priceValue" values={{ price }} />
          </Swap>
        );
      },
    },
    { id: 'credits', cell: (p) => intl.formatNumber(p.monthlyCredits) },
    {
      id: 'shots',
      values: { model: rates.video.name, seconds: rates.video.seconds, res: rates.video.resolution },
      cell: (p) => intl.formatNumber(howMany(p.monthlyCredits, rates.video.credits)),
    },
    { id: 'jobs', cell: (p) => intl.formatNumber(p.concurrentJobs) },
    { id: 'video', cell: (p) => p.maxVideoResolution },
    { id: 'image', cell: (p) => p.maxImageResolution },
    { id: 'voice', cell: (p) => <Yes on={p.voiceCloning} /> },
    { id: 'seats', cell: (p) => intl.formatNumber(p.seats) },
    { id: 'topUpBonus', cell: (p) => (p.topUpBonus > 0 ? `+${intl.formatNumber(p.topUpBonus, { style: 'percent' })}` : <Yes on={false} />) },
    { id: 'agent', cell: () => <Yes on /> },
    { id: 'refunds', cell: () => <Yes on /> },
    { id: 'expiry', cell: () => <Yes on /> },
  ];
  return (
    <section className={styles.compare} aria-labelledby="upgrade-compare">
      <div className={styles.sectionHead}>
        <h2 id="upgrade-compare" className={styles.h2}>
          <FormattedMessage id="account.upgrade.compare.title" />
        </h2>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.featureCol}>
                <span className="rl-visually-hidden">
                  <FormattedMessage id="account.upgrade.compare.feature" />
                </span>
              </th>
              {PLAN_ORDER.map((id) => (
                <th key={id} scope="col" data-col={id} className={id === recommended ? styles.colRec : undefined}>
                  {PLANS[id].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-row={r.id}>
                <th scope="row">
                  <FormattedMessage id={`account.upgrade.compare.${r.id}`} values={r.values} />
                </th>
                {PLAN_ORDER.map((id) => (
                  <td key={id} data-col={id} className={id === recommended ? styles.colRec : undefined}>
                    {r.cell(PLANS[id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
