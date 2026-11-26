import { Button } from '@rolling/ui';
import { FormattedMessage } from 'react-intl';
import styles from './Pwa.module.css';

/** "You're offline" (PWA.dc.html): shown for pages that need the network when the app opens offline. */
export function OfflinePage({ onRetry }: { onRetry: () => void }) {
  return (
    <main className={styles.offline} data-testid="offline-page">
      <div className={styles.offlineCard}>
        <h1 className={styles.offlineTitle}>
          <FormattedMessage id="pwa.offline.title" />
        </h1>
        <p className={styles.offlineBody}>
          <FormattedMessage id="pwa.offline.body" />
        </p>
        <Button variant="primary" size="sm" shape="rounded" onClick={onRetry}>
          <FormattedMessage id="pwa.offline.retry" />
        </Button>
      </div>
    </main>
  );
}
