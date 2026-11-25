import { cx, staggerStyle } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { FormattedDate, FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { useSession } from '@/lib/session';
import { formatUsd, topUpPresets } from '@/lib/topUp';
import styles from './CreditsPopover.module.css';
import { placeholderCredits } from './placeholder';

export interface CreditsBreakdown {
  available: number;
  plan: number;
  planExpires: Date;
  purchased: number;
  usedThisMonth: number;
  held: number;
  expiringThisMonth: number;
}

/** Preset selected when the popover opens (D-006 suggests $10–$250; $25 is the first with a tier bonus). */
const DEFAULT_TOP_UP_USD = 25;

/**
 * Header credits popover (Main.dc.html, credits button): balance, plan vs
 * purchased split, used / held / expiring and top up. Top-ups (D-006) are
 * any amount; the chips are the suggested amounts with credits (bonus
 * included) from `quoteTopUp`. Only members top up; others get a link to plans.
 */
export function CreditsPopoverContent({
  credits = placeholderCredits,
  onTopUp,
  onNavigate,
}: {
  credits?: CreditsBreakdown;
  /** Starts checkout for the chosen amount (USD); the server re-quotes the credits. */
  onTopUp?: (amountUsd: number) => void;
  /** Called when a link inside navigates away (closes the popover). */
  onNavigate?: () => void;
}) {
  const intl = useIntl();
  const { isMember, planId } = useSession();
  const presets = useMemo(() => topUpPresets(planId), [planId]);
  const [amount, setAmount] = useState(DEFAULT_TOP_UP_USD);
  const picked = presets.find((p) => p.amountUsd === amount) ?? presets[0]!;
  const money = (usd: number) => formatUsd(usd, (v, o) => intl.formatNumber(v, o));
  return (
    <div className={styles.panel}>
      <div className={styles.top}>
        <div className={styles.balance}>
          <span className={styles.label}>
            <FormattedMessage id="shell.credits.available" />
          </span>
          <span className={styles.big}>
            <FormattedNumber value={credits.available} />
          </span>
        </div>
        <Link to="/activity" className={styles.usage} onClick={onNavigate}>
          <FormattedMessage id="shell.credits.usage" />
        </Link>
      </div>
      <div className={styles.bar} aria-hidden="true">
        <span className={styles.barPlan} style={{ flex: credits.plan }} />
        <span className={styles.barPurchased} style={{ flex: credits.purchased }} />
      </div>
      <div className={styles.split}>
        <div className={styles.splitRow}>
          <span className={cx(styles.swatch, styles.swatchPlan)} />
          <span className={styles.splitName}>
            <FormattedMessage id="shell.credits.plan" />
          </span>
          <span className={styles.splitValue}>
            <FormattedNumber value={credits.plan} />
          </span>
          <span className={styles.splitNote}>
            <FormattedMessage
              id="shell.credits.expires"
              values={{ date: <FormattedDate value={credits.planExpires} month="short" day="numeric" /> }}
            />
          </span>
        </div>
        <div className={styles.splitRow}>
          <span className={cx(styles.swatch, styles.swatchPurchased)} />
          <span className={styles.splitName}>
            <FormattedMessage id="shell.credits.purchased" />
          </span>
          <span className={styles.splitValue}>
            <FormattedNumber value={credits.purchased} />
          </span>
          <span className={styles.splitNote}>
            <FormattedMessage id="shell.credits.neverExpire" />
          </span>
        </div>
      </div>
      <div className={styles.divider} />
      <div className={styles.stats}>
        {(
          [
            ['shell.credits.usedThisMonth', credits.usedThisMonth],
            ['shell.credits.held', credits.held],
            ['shell.credits.expiring', credits.expiringThisMonth],
          ] as const
        ).map(([id, n]) => (
          <div key={id} className={styles.stat}>
            <span className={styles.statName}>
              <FormattedMessage id={id} />
            </span>
            <span className={styles.statValue}>
              <FormattedNumber value={n} />
            </span>
          </div>
        ))}
      </div>
      <div className={styles.divider} />
      <div className={styles.topUp}>
        <span className={styles.label}>
          <FormattedMessage id="shell.credits.topUp" />
        </span>
        {isMember ? (
          <>
            <div className={styles.presets} role="radiogroup" aria-label={intl.formatMessage({ id: 'shell.credits.topUp' })}>
              {presets.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={picked.id === p.id}
                  className={cx('rl-stagger', styles.preset)}
                  style={staggerStyle(i)}
                  onClick={() => setAmount(p.amountUsd)}
                >
                  <span className={styles.presetUsd}>{money(p.amountUsd)}</span>
                  <span className={styles.presetCredits}>
                    <FormattedMessage id="shell.credits.presetCredits" values={{ credits: p.credits }} />
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className={cx('rl-press', styles.topUpButton)} onClick={() => onTopUp?.(picked.amountUsd)}>
              <FormattedMessage id="shell.credits.topUpButton" values={{ price: money(picked.amountUsd), credits: picked.credits }} />
            </button>
          </>
        ) : (
          <Link to="/upgrade" className={cx('rl-press', styles.topUpButton, styles.joinButton)} onClick={onNavigate}>
            <FormattedMessage id="shell.credits.join" />
          </Link>
        )}
        <span className={styles.note}>
          <FormattedMessage id="shell.credits.note" />
        </span>
      </div>
    </div>
  );
}
