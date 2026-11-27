import { Button } from '@rolling/ui';
import { useIntl } from 'react-intl';
import { QualityBadge } from './QualityBadge';
import styles from './QualityReview.module.css';
import type { ReviewView } from './types';

export interface QualityReviewProps {
  review: ReviewView;
  /**
   * "Retry with fix" (D-024): writes the suggested prompt and params to the node and runs it (the user's run,
   * confirmed per the usual threshold). Omitted where the result cannot be retried from here.
   */
  onRetryWithFix?: () => void;
  /** Credits a retry costs at list price, shown on the button. */
  retryCost?: number;
  disabled?: boolean;
}

/** The result viewer's quality card: badge, the issues found, the suggested fix and "Retry with fix". */
export function QualityReview({ review, onRetryWithFix, retryCost, disabled }: QualityReviewProps) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id: `quality.${id}` }, v);
  const canRetry = !!onRetryWithFix && !!review.fix && review.grade !== 'good' && !review.autoRetried;
  return (
    <section className={styles.card} data-testid="quality-review" aria-label={t('title')}>
      <div className={styles.head}>
        <span className={styles.label}>{t('title')}</span>
        <QualityBadge review={review} />
      </div>
      {review.issues.length ? (
        <ul className={styles.issues}>
          {review.issues.map((i, k) => (
            <li key={k} className={styles.issue}>
              <span className={styles.dim}>
                {t('dimension', { dimension: i.dimension })}
                {i.severity === 'major' ? (
                  <>
                    {' · '}
                    <span className={styles.major}>{t('severity.major')}</span>
                  </>
                ) : null}
              </span>
              <span className={styles.note}>{i.note}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{t('noIssues')}</p>
      )}
      {review.takes > 1 ? <p className={styles.muted}>{t('bestTake', { takes: review.takes, n: review.best + 1 })}</p> : null}
      {review.fix && review.grade !== 'good' ? <p className={styles.muted}>{t('fix', { note: review.fix.note })}</p> : null}
      {review.autoRetried ? <p className={styles.muted}>{t('autoRetried')}</p> : null}
      {review.overBudget ? <p className={styles.muted}>{t('budget')}</p> : null}
      {canRetry ? (
        <Button variant="primary" size="md" shape="rounded" block disabled={disabled} onClick={onRetryWithFix} title={t('retry.hint')} data-testid="retry-with-fix">
          {t('retry')}
          {retryCost ? <span className={styles.cost}>{intl.formatNumber(retryCost)}</span> : null}
        </Button>
      ) : null}
    </section>
  );
}
