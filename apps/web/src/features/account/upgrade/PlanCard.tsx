import { lowestPlanFor, PLANS, USD_PER_CREDIT, type PlanConfig, type PlanId } from '@rolling/core/pricing/config';
import type { CSSProperties, Ref } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUsd } from '@/lib/topUp';
import type { BillingPeriod } from '../types';
import { motion, PathIcon, paths, Swap } from '../shared';
import { equivalentFor, type Rates } from './equivalents';
import styles from './Upgrade.parts.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

export const VIDEO_STEPS = ['720p', '1080p', '4K'] as const;
export const IMAGE_STEPS = ['2K', '4K'] as const;

/** Price per month shown for a period (yearly is the yearly total over 12, to the cent). */
export function monthlyPrice(plan: PlanConfig, period: BillingPeriod): number {
  return period === 'yearly' ? Math.round((Number(plan.priceYearlyUsd) / 12) * 100) / 100 : Number(plan.priceMonthlyUsd);
}

function perks(plan: PlanConfig): Array<{ id: string; values?: Record<string, string | number> }> {
  const out: Array<{ id: string; values?: Record<string, string | number> }> = [{ id: 'account.upgrade.perk.jobs', values: { n: plan.concurrentJobs } }];
  if (plan.voiceCloning) out.push({ id: 'account.upgrade.perk.voice' });
  if (plan.seats > 1) out.push({ id: 'account.upgrade.perk.seats', values: { n: plan.seats } });
  out.push(plan.topUpBonus > 0 ? { id: 'account.upgrade.perk.topUpBonus', values: { pct: plan.topUpBonus } } : { id: 'account.upgrade.perk.topUps' });
  out.push({ id: 'account.upgrade.perk.agent' });
  return out;
}

/** Shot / image equivalent of a credit amount, as one line (never "0 shots" or a few seconds). */
export function Equivalent({ credits, rates }: { credits: number; rates: Rates }) {
  const eq = equivalentFor(credits, rates);
  if (!eq) return null;
  if (eq.unit === 'images') return <FormattedMessage id="account.upgrade.eq.imagesOnly" values={{ n: eq.n, model: eq.model }} />;
  const v = eq.rate;
  return (
    <>
      <FormattedMessage id="account.upgrade.eq.shots" values={{ n: eq.n, seconds: v.seconds, res: v.resolution, model: v.name }} />
      {rates.image && eq.images !== null && eq.images >= 1 && (
        <>
          {' '}
          <FormattedMessage id="account.upgrade.eq.images" values={{ n: eq.images, model: rates.image.name }} />
        </>
      )}
    </>
  );
}

/** Resolution steps: included ones solid with a check, higher ones dimmed with the plan that unlocks them (D-006). */
function Caps({ plan, kind }: { plan: PlanConfig; kind: 'video' | 'image' }) {
  const intl = useIntl();
  const steps = kind === 'video' ? VIDEO_STEPS : IMAGE_STEPS;
  const cap = kind === 'video' ? plan.maxVideoResolution : plan.maxImageResolution;
  const capIndex = (steps as readonly string[]).indexOf(cap);
  return (
    <div className={styles.capRow}>
      <span className={styles.capKind}>
        <FormattedMessage id={`account.upgrade.caps.${kind}`} />
      </span>
      <ul className={styles.caps} aria-label={intl.formatMessage({ id: `account.upgrade.caps.${kind}.label` }, { res: cap })}>
        {steps.map((res, i) => {
          const on = i <= capIndex;
          const unlock = on ? null : lowestPlanFor(kind, res);
          const label = on
            ? intl.formatMessage({ id: 'account.upgrade.caps.included' }, { res })
            : intl.formatMessage({ id: 'account.upgrade.caps.locked' }, { res, plan: unlock ? PLANS[unlock].label : '' });
          return (
            <li key={res} className={cx(styles.cap, on ? styles.capOn : styles.capOff)} data-cap={res} data-included={on} title={label}>
              <PathIcon d={on ? paths.check : paths.lock} size={11} strokeWidth={on ? 2.8 : 2.2} />
              {res}
              <span className="rl-visually-hidden">{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface PlanCardProps {
  id: PlanId;
  index: number;
  period: BillingPeriod;
  recommended: boolean;
  /** The signed-in workspace's active plan. */
  current: PlanId | null;
  pending: boolean;
  rates: Rates;
  onChoose: (id: PlanId) => void;
  ctaRef?: Ref<HTMLButtonElement>;
}

export function PlanCard({ id, index, period, recommended, current, pending, rates, onChoose, ctaRef }: PlanCardProps) {
  const intl = useIntl();
  const plan = PLANS[id];
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const price = money(monthlyPrice(plan, period));
  const yearlySaving = Number(plan.priceMonthlyUsd) * 12 - Number(plan.priceYearlyUsd);
  const isCurrent = current === id;
  const ctaId = isCurrent ? 'account.upgrade.cta.current' : current ? 'account.upgrade.cta.switch' : 'account.upgrade.cta';
  return (
    <section
      aria-labelledby={`plan-${id}`}
      className={cx(styles.plan, recommended && styles.recommended, motion.stagger)}
      style={{ '--i': index } as CSSProperties}
      data-plan={id}
    >
      <div className={styles.planHead}>
        <h2 id={`plan-${id}`} className={styles.planName}>
          {plan.label}
        </h2>
        {recommended && (
          <span className={styles.badge}>
            <FormattedMessage id="account.upgrade.recommended" />
          </span>
        )}
        {isCurrent && (
          <span className={styles.badgeCurrent}>
            <FormattedMessage id="account.upgrade.current" />
          </span>
        )}
      </div>
      <span className={styles.who}>
        <FormattedMessage id={`account.upgrade.plan.${id}.who`} />
      </span>
      <div className={styles.priceBlock}>
        <div className={styles.priceRow}>
          <span className={styles.price} data-testid={`price-${id}`}>
            <Swap id={price}>{price}</Swap>
          </span>
          <span className={styles.per}>
            <FormattedMessage id="account.upgrade.perMonthly" />
          </span>
        </div>
        <Swap id={period} className={styles.billed}>
          {period === 'yearly' ? (
            <span>
              <FormattedMessage id="account.upgrade.billedYearly" values={{ total: money(Number(plan.priceYearlyUsd)) }} />
              <span className={styles.save}>
                <FormattedMessage id="account.upgrade.saveYear" values={{ amount: money(yearlySaving) }} />
              </span>
            </span>
          ) : (
            <span>
              <FormattedMessage id="account.upgrade.billedMonthly" />
            </span>
          )}
        </Swap>
      </div>
      <button
        ref={ctaRef}
        type="button"
        className={cx(styles.cta, recommended && styles.ctaPrimary, recommended ? motion.press : motion.hover)}
        disabled={isCurrent || pending}
        aria-busy={pending || undefined}
        onClick={() => onChoose(id)}
      >
        {pending ? <FormattedMessage id="account.upgrade.cta.pending" /> : <FormattedMessage id={ctaId} values={{ plan: plan.label }} />}
      </button>
      <div className={styles.credits}>
        <span className={styles.creditsKey}>
          <FormattedMessage id="account.upgrade.included" />
        </span>
        <span className={styles.creditsMain}>
          <FormattedMessage id="account.upgrade.credits" values={{ credits: plan.monthlyCredits }} />
        </span>
        <span className={styles.creditsEq} data-testid={`eq-${id}`}>
          <Equivalent credits={plan.monthlyCredits} rates={rates} />
        </span>
        <span className={styles.creditsWorth}>
          <FormattedMessage id="account.upgrade.worth" values={{ worth: money(plan.monthlyCredits * USD_PER_CREDIT) }} />
        </span>
      </div>
      <div className={styles.capsBlock}>
        <Caps plan={plan} kind="video" />
        <Caps plan={plan} kind="image" />
      </div>
      <ul className={styles.feats}>
        {perks(plan).map((f) => (
          <li key={f.id} className={styles.feat}>
            <PathIcon d={paths.check} size={15} strokeWidth={2.4} />
            <span>
              <FormattedMessage id={f.id} values={f.values} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
