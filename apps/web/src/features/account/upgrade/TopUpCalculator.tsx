import { PERSONAL_PLAN_ORDER, PLANS, quoteTopUp, TOP_UP, type PlanId } from '@rolling/core/pricing/config';
import { useToast } from '@rolling/ui';
import { useId, useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUsd, parseTopUpAmount } from '@/lib/topUp';
import { useBuyTopUp } from '../api';
import { motion, Segmented, Swap } from '../shared';
import { Equivalent } from './PlanCard';
import type { Rates } from './equivalents';
import styles from './Upgrade.parts.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** The slider covers $10–$1,000 on a log scale; larger amounts are typed. */
const SLIDER_MAX_USD = 1000;
const toSlider = (usd: number) => Math.round((Math.log(Math.min(Math.max(usd, TOP_UP.minUsd), SLIDER_MAX_USD) / TOP_UP.minUsd) / Math.log(SLIDER_MAX_USD / TOP_UP.minUsd)) * 1000);
const fromSlider = (pos: number) => {
  const usd = TOP_UP.minUsd * Math.pow(SLIDER_MAX_USD / TOP_UP.minUsd, pos / 1000);
  return usd < 100 ? Math.round(usd) : Math.round(usd / 5) * 5;
};

export interface TopUpCalculatorProps {
  rates: Rates;
  /** The member's plan, or null for non-members (top-ups are members only, D-007). */
  memberPlan: PlanId | null;
  /** Non-members and plan previews go to the plan cards / checkout. */
  onPickPlan: (id: PlanId | null) => void;
}

/**
 * Any-amount top-up calculator (D-006): base credits, the amount tier bonus
 * and the plan bonus, live from `quoteTopUp`; the tier ladder shows where the
 * amount sits and what the next tier adds.
 */
export function TopUpCalculator({ rates, memberPlan, onPickPlan }: TopUpCalculatorProps) {
  const intl = useIntl();
  const toast = useToast();
  const buy = useBuyTopUp();
  const fieldId = useId();
  const lineId = useId();
  const [text, setText] = useState('50');
  const [preview, setPreview] = useState<PlanId>(memberPlan ?? 'plus');
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const parsed = parseTopUpAmount(text);
  const usd = parsed && 'usd' in parsed ? parsed.usd : null;
  const error = parsed && 'error' in parsed ? parsed.error : parsed === null ? 'min' : null;
  const q = usd !== null ? quoteTopUp(Math.round(usd * 100), preview) : null;
  const tierIndex = q ? TOP_UP.tiers.reduce((at, t, i) => (usd! >= t.minUsd ? i : at), -1) : -1;
  const next = tierIndex >= 0 ? TOP_UP.tiers[tierIndex + 1] : TOP_UP.tiers[0];
  const tierCredits = q ? Math.floor(q.baseCredits * q.tierBonus) : 0;
  const planCredits = q ? q.bonusCredits - tierCredits : 0;

  async function purchase() {
    if (usd === null) return;
    if (!memberPlan) return onPickPlan(null);
    if (preview !== memberPlan) return onPickPlan(preview);
    try {
      const r = await buy.mutateAsync(usd);
      toast.show({ message: intl.formatMessage({ id: 'account.topUps.bought' }, { n: r.credits }) });
    } catch {
      toast.show({ message: intl.formatMessage({ id: 'account.topUps.failed' }), action: { label: intl.formatMessage({ id: 'account.retry' }), onAction: () => void purchase() } });
    }
  }

  const cta = !memberPlan
    ? intl.formatMessage({ id: 'account.topUps.joinFirst' })
    : preview !== memberPlan
      ? intl.formatMessage({ id: 'account.topUps.switch' }, { plan: PLANS[preview].label })
      : buy.isPending
        ? intl.formatMessage({ id: 'account.topUps.buying' })
        : q
          ? intl.formatMessage({ id: 'account.topUps.buy' }, { n: q.credits, price: money(usd!) })
          : intl.formatMessage({ id: 'account.settings.billing.buy' });

  return (
    <section className={styles.calc} aria-labelledby="upgrade-topUps" data-testid="topup-calculator">
      <div className={styles.sectionHead}>
        <h2 id="upgrade-topUps" className={styles.h2}>
          <FormattedMessage id="account.topUps.title" />
        </h2>
        <p className={styles.sectionLead}>
          <FormattedMessage id="account.topUps.lead" />
        </p>
      </div>
      <div className={styles.calcGrid}>
        <div className={styles.calcInputs}>
          <label htmlFor={fieldId} className={styles.fieldLabel}>
            <FormattedMessage id="account.topUps.amount" />
          </label>
          <span className={styles.amountField} data-invalid={!!(parsed && 'error' in parsed)}>
            <span aria-hidden="true">$</span>
            <input
              id={fieldId}
              inputMode="decimal"
              className={styles.amountInput}
              value={text}
              aria-invalid={!!(parsed && 'error' in parsed)}
              aria-describedby={lineId}
              onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </span>
          <span className={styles.sliderWrap}>
            <span className={styles.sliderTrack} />
            <span className={styles.sliderFill} style={{ width: `${toSlider(usd ?? TOP_UP.minUsd) / 10}%` } as CSSProperties} />
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={1000}
              step={1}
              value={toSlider(usd ?? TOP_UP.minUsd)}
              aria-label={intl.formatMessage({ id: 'account.topUps.slider' })}
              aria-valuetext={usd !== null ? money(usd) : undefined}
              onChange={(e) => setText(String(fromSlider(Number(e.target.value))))}
            />
          </span>
          <div role="group" aria-label={intl.formatMessage({ id: 'account.topUps.presets' })} className={styles.presets}>
            {TOP_UP.presetsUsd.map((p) => (
              <button key={p} type="button" className={styles.preset} aria-pressed={usd === p} onClick={() => setText(String(p))} data-preset={p}>
                {money(p)}
              </button>
            ))}
          </div>
          <span id={lineId} className={cx(styles.fieldLine, parsed !== null && 'error' in parsed && styles.fieldError)} role={parsed && 'error' in parsed ? 'alert' : undefined}>
            {parsed && 'error' in parsed ? (
              <FormattedMessage id={`account.settings.billing.custom.${error}`} values={{ min: money(TOP_UP.minUsd), max: money(TOP_UP.maxUsd) }} />
            ) : (
              <FormattedMessage id="account.topUps.range" values={{ min: money(TOP_UP.minUsd), max: money(TOP_UP.maxUsd) }} />
            )}
          </span>

          <span className={styles.fieldLabel} id="ladder-label">
            <FormattedMessage id="account.topUps.ladder" />
          </span>
          <ol className={styles.ladder} aria-labelledby="ladder-label">
            {TOP_UP.tiers.map((t, i) => (
              <li key={t.minUsd} className={cx(styles.rung, i <= tierIndex && styles.rungReached, i === tierIndex && styles.rungOn)} data-tier={t.minUsd} aria-current={i === tierIndex ? 'step' : undefined}>
                <span className={styles.rungBar} />
                <span className={styles.rungPct}>
                  {t.bonus > 0 ? <FormattedMessage id="account.topUps.tierBonus" values={{ pct: t.bonus }} /> : <FormattedMessage id="account.topUps.tierNone" />}
                </span>
                <span className={styles.rungMin}>
                  <FormattedMessage id="account.topUps.tier" values={{ min: money(t.minUsd) }} />
                </span>
              </li>
            ))}
          </ol>
          <span className={styles.nextTier} data-testid="next-tier">
            {q && next ? (
              <FormattedMessage id="account.topUps.next" values={{ more: money(Math.round((next.minUsd - usd!) * 100) / 100), pct: next.bonus }} />
            ) : q ? (
              <FormattedMessage id="account.topUps.topTier" />
            ) : null}
          </span>

          <span className={styles.fieldLabel}>
            <FormattedMessage id="account.topUps.planBonus" />
          </span>
          <Segmented<PlanId>
            label={intl.formatMessage({ id: 'account.topUps.planBonus' })}
            value={preview}
            onChange={setPreview}
            className={styles.planSeg}
            optionClassName={styles.planSegOption}
            indicatorClassName={styles.planSegFill}
            options={(memberPlan === 'team' ? [...PERSONAL_PLAN_ORDER, 'team' as const] : PERSONAL_PLAN_ORDER).map((id) => ({
              value: id,
              label: (
                <>
                  {PLANS[id].label}
                  <span className={styles.planSegPct}>
                    <FormattedMessage id="account.topUps.tierBonus" values={{ pct: PLANS[id].topUpBonus }} />
                  </span>
                </>
              ),
            }))}
          />
        </div>

        <div className={styles.calcResult} aria-live="polite">
          <span className={styles.resultKey}>
            <FormattedMessage id="account.topUps.total" />
          </span>
          <span className={styles.resultTotal} data-testid="topup-total">
            <Swap id={q ? String(q.credits) : 'none'}>{q ? intl.formatNumber(q.credits) : '—'}</Swap>
          </span>
          <span className={styles.resultUnit}>
            <FormattedMessage id="account.topUps.creditsUnit" values={{ n: q?.credits ?? 0 }} />
          </span>
          <dl className={styles.breakdown}>
            <div>
              <dt>
                <FormattedMessage id="account.topUps.base" />
              </dt>
              <dd data-testid="topup-base">{q ? intl.formatNumber(q.baseCredits) : '—'}</dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="account.topUps.amountBonus" values={{ pct: q?.tierBonus ?? 0 }} />
              </dt>
              <dd data-testid="topup-tier">{q ? `+${intl.formatNumber(tierCredits)}` : '—'}</dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="account.topUps.planBonusRow" values={{ plan: PLANS[preview].label, pct: PLANS[preview].topUpBonus }} />
              </dt>
              <dd data-testid="topup-plan">{q ? `+${intl.formatNumber(planCredits)}` : '—'}</dd>
            </div>
          </dl>
          <span className={styles.resultEq}>{q && <Equivalent credits={q.credits} rates={rates} />}</span>
          <button type="button" className={cx(styles.cta, styles.ctaPrimary, motion.press)} disabled={!q || buy.isPending} aria-busy={buy.isPending || undefined} onClick={() => void purchase()} data-testid="topup-buy">
            {cta}
          </button>
          <span className={styles.resultNote}>
            {memberPlan ? <FormattedMessage id="account.topUps.never" /> : <FormattedMessage id="account.topUps.membersOnly" />}
          </span>
        </div>
      </div>
    </section>
  );
}
