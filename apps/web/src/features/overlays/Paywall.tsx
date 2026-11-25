import { PLAN_ORDER, PLANS, TOP_UP, type PlanId } from '@rolling/core/pricing/config';
import { cx, Dialog, staggerStyle } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, FormattedNumber, useIntl, type IntlShape } from 'react-intl';
import { formatPrice, getPrefs, usePref } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import { parseTopUpAmount, topUpFor, topUpPresets, type TopUpOption } from '@/lib/topUp';
import { Svg } from './icons';
import styles from './Paywall.module.css';
import type { PaywallOption } from './types';

export interface PaywallPanelProps {
  /** `join`: no plan yet (pick a plan to generate). `credits`: member out of credits (top up any amount). */
  variant: 'join' | 'credits';
  /** Join: radio options. Defaults to the plans from the pricing config (Starter, Plus, Pro; D-006). */
  options?: PaywallOption[];
  /** Join: initially selected option id (default: Plus). Credits: preset id like `topup_25` (default: the smallest preset that covers the shortfall). */
  defaultOptionId?: string;
  /** Credits variant: cost of the run that triggered the paywall. */
  runCost?: number;
  /** Credits variant: current balance. */
  balance?: number;
  /** Credits variant: plan whose top-up bonus applies. Defaults to the session's plan. */
  plan?: PlanId | null;
  /** Credits variant: card label in the footer, e.g. "Visa ending 4242". */
  paymentMethod?: string;
  /** Credits variant: auto top-up checkbox. */
  autoTopUp?: boolean;
  onAutoTopUpChange?: (on: boolean) => void;
  /** CTA: continue the same run after checkout with the chosen plan or top-up. */
  onContinue: (option: PaywallOption) => void;
  /** Close button. */
  onClose: () => void;
  /** Footer link target ("Compare plans ›" / "All plans ›"). Following it closes the dialog. */
  plansHref?: string;
  /** Checkout in progress: the CTA is disabled and says so. */
  busy?: boolean;
  className?: string;
}

export interface PaywallProps extends Omit<PaywallPanelProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Prices in the currency preference (lib/prefs); USD reads as before. */
const money = (intl: IntlShape, usd: number) => formatPrice(intl, usd, getPrefs().currency);

/** Plans from the pricing config (D-006): name, monthly credits and video cap, monthly price. */
export function defaultPaywallOptions(intl: IntlShape): PaywallOption[] {
  return PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return {
      id,
      name: p.label,
      meta: intl.formatMessage({ id: 'overlays.paywall.plan.meta' }, { credits: p.monthlyCredits, video: p.maxVideoResolution }),
      price:
        typeof p.priceMonthlyUsd === 'number'
          ? intl.formatMessage({ id: 'overlays.paywall.pricePerMonth' }, { price: money(intl, p.priceMonthlyUsd) })
          : intl.formatMessage({ id: 'overlays.paywall.pricePerMonth' }, { price: `$${p.priceMonthlyUsd}` }),
      kind: 'plan' as const,
    };
  });
}

function topUpOption(intl: IntlShape, t: TopUpOption): PaywallOption {
  return {
    id: t.id,
    name: intl.formatMessage({ id: 'overlays.paywall.credits.quote' }, { credits: t.credits }),
    meta: '',
    price: money(intl, t.amountUsd),
    kind: 'topup',
    amountUsd: t.amountUsd,
    credits: t.credits,
  };
}

/**
 * Paywall dialog (Paywall.dc.html, PaywallCredits.dc.html). `join` lists the
 * plans; `credits` sells any-amount top-ups (D-006: preset chips plus a custom
 * amount, bonus credits from `quoteTopUp`). The CTA continues the same run.
 * Rises in 320ms; options stagger in.
 */
export function Paywall({ open, onOpenChange, ...panel }: PaywallProps) {
  const intl = useIntl();
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      bare
      label={intl.formatMessage({ id: `overlays.paywall.${panel.variant}.title` })}
      labelledBy={titleId}
    >
      <PaywallPanel {...panel} titleId={titleId} onClose={() => onOpenChange(false)} />
    </Dialog>
  );
}

/** The dialog's panel without the modal layer. */
export function PaywallPanel(props: PaywallPanelProps & { titleId?: string }) {
  const { variant, onClose, plansHref = '/upgrade', className, titleId } = props;
  const intl = useIntl();
  usePref('currency'); // Re-render prices when the currency preference changes.
  const credits = variant === 'credits';
  const m = (id: string) => intl.formatMessage({ id: `overlays.paywall.${variant}.${id}` });
  return (
    <div className={cx(styles.panel, className)}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 id={titleId} className={styles.title}>
            {m('title')}
          </h2>
          <p className={styles.sub}>{m('sub')}</p>
        </div>
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'overlays.close' })} onClick={onClose}>
          <Svg name="close" size={16} strokeLinejoin={undefined} />
        </button>
      </div>
      {credits ? <TopUpBody {...props} /> : <JoinBody {...props} />}
      <div className={styles.foot}>
        <span>{credits ? intl.formatMessage({ id: 'overlays.paywall.credits.foot' }, { card: props.paymentMethod ?? 'Visa ending 4242' }) : m('foot')}</span>
        <Link to={plansHref as never} className={styles.link} onClick={onClose}>
          {m('link')}
        </Link>
      </div>
    </div>
  );
}

/** Arrow keys move the selection in a radio group (roving tabindex). */
function useRoving<T extends { id: string }>(items: T[], pick: (item: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + items.length) % items.length;
    const o = items[next];
    if (o) {
      pick(o);
      refs.current[next]?.focus();
    }
  };
  const ref = (i: number) => (el: HTMLButtonElement | null) => {
    refs.current[i] = el;
  };
  return { onKey, ref };
}

function JoinBody({ options: optionsProp, defaultOptionId, onContinue, busy }: PaywallPanelProps) {
  const intl = useIntl();
  const options = useMemo(() => optionsProp ?? defaultPaywallOptions(intl), [optionsProp, intl]);
  const [picked, setPicked] = useState(defaultOptionId ?? options[1]?.id ?? options[0]?.id ?? '');
  const current = options.find((o) => o.id === picked) ?? options[0];
  const roving = useRoving(options, (o) => setPicked(o.id));
  return (
    <>
      <div role="radiogroup" aria-label={intl.formatMessage({ id: 'overlays.paywall.join.group' })} className={styles.options}>
        {options.map((o, i) => {
          const on = o.id === current?.id;
          return (
            <button
              key={o.id}
              ref={roving.ref(i)}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={cx('rl-stagger', styles.option)}
              style={staggerStyle(i)}
              onClick={() => setPicked(o.id)}
              onKeyDown={(e) => roving.onKey(e, i)}
            >
              <span className={styles.dot} />
              <span className={styles.optText}>
                <span className={styles.optName}>{o.name}</span>
                <span className={styles.optMeta}>{o.meta}</span>
              </span>
              <span className={styles.optPrice}>{o.price}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={cx('rl-press', styles.cta)}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => current && onContinue(current)}
      >
        {busy
          ? intl.formatMessage({ id: 'overlays.paywall.processing' })
          : current
            ? intl.formatMessage({ id: 'overlays.paywall.join.cta' }, { name: current.name })
            : null}
      </button>
    </>
  );
}

function TopUpBody({ runCost = 347, balance = 120, plan: planProp, defaultOptionId, autoTopUp, onAutoTopUpChange, onContinue, busy }: PaywallPanelProps) {
  const intl = useIntl();
  const session = useSession();
  const plan = planProp === undefined ? session.planId : planProp;
  const presets = useMemo(() => topUpPresets(plan), [plan]);
  const short = Math.max(0, runCost - balance);
  const fallback = presets.find((p) => p.credits >= short) ?? presets[presets.length - 1]!;
  const [picked, setPicked] = useState(defaultOptionId ?? fallback.id);
  const [custom, setCustom] = useState('');
  const customId = useId();
  const lineId = useId();
  const parsed = parseTopUpAmount(custom);
  const error = parsed && 'error' in parsed ? parsed.error : null;
  const preset = presets.find((p) => p.id === picked) ?? fallback;
  const quote = parsed ? ('usd' in parsed ? topUpFor(parsed.usd, plan) : null) : preset;
  const roving = useRoving(presets, (p) => {
    setPicked(p.id);
    setCustom('');
  });
  const numbers: Array<[string, number, boolean]> = [
    ['thisRun', runCost, false],
    ['youHave', balance, false],
    ['shortBy', short, true],
  ];
  return (
    <>
      <div className={styles.numbers}>
        {numbers.map(([id, n, danger]) => (
          <span key={id} className={styles.num}>
            <span className={styles.numLabel}>
              <FormattedMessage id={`overlays.paywall.credits.${id}`} />
            </span>
            <span className={cx(styles.numValue, danger && styles.short)}>
              <FormattedNumber value={n} />
            </span>
          </span>
        ))}
      </div>

      <div role="radiogroup" aria-label={intl.formatMessage({ id: 'overlays.paywall.credits.group' })} className={styles.amounts}>
        {presets.map((p, i) => {
          const on = !parsed && p.id === preset.id;
          return (
            <button
              key={p.id}
              ref={roving.ref(i)}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on || (parsed && i === 0) ? 0 : -1}
              className={cx('rl-stagger', styles.amount)}
              style={staggerStyle(i)}
              onClick={() => {
                setPicked(p.id);
                setCustom('');
              }}
              onKeyDown={(e) => roving.onKey(e, i)}
            >
              <span className={styles.amountUsd}>{money(intl, p.amountUsd)}</span>
              <span className={styles.amountCredits}>
                <FormattedNumber value={p.credits} />
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.customRow}>
        <label htmlFor={customId} className={styles.customLabel}>
          <FormattedMessage id="overlays.paywall.credits.custom" />
        </label>
        <span className={styles.customField} data-invalid={!!error}>
          <span aria-hidden="true">$</span>
          <input
            id={customId}
            inputMode="decimal"
            className={styles.customInput}
            placeholder={String(TOP_UP.minUsd)}
            value={custom}
            aria-invalid={!!error}
            aria-describedby={lineId}
            onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </span>
      </div>
      <span id={lineId} className={cx(styles.quote, !!error && styles.quoteError)} role={error ? 'alert' : undefined} aria-live="polite">
        {error ? (
          <FormattedMessage
            id={`overlays.paywall.credits.custom.${error}`}
            values={{ min: money(intl, TOP_UP.minUsd), max: money(intl, TOP_UP.maxUsd) }}
          />
        ) : quote ? (
          <FormattedMessage
            id={quote.bonusCredits > 0 ? 'overlays.paywall.credits.quote.bonus' : 'overlays.paywall.credits.quote.plain'}
            values={{ base: quote.credits - quote.bonusCredits, bonus: quote.bonusCredits, credits: quote.credits }}
          />
        ) : null}
      </span>

      <label className={styles.auto}>
        <input type="checkbox" className={styles.checkbox} checked={autoTopUp ?? false} onChange={(e) => onAutoTopUpChange?.(e.target.checked)} />
        <FormattedMessage id="overlays.paywall.credits.autoTopUp" />
      </label>

      <button
        type="button"
        className={cx('rl-press', styles.cta)}
        disabled={!quote || busy}
        aria-busy={busy || undefined}
        onClick={() => quote && onContinue(topUpOption(intl, quote))}
      >
        {busy ? intl.formatMessage({ id: 'overlays.paywall.processing' }) : quote ? intl.formatMessage({ id: 'overlays.paywall.credits.cta.buy' }, { credits: quote.credits, price: money(intl, quote.amountUsd) }) : intl.formatMessage({ id: 'overlays.paywall.credits.cta.invalid' })}
      </button>
    </>
  );
}
