import { FormattedMessage } from 'react-intl';
import { LogoMark } from '../shell/icons';
import styles from './PageStub.module.css';

/** Login and sign-up live outside the app shell (no header). */
export function AuthStub({ titleId }: { titleId: string }) {
  return (
    <main className={styles.centered}>
      <LogoMark size={40} />
      <h1 className={styles.authTitle}>
        <FormattedMessage id={titleId} />
      </h1>
    </main>
  );
}
