import { Button } from '@rolling/ui';
import { useSyncExternalStore } from 'react';
import { FormattedMessage } from 'react-intl';
import { applyUpdate, getNeedsReload, subscribeUpdate } from '@/lib/pwa/register';
import styles from './Pwa.module.css';

/**
 * "A new version is ready · Reload" (PWA.dc.html). Shown while a new service
 * worker waits; the app never reloads on its own (handoff 8), only on Reload.
 */
export function UpdatePrompt() {
  const needsReload = useSyncExternalStore(subscribeUpdate, getNeedsReload, () => false);
  if (!needsReload) return null;
  return (
    <div className={styles.update} role="status" data-testid="update-prompt">
      <span>
        <FormattedMessage id="pwa.update.message" />
      </span>
      <Button variant="primary" size="sm" shape="rounded" className={styles.reload} onClick={applyUpdate}>
        <FormattedMessage id="pwa.update.reload" />
      </Button>
    </div>
  );
}
