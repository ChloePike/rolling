import { PLANS, SEAT_PRICE, TOP_UP } from '@rolling/core/pricing/config';
import { useId, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUsd } from '@/lib/topUp';
import { PathIcon, paths } from '../shared';
import styles from './Upgrade.parts.module.css';

export const FAQ_IDS = ['billing', 'refunds', 'expiry', 'cancel', 'change', 'team', 'resolution'] as const;

/**
 * Accordion: each question is a button with aria-expanded; the answer opens in
 * 200ms with the standard curve and closes in 140ms with the exit curve
 * (grid-row height transition, so text never jumps). Reduced motion: opacity only.
 */
export function Faq() {
  const intl = useIntl();
  const base = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const values = {
    min: money(TOP_UP.minUsd),
    starter: PLANS.starter.maxVideoResolution,
    plus: PLANS.plus.maxVideoResolution,
    pro: PLANS.pro.maxVideoResolution,
    base: money(Number(PLANS.team.priceMonthlyUsd)),
    seat: money(SEAT_PRICE.priceMonthlyUsd),
    credits: SEAT_PRICE.monthlyCredits,
    jobs: SEAT_PRICE.concurrentJobs,
    agent: money(SEAT_PRICE.agentAllowanceUsd),
  };
  return (
    <section className={styles.faq} aria-labelledby="upgrade-faq">
      <div className={styles.sectionHead}>
        <h2 id="upgrade-faq" className={styles.h2}>
          <FormattedMessage id="account.upgrade.faq.title" />
        </h2>
      </div>
      <div className={styles.faqList}>
        {FAQ_IDS.map((id) => {
          const on = !!open[id];
          return (
            <div key={id} className={styles.faqItem} data-faq={id} data-open={on}>
              <h3 className={styles.faqH}>
                <button
                  type="button"
                  className={styles.faqQ}
                  aria-expanded={on}
                  aria-controls={`${base}-${id}`}
                  id={`${base}-${id}-q`}
                  onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
                >
                  <FormattedMessage id={`account.upgrade.faq.${id}.q`} />
                  <PathIcon d={paths.chevronDown} size={16} className={styles.faqChev} />
                </button>
              </h3>
              <div id={`${base}-${id}`} role="region" aria-labelledby={`${base}-${id}-q`} className={styles.faqA} inert={!on}>
                <div className={styles.faqAInner}>
                  <p>
                    <FormattedMessage id={`account.upgrade.faq.${id}.a`} values={values} />
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
