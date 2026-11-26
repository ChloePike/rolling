import { PERSONAL_PLAN_ORDER, PLAN_ORDER, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { useToast } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { GoogleOneTap } from '@/features/auth/GoogleOneTap';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { isApiError } from '@/lib/api/errors';
import { checkoutPlan, openBillingPortal, useSession } from '@/lib/session';
import { motion, Segmented } from './shared';
import type { BillingPeriod } from './types';
import { Compare } from './upgrade/Compare';
import { Faq } from './upgrade/Faq';
import { ModelMark } from './upgrade/ModelMark';
import { PlanCard } from './upgrade/PlanCard';
import { TeamPlan } from './upgrade/TeamPlan';
import { TopUpCalculator } from './upgrade/TopUpCalculator';
import { lowestPlanForModel, useFeaturedModels, useRates } from './upgrade/useRates';
import styles from './Upgrade.module.css';
import parts from './upgrade/Upgrade.parts.module.css';

/** Plus carries the Recommended badge (the middle personal plan, as drawn). */
export const RECOMMENDED: PlanId = PERSONAL_PLAN_ORDER[Math.floor(PERSONAL_PLAN_ORDER.length / 2)]!;

/** Shown until the catalog answers (D-002 launch models, D-009 display names), with their lowest resolution. */
const FALLBACK_MODELS = [
  { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5', kind: 'video', resolutions: ['480p', '720p', '1080p'] },
  { id: 'minimax/minimax-h3', name: 'MiniMax H3', kind: 'video', resolutions: ['768p', '1080p'] },
  { id: 'lumina/berry-1.0', name: 'Wan 3.0', kind: 'video', resolutions: ['720p', '1080p'] },
  { id: 'lumina/berry-1.0-pro', name: 'Wan 3.0 Pro', kind: 'video', resolutions: ['1080p', '4K'] },
  { id: 'bytedance/seedream-5.0-lite', name: 'Seedream 5.0 Lite', kind: 'image', resolutions: ['2K'] },
  { id: 'qwen/qwen-image-2.0', name: 'Qwen Image 2.0', kind: 'image', resolutions: ['2K'] },
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
  const models = (featured.length ? featured : FALLBACK_MODELS).map((m) => ({ id: m.id, name: m.name, plan: lowestPlanForModel(m) }));
  const navigate = useNavigate();
  const [period, setPeriod] = useState<BillingPeriod>(session.plan?.period ?? initialPeriod);
  const [pending, setPending] = useState<PlanId | null>(null);
  const plansRef = useRef<HTMLDivElement>(null);
  const recCta = useRef<HTMLButtonElement>(null);
  const yearlyDiscount = Math.max(...PLAN_ORDER.map((id) => Number(PLANS[id].yearlyDiscount) || 0));

  async function choose(id: PlanId) {
    // Signed-out visitors (the page is public): sign up first, then come back here.
    if (session.status === 'signedOut') return void navigate({ to: '/signup', search: { redirect: '/upgrade' } });
    setPending(id);
    const wasMember = session.isMember;
    try {
      await checkoutPlan(id, period, 1, { returnTo: '/upgrade' });
      toast.show({
        message: intl.formatMessage({ id: wasMember ? 'account.upgrade.toast.switched' : 'account.upgrade.toast.joined' }, { plan: PLANS[id].label }),
      });
    } catch (e) {
      // Changing a live personal plan happens in the Stripe portal (prorations, cancel).
      if (isApiError(e, 'CONFLICT')) {
        toast.show({ message: intl.formatMessage({ id: 'account.upgrade.toast.portal' }) });
        await openBillingPortal('/upgrade').catch(() => toast.show({ message: intl.formatMessage({ id: 'account.upgrade.toast.failed' }) }));
      } else if (isApiError(e, 'FORBIDDEN')) {
        toast.show({ message: intl.formatMessage({ id: 'account.upgrade.toast.ownerOnly' }) });
      } else {
        toast.show({ message: intl.formatMessage({ id: 'account.upgrade.toast.failed' }) });
      }
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
      <GoogleOneTap redirect="/upgrade" />
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
          {models.slice(0, 10).map((m, i) => (
            <li key={m.id} className={`${parts.model} ${motion.stagger}`} style={{ ['--i' as string]: i }} data-model={m.id} data-min-plan={m.plan ?? undefined}>
              <ModelMark id={m.id} name={m.name} />
              <span className={parts.modelName}>{m.name}</span>
              <span className={m.plan && m.plan !== 'starter' ? parts.modelPlanUp : parts.modelPlan}>
                {m.plan === null ? null : m.plan === 'starter' ? (
                  <FormattedMessage id="account.upgrade.models.allPlans" />
                ) : (
                  <FormattedMessage id="account.upgrade.models.fromPlan" values={{ plan: PLANS[m.plan].label }} />
                )}
              </span>
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
      <LegalLinks docs={['terms', 'privacy', 'acceptable-use']} className={styles.footLinks} linkClassName={styles.footLink} />
    </div>
  );
}
