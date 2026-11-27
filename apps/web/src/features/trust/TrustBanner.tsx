import { Link, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FormattedMessage, useIntl } from 'react-intl';
import { useSession } from '@/lib/session';
import { useMarkNoticeRead, useStatus, useTrustMe } from './api';
import styles from './Trust.module.css';

/**
 * App-wide banner (D-025, D-029): the incident note or a degraded status (with
 * a link to /status), the caller's suspension (browse only, with Appeal), and
 * unread staff notices (warnings, removals). One line each, no motion.
 */
export function TrustBanner() {
  const intl = useIntl();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();
  const signedIn = session.status === 'signedIn';
  const status = useStatus({ poll: true });
  const me = useTrustMe(signedIn);
  const read = useMarkNoticeRead();
  const qc = useQueryClient();
  if (path.startsWith('/admin') || path === '/status') return null;
  const s = status.data;
  const degraded = s && (s.incident || s.overall !== 'operational' || !s.generation.available);
  const notice = me.data?.notices.find((n) => n.kind !== 'suspended');
  return (
    <>
      {degraded && (
        <div className={`${styles.banner} ${s.incident?.level === 'info' ? styles.bannerInfo : s.overall === 'outage' || s.incident?.level === 'outage' ? styles.bannerBad : ''}`} role="status" data-testid="status-banner">
          <span className={styles.bannerText}>
            {s.incident?.message ?? intl.formatMessage({ id: s.generation.available ? 'trust.banner.degraded' : 'trust.banner.generation' })}
          </span>
          <Link to="/status" className={styles.bannerLink}>
            <FormattedMessage id="trust.banner.status" />
          </Link>
        </div>
      )}
      {me.data?.suspension && (
        <div className={`${styles.banner} ${styles.bannerBad}`} role="alert" data-testid="suspension-banner">
          <span className={styles.bannerText}>{me.data.suspension.message}</span>
          <Link to="/appeal" className={styles.bannerLink}>
            <FormattedMessage id="trust.appeal.action" />
          </Link>
        </div>
      )}
      {notice && (
        <div className={styles.banner} role="status" data-testid="notice-banner">
          <span className={styles.bannerText}>{notice.message}</span>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => void read.mutateAsync(notice.id).then(() => qc.invalidateQueries({ queryKey: ['trust', 'me'] }))}
          >
            <FormattedMessage id="trust.banner.dismiss" />
          </button>
        </div>
      )}
    </>
  );
}
