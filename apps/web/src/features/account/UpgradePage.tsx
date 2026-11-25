import { PLAN_ORDER, PLANS, TOP_UP, USD_PER_CREDIT, type PlanConfig, type PlanId } from '@rolling/core/pricing/config';
import { useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { motion, PathIcon, paths, Segmented } from './shared';
import { formatUsd, useTopUps } from './api';
import type { BillingPeriod } from './types';
import styles from './Upgrade.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** The middle plan carries the Recommended badge, as drawn. */
const RECOMMENDED: PlanId = PLAN_ORDER[Math.floor(PLAN_ORDER.length / 2)]!;
/** Perks first (D-006: plans are the entry ticket), derived from the plan config. */
function perks(plan: PlanConfig): Array<{ id: string; values?: Record<string, string | number> }> {
  const out: Array<{ id: string; values?: Record<string, string | number> }> = [
    { id: 'account.upgrade.perk.jobs', values: { n: plan.concurrentJobs } },
    { id: 'account.upgrade.perk.resolution', values: { video: plan.maxVideoResolution, image: plan.maxImageResolution } },
  ];
  if (plan.voiceCloning) out.push({ id: 'account.upgrade.perk.voice' });
  if (plan.seats > 1) out.push({ id: 'account.upgrade.perk.seats', values: { n: plan.seats } });
  out.push(plan.topUpBonus > 0 ? { id: 'account.upgrade.perk.topUpBonus', values: { pct: plan.topUpBonus } } : { id: 'account.upgrade.perk.packs' });
  return out;
}

/** `/upgrade` (Upgrade.dc.html): monthly / yearly plans, rules, credit packs. */
export function UpgradePage({ initialPeriod = 'monthly' }: { initialPeriod?: BillingPeriod }) {
  const intl = useIntl();
  const [period, setPeriod] = useState<BillingPeriod>(initialPeriod);
  const { data: packs = [] } = useTopUps(null);
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const yearlyDiscount = Math.max(...PLAN_ORDER.map((id) => Number(PLANS[id].yearlyDiscount) || 0));

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.title}>
          <FormattedMessage id="account.upgrade.title" />
        </h1>
        <p className={styles.lead}>
          <FormattedMessage id="account.upgrade.lead" />
        </p>
        <Segmented
          kind="tablist"
          label={intl.formatMessage({ id: 'account.upgrade.period' })}
          value={period}
          onChange={setPeriod}
          className={styles.periods}
          optionClassName={styles.period}
          indicatorClassName={styles.periodFill}
          options={[
            {
              value: 'monthly',
              label: (
                <>
                  <FormattedMessage id="account.upgrade.period.monthly" />
                  <span className={styles.periodNote} />
                </>
              ),
            },
            {
              value: 'yearly',
              label: (
                <>
                  <FormattedMessage id="account.upgrade.period.yearly" />
                  <span className={styles.periodNote}>
                    <FormattedMessage id="account.upgrade.period.save" values={{ pct: yearlyDiscount }} />
                  </span>
                </>
              ),
            },
          ]}
        />
      </div>

      <div className={styles.plans}>
        {PLAN_ORDER.map((id, i) => {
          const plan = PLANS[id];
          const rec = id === RECOMMENDED;
          const monthly = Number(plan.priceMonthlyUsd);
          const yearly = Number(plan.priceYearlyUsd);
          const perMonth = period === 'yearly' ? Math.round((yearly / 12) * 100) / 100 : monthly;
          return (
            <section
              key={id}
              aria-labelledby={`plan-${id}`}
              className={cx(styles.plan, rec && styles.recommended, motion.stagger)}
              style={{ '--i': i } as CSSProperties}
            >
              <div className={styles.planHead}>
                <h2 id={`plan-${id}`} className={styles.planName}>
                  {plan.label}
                </h2>
                {rec && (
                  <span className={styles.badge}>
                    <FormattedMessage id="account.upgrade.recommended" />
                  </span>
                )}
              </div>
              <span className={styles.who}>
                <FormattedMessage id={`account.upgrade.plan.${id}.who`} />
              </span>
              <div className={styles.priceRow}>
                <span className={styles.price}>{money(perMonth)}</span>
                <span key={period} className={cx(styles.per, motion.enter)}>
                  {period === 'yearly' ? (
                    <FormattedMessage id="account.upgrade.perYearly" values={{ total: money(yearly) }} />
                  ) : (
                    <FormattedMessage id="account.upgrade.perMonthly" />
                  )}
                </span>
              </div>
              <div className={styles.credits}>
                <span className={styles.creditsMain}>
                  <FormattedMessage id="account.upgrade.bonusCredits" values={{ credits: plan.monthlyCredits }} />
                </span>
                <span className={styles.creditsEq}>
                  <FormattedMessage id="account.upgrade.bonusWorth" values={{ worth: money(plan.monthlyCredits * USD_PER_CREDIT) }} />
                </span>
              </div>
              <button type="button" className={cx(styles.cta, rec && styles.ctaPrimary, rec ? motion.press : motion.hover)}>
                <FormattedMessage id="account.upgrade.cta" values={{ plan: plan.label }} />
              </button>
              <div className={styles.feats}>
                {perks(plan).map((f) => (
                  <div key={f.id} className={styles.feat}>
                    <PathIcon d={paths.check} size={15} strokeWidth={2.4} />
                    <span>
                      <FormattedMessage id={f.id} values={f.values} />
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <section className={styles.rules} aria-label={intl.formatMessage({ id: 'account.upgrade.rules' })}>
        {(['planFirst', 'purchasedStay', 'failedFree'] as const).map((r) => (
          <div key={r} className={styles.rule}>
            <span className={styles.ruleTitle}>
              <FormattedMessage id={`account.upgrade.rule.${r}.title`} />
            </span>
            <span className={styles.ruleText}>
              <FormattedMessage id={`account.upgrade.rule.${r}.text`} />
            </span>
          </div>
        ))}
      </section>

      <section className={styles.packs} aria-labelledby="upgrade-packs">
        <div className={styles.packsHead}>
          <h2 id="upgrade-packs" className={styles.h2}>
            <FormattedMessage id="account.packs.title" />
          </h2>
          <span className={styles.muted}>
            <FormattedMessage id="account.packs.lead" />
          </span>
        </div>
        <div className={styles.packGrid}>
          {packs.map((p) => {
            const bonus = p.bonusRate;
            return (
              <div key={p.id} className={styles.pack} data-topup={p.amountUsd}>
                <span className={styles.packText}>
                  <span className={styles.packCredits}>
                    <FormattedMessage id="account.packs.credits" values={{ credits: p.credits }} />
                  </span>
                  <span className={styles.packEq}>
                    {bonus > 0.001 ? (
                      <FormattedMessage id="account.packs.bonus" values={{ pct: bonus }} />
                    ) : (
                      <FormattedMessage id="account.packs.noExpiry" />
                    )}
                  </span>
                </span>
                <span className={styles.packPrice}>{money(p.amountUsd)}</span>
              </div>
            );
          })}
        </div>
        <span className={styles.note}>
          <FormattedMessage
            id="account.packs.note"
            values={{
              min: money(TOP_UP.minUsd),
              bonuses: intl.formatList(
                PLAN_ORDER.filter((id) => PLANS[id].topUpBonus > 0).map((id) =>
                  intl.formatMessage({ id: 'account.packs.note.plan' }, { plan: PLANS[id].label, pct: PLANS[id].topUpBonus }),
                ),
              ),
            }}
          />
        </span>
      </section>
      <p className={styles.foot}>
        <FormattedMessage id="account.upgrade.foot" />
      </p>
    </div>
  );
}
