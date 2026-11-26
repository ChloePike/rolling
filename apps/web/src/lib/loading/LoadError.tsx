import { cx } from '@rolling/ui';
import { FormattedMessage } from 'react-intl';
import styles from './LoadError.module.css';

export interface LoadErrorProps {
  /** Refetch (e.g. TanStack Query's `refetch`). */
  onRetry: () => unknown;
  /** Custom message; defaults to `shell.load.failed`. */
  message?: string;
  /** A one-line row instead of a centered block. */
  inline?: boolean;
  retrying?: boolean;
  className?: string;
}

/** A load that failed: what happened and a Retry (never a silent empty list). */
export function LoadError({ onRetry, message, inline, retrying, className }: LoadErrorProps) {
  return (
    <div role="alert" className={cx(styles.box, inline && styles.inline, className)} data-load-error="">
      <span>{message ?? <FormattedMessage id="shell.load.failed" />}</span>
      <button type="button" className={styles.retry} disabled={retrying} onClick={() => void onRetry()}>
        <FormattedMessage id="shell.load.retry" />
      </button>
    </div>
  );
}
