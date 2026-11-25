import { cx, staggerStyle } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedDate, FormattedMessage, FormattedNumber } from 'react-intl';
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
  packs: number[];
  defaultPack: number;
}

/**
 * Header credits popover (Main.dc.html, credits button): balance, plan vs
 * purchased split, used / held / expiring, packs and top up. Members only buy packs.
 */
export function CreditsPopoverContent({
  credits = placeholderCredits,
  onTopUp,
  onNavigate,
}: {
  credits?: CreditsBreakdown;
  /** Starts checkout for the chosen pack. */
  onTopUp?: (credits: number) => void;
  /** Called when a link inside navigates away (closes the popover). */
  onNavigate?: () => void;
}) {
  const [pack, setPack] = useState(credits.defaultPack);
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
        <div className={styles.packs}>
          {credits.packs.map((n, i) => (
            <button
              key={n}
              type="button"
              aria-pressed={pack === n}
              className={cx('rl-stagger', styles.pack)}
              style={staggerStyle(i)}
              onClick={() => setPack(n)}
            >
              <span className={styles.packN}>
                <FormattedNumber value={n} />
              </span>
              <span className={styles.packPrice}>
                <FormattedMessage id="shell.credits.packPrice" />
              </span>
            </button>
          ))}
        </div>
        <button type="button" className={cx('rl-press', styles.topUpButton)} onClick={() => onTopUp?.(pack)}>
          <FormattedMessage id="shell.credits.topUpButton" values={{ credits: pack }} />
        </button>
        <span className={styles.note}>
          <FormattedMessage id="shell.credits.note" />
        </span>
      </div>
    </div>
  );
}
