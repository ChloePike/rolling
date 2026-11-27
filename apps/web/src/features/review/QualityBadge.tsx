import { cx } from '@rolling/ui';
import { useIntl } from 'react-intl';
import styles from './QualityBadge.module.css';
import type { ReviewView } from './types';

/** Small quality badge (D-024): grade and score of the version's review. Canvas node chip and the result viewer. */
export function QualityBadge({ review, compact = false, className }: { review: Pick<ReviewView, 'grade' | 'score'>; compact?: boolean; className?: string }) {
  const intl = useIntl();
  const score = intl.formatNumber(review.score, { maximumFractionDigits: 1 });
  return (
    <span
      className={cx(styles.badge, className)}
      data-testid="quality-badge"
      data-grade={review.grade}
      role="img"
      aria-label={intl.formatMessage({ id: 'quality.badge.label' }, { grade: review.grade, score })}
      title={intl.formatMessage({ id: 'quality.grade' }, { grade: review.grade })}
    >
      <span className={cx(styles.dot, styles[review.grade])} aria-hidden="true" />
      {compact ? null : <span aria-hidden="true">{intl.formatMessage({ id: 'quality.grade' }, { grade: review.grade })}</span>}
      <span className={styles.score} aria-hidden="true">
        {intl.formatMessage({ id: 'quality.score' }, { score })}
      </span>
    </span>
  );
}
