import { Button } from '@rolling/ui';
import { useSyncExternalStore } from 'react';
import { FormattedMessage } from 'react-intl';
import { closeInstall, installKind, installOpen, promptInstall, subscribeInstall } from '@/lib/pwa/install';
import styles from './Pwa.module.css';

/**
 * "Install the app" card (PWA.dc.html "Install prompt"). Opens once after the
 * first finished video, or from the account menu (lib/pwa/install.ts). iOS
 * Safari gets the Share → Add to Home Screen instructions instead.
 */
export function InstallCard() {
  const open = useSyncExternalStore(subscribeInstall, installOpen, () => false);
  const kind = useSyncExternalStore(subscribeInstall, installKind, () => null);
  if (!open || !kind) return null;
  const ios = kind === 'ios';
  return (
    <section className={styles.install} aria-labelledby="pwa-install-title" data-testid="install-card">
      <img className={styles.installIcon} src="/icons/app-icon.svg" alt="" width={40} height={40} />
      <span className={styles.installText}>
        <span id="pwa-install-title" className={styles.installTitle}>
          <FormattedMessage id={ios ? 'pwa.install.ios.title' : 'pwa.install.title'} />
        </span>
        <span className={styles.installBody}>
          <FormattedMessage id={ios ? 'pwa.install.ios.body' : 'pwa.install.body'} />
        </span>
      </span>
      {ios ? (
        <Button variant="secondary" size="sm" shape="rounded" onClick={closeInstall}>
          <FormattedMessage id="pwa.install.ios.done" />
        </Button>
      ) : (
        <>
          <Button variant="secondary" size="sm" shape="rounded" onClick={closeInstall}>
            <FormattedMessage id="pwa.install.notNow" />
          </Button>
          <Button variant="primary" size="sm" shape="rounded" onClick={() => void promptInstall()}>
            <FormattedMessage id="pwa.install.install" />
          </Button>
        </>
      )}
    </section>
  );
}
