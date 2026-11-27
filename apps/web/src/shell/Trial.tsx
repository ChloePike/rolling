import { TRIAL } from '@rolling/core/pricing/config';
import { FormattedDate, FormattedMessage } from 'react-intl';
import { useSession } from '@/lib/session';
import { openUpgrade } from '@/lib/upgrade/store';
import styles from './Trial.module.css';

/**
 * Header credits button (D-022): a "Trial" chip with the end date while a
 * non-member is on the one-time trial. The number next to it is the trial's
 * remaining credits (they count as available).
 */
export function TrialChip() {
  const { trial } = useSession();
  if (!trial) return null;
  return (
    <span className={styles.chip} data-testid="trial-chip" data-status={trial.status}>
      <FormattedMessage id="trial.chip" />
      <span className={styles.ends}>
        {trial.status === 'expired' ? (
          <FormattedMessage id="trial.chip.ended" />
        ) : (
          <FormattedMessage id="trial.chip.ends" values={{ date: <FormattedDate value={trial.expiresAt} month="short" day="numeric" /> }} />
        )}
      </span>
    </span>
  );
}

/** Top of the credits popover on a trial: credits left of the grant, the end date and what the trial covers. */
export function TrialSummary({ onNavigate }: { onNavigate?: () => void }) {
  const { trial } = useSession();
  if (!trial) return null;
  const date = <FormattedDate value={trial.expiresAt} month="short" day="numeric" />;
  return (
    <div className={styles.summary} data-testid="trial-summary" data-status={trial.status}>
      <div className={styles.summaryHead}>
        <FormattedMessage id="trial.summary.title" />
        <span className={styles.summaryDate}>
          <FormattedMessage id={trial.status === 'expired' ? 'trial.summary.ended' : 'trial.summary.ends'} values={{ date }} />
        </span>
      </div>
      <span className={styles.summaryLeft}>
        {trial.status === 'active' ? (
          <FormattedMessage id="trial.summary.left" values={{ remaining: trial.remaining, credits: trial.credits }} />
        ) : (
          <FormattedMessage id="trial.summary.used" />
        )}
      </span>
      <span className={styles.summaryNote}>
        <FormattedMessage id="trial.summary.note" values={{ image: TRIAL.maxImageResolution, video: TRIAL.maxVideoResolution, seconds: TRIAL.maxVideoSeconds }} />
      </span>
      <button
        type="button"
        className={styles.summaryCta}
        onClick={() => {
          onNavigate?.();
          openUpgrade(trial.status === 'expired' ? { kind: 'trial-expired' } : trial.status === 'used' ? { kind: 'trial-used' } : { kind: 'plan' });
        }}
      >
        <FormattedMessage id="trial.summary.cta" />
      </button>
    </div>
  );
}
