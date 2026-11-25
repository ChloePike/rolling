import { PERSONAL_PLAN_ORDER, PLAN_ORDER, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { useToast } from '@rolling/ui';
import { useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { checkoutPlan, useSession } from '@/lib/session';
import { motion, Segmented } from './shared';
import type { BillingPeriod } from './types';
import { Compare } from './upgrade/Compare';
import { Faq } from './upgrade/Faq';
import { ModelMark } from './upgrade/ModelMark';
import { PlanCard } from './upgrade/PlanCard';
import { TeamPlan } from './upgrade/TeamPlan';
import { TopUpCalculator } from './upgrade/TopUpCalculator';
import { useFeaturedModels, useRates } from './upgrade/useRates';
import styles from './Upgrade.module.css';
import parts from './upgrade/Upgrade.parts.module.css';

/** Plus carries the Recommended badge (the middle personal plan, as drawn). */
export const RECOMMENDED: PlanId = PERSONAL_PLAN_ORDER[Math.floor(PERSONAL_PLAN_ORDER.length / 2)]!;

/** Names shown until the catalog answers (D-002 launch models). */
const FALLBACK_MODELS = [
  { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5' },
  { id: 'minimax/minimax-h3', name: 'MiniMax H3' },
  { id: 'alibaba/wan3.0', name: 'Wan 3.0' },
  { id: 'bytedance/seedream-5.0-lite', name: 'Seedream 5.0 Lite' },
  { id: 'qwen/qwen-image-2.0', name: 'Wan 2.7 Image' },
];

/**
 * `/upgrade`. Starts from Upgrade.dc.html and goes further on purpose (D-006:
 * plans are the entry ticket, top-ups are the product): plan cards with what
 * the included credits buy and the resolution caps, an any-amount top-up
 * calculator with the tier ladder, a comparison table, the model row and FAQ.
 */
export function UpgradePage({ initialPeriod = 'monthly' }: { initialPeriod?: BillingPeriod }) {
  const intl = useIntl();
  const toast = useToast();
  const session = useSession();
  const rates = useRates();
  const featured = useFeaturedModels();
  const models = featured.length ? featured.map((m) => ({ id: m.id, name: m.name })) : FALLBACK_MODELS;
  const [period, setPeriod] = useState<BillingPeriod>(session.plan?.period ?? initialPeriod);
  const [pending, setPending] = useState<PlanId | null>(null);
  const plansRef = useRef<HTMLDivElement>(null);
  const recCta = useRef<HTMLButtonElement>(null);
  const yearlyDiscount = Math.max(...PLAN_ORDER.map((id) => Number(PLANS[id].yearlyDiscount) || 0));

  async function choose(id: PlanId) {
    setPending(id);
    const wasMember = session.isMember;
    try {
      await checkoutPlan(id, period);
      toast.show({
        message: intl.formatMessage({ id: wasMember ? 'account.upgrade.toast.switched' : 'account.upgrade.toast.joined' }, { plan: PLANS[id].label }),
      });
    } finally {
      setPending(null);
    }
  }

  function toPlans(id: PlanId | null) {
    if (id) return void choose(id);
    plansRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    recCta.current?.focus({ preventScroll: true });
  }

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
            { value: 'monthly', label: <FormattedMessage id="account.upgrade.period.monthly" /> },
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

      <div className={styles.plans} ref={plansRef} id="plans">
        {PERSONAL_PLAN_ORDER.map((id, i) => (
          <PlanCard
            key={id}
            id={id}
            index={i}
            period={period}
            recommended={id === RECOMMENDED}
            current={session.planId}
            pending={pending === id}
            rates={rates}
            onChoose={(p) => void choose(p)}
            ctaRef={id === RECOMMENDED ? recCta : undefined}
          />
        ))}
      </div>

      <TeamPlan period={period} index={PERSONAL_PLAN_ORDER.length} />

      <section className={parts.models} aria-labelledby="upgrade-models">
        <div className={parts.modelsText}>
          <h2 id="upgrade-models" className={parts.h3}>
            <FormattedMessage id="account.upgrade.models.title" />
          </h2>
          <span className={parts.sectionLead}>
            <FormattedMessage id="account.upgrade.models.lead" />
          </span>
        </div>
        <ul className={parts.modelList}>
          {models.slice(0, 8).map((m, i) => (
            <li key={m.id} className={`${parts.model} ${motion.stagger}`} style={{ ['--i' as string]: i }} data-model={m.id}>
              <ModelMark id={m.id} name={m.name} />
              {m.name}
            </li>
          ))}
        </ul>
      </section>

      <TopUpCalculator key={session.planId ?? 'guest'} rates={rates} memberPlan={session.planId} onPickPlan={toPlans} />

      <Compare period={period} rates={rates} recommended={RECOMMENDED} />

      <Faq />

      <p className={styles.foot}>
        <FormattedMessage id="account.upgrade.foot" />
      </p>
    </div>
  );
}
