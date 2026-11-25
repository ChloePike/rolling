import { DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '@rolling/core/pricing/config';
import { cx, Dialog, staggerStyle } from '@rolling/ui';
import { useId } from 'react';
import { setPref, usePref } from '@/lib/prefs';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { Svg, type OverlayIcon } from './icons';
import styles from './RunConfirm.module.css';
import type { RunPlanRow, RunRowKind } from './types';

export interface RunConfirmPanelProps {
  /** `single`: one run (tools). `graph`: run-all plan on the canvas with reuse and blocked rows. */
  variant: 'single' | 'graph';
  /** Plan rows. For `single`, one row ("This run"). */
  rows: RunPlanRow[];
  /** Current balance in credits (shown as "2,480 → 2,470"). */
  balance: number;
  /** Total to charge. Defaults to the sum of `run` rows. */
  total?: number;
  /** Typical wait, e.g. "~2 min" (single) or "~4 min" (graph). */
  eta: string;
  /** Subtitle. Single: the routing, e.g. "Auto → Seedance 2.5". Graph defaults to the dependency-order note. */
  subtitle?: string;
  /** Single only: the action on the confirm button, e.g. "Generate video" → "Generate video · 10 credits". */
  actionLabel?: string;
  /** Warning under the rows when something is blocked. */
  blockedNote?: string;
  /**
   * "Skip this step for runs under N credits" checkbox state. Omit both to use
   * the shared preference (lib/prefs `confirmThreshold`): checked while the
   * threshold is on; unchecking sets it to 0 (always confirm).
   */
  skipUnderThreshold?: boolean;
  onSkipUnderThresholdChange?: (skip: boolean) => void;
  /** The user's "Confirm before running" threshold. Defaults to the preference (300, D-006). */
  threshold?: number;
  /** Quote validity shown in the summary (default 10). */
  quoteValidMinutes?: number;
  /** Starts the run(s). The host closes the dialog. */
  onConfirm: () => void;
  /** Cancel and the close button. */
  onCancel: () => void;
  /** Disable the confirm button while the quote refreshes or the hold is placed. */
  busy?: boolean;
  className?: string;
}

export interface RunConfirmProps extends Omit<RunConfirmPanelProps, 'onCancel'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KIND_ICON: Record<RunRowKind, OverlayIcon> = { video: 'video', image: 'image', audio: 'audio', text: 'text' };
const KIND_TONE: Record<RunRowKind, string> = { video: 'var(--c-tone-indigo)', image: 'var(--c-tone-teal)', audio: 'var(--c-tone-sand)', text: 'var(--c-tone-neutral)' };

/**
 * Run confirmation (RunConfirm.dc.html) as a modal: single run or run-all plan,
 * rows with run / reuse / blocked / nothing-to-generate states, total, balance
 * after, and "skip under N credits" (the confirm threshold, 300 by default). The panel rises in 320ms; rows stagger in.
 */
export function RunConfirm({ open, onOpenChange, ...panel }: RunConfirmProps) {
  const intl = useIntl();
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      bare
      label={intl.formatMessage({ id: `overlays.runConfirm.${panel.variant}.title` })}
      labelledBy={titleId}
    >
      <RunConfirmPanel {...panel} titleId={titleId} onCancel={() => onOpenChange(false)} />
    </Dialog>
  );
}

/** The dialog's panel without the modal layer (for previews and embedding). */
export function RunConfirmPanel({
  variant,
  rows,
  balance,
  total: totalProp,
  eta,
  subtitle,
  actionLabel,
  blockedNote,
  skipUnderThreshold: skipProp,
  onSkipUnderThresholdChange,
  threshold: thresholdProp,
  quoteValidMinutes = 10,
  onConfirm,
  onCancel,
  busy,
  className,
  titleId,
}: RunConfirmPanelProps & { titleId?: string }) {
  const intl = useIntl();
  const prefThreshold = usePref('confirmThreshold');
  const threshold = thresholdProp ?? (prefThreshold > 0 ? prefThreshold : DEFAULT_CONFIRM_THRESHOLD_CREDITS);
  const skipUnderThreshold = skipProp ?? (onSkipUnderThresholdChange ? false : prefThreshold > 0);
  const onSkipChange =
    onSkipUnderThresholdChange ?? ((skip: boolean) => setPref('confirmThreshold', skip ? threshold : 0));
  const graph = variant === 'graph';
  const total = totalProp ?? rows.filter((r) => r.state === 'run').reduce((s, r) => s + r.cost, 0);
  const count = (state: RunPlanRow['state']) => rows.filter((r) => r.state === state).length;
  const stats = graph
    ? [
        intl.formatMessage({ id: 'overlays.runConfirm.stat.toGenerate' }, { count: count('run') }),
        intl.formatMessage({ id: 'overlays.runConfirm.stat.reused' }, { count: count('reuse') }),
        intl.formatMessage({ id: 'overlays.runConfirm.stat.blocked' }, { count: count('blocked') }),
        eta,
      ]
    : [eta, intl.formatMessage({ id: 'overlays.runConfirm.stat.noCharge' })];
  const title = intl.formatMessage({ id: `overlays.runConfirm.${variant}.title` });
  const sub = subtitle ?? (graph ? intl.formatMessage({ id: 'overlays.runConfirm.graph.sub' }) : '');

  return (
    <div className={cx(styles.panel, className)}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <span id={titleId} className={styles.title}>
            {title}
          </span>
          {sub ? <span className={styles.sub}>{sub}</span> : null}
        </div>
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'overlays.close' })} onClick={onCancel}>
          <Svg name="close" size={16} />
        </button>
      </div>

      <div className={styles.stats}>{stats.join(' · ')}</div>

      <div className={styles.rows} role="list">
        {rows.map((r, i) => (
          <div key={r.id} role="listitem" className={cx('rl-stagger', styles.row)} style={staggerStyle(i)} data-state-kind={r.state}>
            <span className={styles.tile} style={{ background: r.tone ?? KIND_TONE[r.kind] }}>
              <Svg name={KIND_ICON[r.kind]} size={15} stroke="var(--c-text-2)" />
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowName}>{r.name}</span>
              <span className={styles.rowMeta}>{r.meta}</span>
            </span>
            <span className={cx(styles.chip, styles[`chip_${r.state}`])}>
              <FormattedMessage id={`overlays.runConfirm.state.${r.state}`} />
            </span>
            <span className={cx(styles.rowCost, r.state !== 'run' && styles.rowCostOff)}>
              <FormattedNumber value={r.state === 'run' ? r.cost : 0} />
            </span>
          </div>
        ))}
      </div>

      {blockedNote ? (
        <div className={styles.blocked} role="note">
          <Svg name="warning" size={16} />
          <span className={styles.blockedText}>{blockedNote}</span>
        </div>
      ) : null}

      <div className={styles.summary}>
        <div className={styles.sumRow}>
          <span>
            <FormattedMessage id="overlays.runConfirm.estimated" />
          </span>
          <span className={styles.total}>
            <FormattedNumber value={total} />{' '}
            <span className={styles.totalUnit}>
              <FormattedMessage id="overlays.runConfirm.credits" />
            </span>
          </span>
        </div>
        <div className={styles.sumRow}>
          <span>
            <FormattedMessage id="overlays.runConfirm.balance" />
          </span>
          <span>
            <FormattedMessage id="overlays.runConfirm.balanceAfter" values={{ before: balance, after: balance - total }} />
          </span>
        </div>
        <div className={cx(styles.sumRow, styles.sumNote)}>
          <span>
            <FormattedMessage id="overlays.runConfirm.refundNote" />
          </span>
          <span>
            <FormattedMessage id="overlays.runConfirm.quoteValid" values={{ minutes: quoteValidMinutes }} />
          </span>
        </div>
      </div>

      <label className={styles.skip}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={skipUnderThreshold ?? false}
          onChange={(e) => onSkipChange(e.target.checked)}
        />
        <FormattedMessage id="overlays.runConfirm.skip" values={{ threshold }} />
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          <FormattedMessage id="overlays.runConfirm.cancel" />
        </button>
        <button type="button" className={cx('rl-press', styles.go)} onClick={onConfirm} disabled={busy || total <= 0}>
          {graph ? (
            <FormattedMessage id="overlays.runConfirm.go.graph" values={{ cost: total }} />
          ) : (
            <FormattedMessage id="overlays.runConfirm.go.single" values={{ label: actionLabel ?? '', cost: total }} />
          )}
        </button>
      </div>
    </div>
  );
}
