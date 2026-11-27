import { TRIAL } from '@rolling/core/pricing/config';
import { cx } from '@rolling/ui';
import { FormattedDate, FormattedMessage } from 'react-intl';
import { useSession } from '@/lib/session';
import { openUpgrade } from '@/lib/upgrade/store';
import { motion } from './shared';
import styles from './Settings.module.css';

/** Settings → Plan and billing (D-022): the one-time trial's state for a non-member who has one. */
export function TrialPlanCard() {
  const { trial } = useSession();
  if (!trial) return null;
  const date = <FormattedDate value={trial.expiresAt} month="short" day="numeric" year="numeric" />;
  const agentShare = trial.agentAllowanceUsd ? Math.min(1, (trial.agentUsedUsd ?? 0) / trial.agentAllowanceUsd) : null;
  return (
    <div className={styles.card} data-testid="trial-plan" data-status={trial.status}>
      <span className={styles.cardKey}>
        <FormattedMessage id="trial.plan.key" />
      </span>
      <span className={styles.cardValue}>
        {trial.status === 'active' ? (
          <FormattedMessage id="trial.plan.value.active" values={{ remaining: trial.remaining }} />
        ) : (
          <FormattedMessage id={`trial.plan.value.${trial.status}`} />
        )}
      </span>
      <span className={styles.cardText}>
        <FormattedMessage id={`trial.plan.text.${trial.status}`} values={{ date, credits: trial.credits }} />
      </span>
      {trial.status === 'active' ? (
        <>
          <span className={styles.cardText}>
            <FormattedMessage
              id="trial.plan.limits"
              values={{ image: TRIAL.maxImageResolution, video: TRIAL.maxVideoResolution, seconds: TRIAL.maxVideoSeconds, export: TRIAL.maxExportShortSide }}
            />
          </span>
          {agentShare !== null ? (
            <span className={styles.cardText}>
              <FormattedMessage id="trial.plan.agent" values={{ used: agentShare }} />
            </span>
          ) : null}
        </>
      ) : null}
      <div className={styles.cardActions}>
        <button
          type="button"
          className={cx(styles.btn, styles.btnPrimary, motion.press)}
          onClick={() => void openUpgrade(trial.status === 'expired' ? { kind: 'trial-expired' } : trial.status === 'used' ? { kind: 'trial-used' } : { kind: 'plan' })}
        >
          <FormattedMessage id="trial.plan.cta" />
        </button>
      </div>
    </div>
  );
}
