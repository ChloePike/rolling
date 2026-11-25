import { cx, Dialog, staggerStyle } from '@rolling/ui';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, FormattedNumber, useIntl, type IntlShape } from 'react-intl';
import { Svg } from './icons';
import styles from './Paywall.module.css';
import type { PaywallOption } from './types';

export interface PaywallPanelProps {
  /** `join`: no plan yet (pick a plan to generate). `credits`: member out of credits (top up). */
  variant: 'join' | 'credits';
  /** Radio options. Defaults to the design's plans (join) or packs + upgrade (credits). */
  options?: PaywallOption[];
  /** Initially selected option id (default: Pro for join, 1,000 credits for credits). */
  defaultOptionId?: string;
  /** Credits variant: cost of the run that triggered the paywall. */
  runCost?: number;
  /** Credits variant: current balance. */
  balance?: number;
  /** Credits variant: card label in the footer, e.g. "Visa ending 4242". */
  paymentMethod?: string;
  /** Credits variant: auto top-up checkbox. */
  autoTopUp?: boolean;
  onAutoTopUpChange?: (on: boolean) => void;
  /** CTA: continue the same run after checkout with the chosen option. */
  onContinue: (option: PaywallOption) => void;
  /** Close button. */
  onClose: () => void;
  /** Footer link target ("Compare plans ›" / "All plans ›"). */
  plansHref?: string;
  className?: string;
}

export interface PaywallProps extends Omit<PaywallPanelProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Default options from Paywall.dc.html; prices stay placeholders until decided. */
export function defaultPaywallOptions(variant: 'join' | 'credits', intl: IntlShape): PaywallOption[] {
  const m = (id: string, v?: Record<string, number>) => intl.formatMessage({ id: `overlays.paywall.${id}` }, v);
  if (variant === 'join') {
    return (['starter', 'pro', 'studio'] as const).map((p) => ({
      id: p,
      name: m(`plan.${p}`),
      meta: m(`plan.${p}.meta`),
      price: m('pricePerMonth'),
      kind: 'plan' as const,
    }));
  }
  return [
    { id: 'pack_1000', name: m('pack.name', { credits: 1000 }), meta: m('pack.1000.meta'), price: m('price'), kind: 'pack' },
    { id: 'pack_3000', name: m('pack.name', { credits: 3000 }), meta: m('pack.3000.meta'), price: m('price'), kind: 'pack' },
    { id: 'upgrade_studio', name: m('upgradeStudio'), meta: m('upgradeStudio.meta'), price: m('pricePerMonth'), kind: 'upgrade' },
  ];
}

/**
 * Paywall dialog (Paywall.dc.html, PaywallCredits.dc.html): radio options and a
 * CTA that continues the same run. Rises in 320ms; options stagger in.
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
export function PaywallPanel({
  variant,
  options: optionsProp,
  defaultOptionId,
  runCost = 18,
  balance = 6,
  paymentMethod = 'Visa ending 4242',
  autoTopUp,
  onAutoTopUpChange,
  onContinue,
  onClose,
  plansHref = '/upgrade',
  className,
  titleId,
}: PaywallPanelProps & { titleId?: string }) {
  const intl = useIntl();
  const credits = variant === 'credits';
  const options = useMemo(() => optionsProp ?? defaultPaywallOptions(variant, intl), [optionsProp, variant, intl]);
  const [picked, setPicked] = useState(defaultOptionId ?? (credits ? options[0]?.id : options[1]?.id) ?? '');
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = options.find((o) => o.id === picked) ?? options[0];
  const m = (id: string) => intl.formatMessage({ id: `overlays.paywall.${variant}.${id}` });

  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + options.length) % options.length;
    const o = options[next];
    if (o) {
      setPicked(o.id);
      refs.current[next]?.focus();
    }
  };

  const cta = !current
    ? ''
    : credits
      ? current.kind === 'upgrade'
        ? intl.formatMessage({ id: 'overlays.paywall.credits.cta.upgrade' })
        : intl.formatMessage({ id: 'overlays.paywall.credits.cta.buy' }, { name: current.name })
      : intl.formatMessage({ id: 'overlays.paywall.join.cta' }, { name: current.name });

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

      {credits ? (
        <div className={styles.numbers}>
          <span className={styles.num}>
            <span className={styles.numLabel}>
              <FormattedMessage id="overlays.paywall.credits.thisRun" />
            </span>
            <span className={styles.numValue}>
              <FormattedNumber value={runCost} />
            </span>
          </span>
          <span className={styles.num}>
            <span className={styles.numLabel}>
              <FormattedMessage id="overlays.paywall.credits.youHave" />
            </span>
            <span className={styles.numValue}>
              <FormattedNumber value={balance} />
            </span>
          </span>
          <span className={styles.num}>
            <span className={styles.numLabel}>
              <FormattedMessage id="overlays.paywall.credits.shortBy" />
            </span>
            <span className={cx(styles.numValue, styles.short)}>
              <FormattedNumber value={Math.max(0, runCost - balance)} />
            </span>
          </span>
        </div>
      ) : null}

      <div role="radiogroup" aria-label={m('group')} className={styles.options}>
        {options.map((o, i) => {
          const on = o.id === current?.id;
          return (
            <button
              key={o.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={cx('rl-stagger', styles.option)}
              style={staggerStyle(i)}
              onClick={() => setPicked(o.id)}
              onKeyDown={(e) => onKey(e, i)}
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

      {credits ? (
        <label className={styles.auto}>
          <input type="checkbox" className={styles.checkbox} checked={autoTopUp ?? false} onChange={(e) => onAutoTopUpChange?.(e.target.checked)} />
          <FormattedMessage id="overlays.paywall.credits.autoTopUp" />
        </label>
      ) : null}

      <button type="button" className={cx('rl-press', styles.cta)} onClick={() => current && onContinue(current)}>
        {cta}
      </button>

      <div className={styles.foot}>
        <span>{credits ? intl.formatMessage({ id: 'overlays.paywall.credits.foot' }, { card: paymentMethod }) : m('foot')}</span>
        <a href={plansHref} className={styles.link}>
          {m('link')}
        </a>
      </div>
    </div>
  );
}
