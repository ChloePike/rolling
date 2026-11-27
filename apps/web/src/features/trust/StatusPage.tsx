import { FormattedMessage, useIntl } from 'react-intl';
import { LoadError } from '@/lib/loading';
import { useStatus } from './api';
import { PageFrame } from './PageFrame';
import type { ComponentStatus } from './types';
import styles from './Trust.module.css';

const CHIP: Record<ComponentStatus, string> = { operational: styles.ok!, degraded: styles.warn!, down: styles.bad!, unknown: '' };

/** `/status` (public, D-029): API, generation gateway, media and auth, plus the incident note. */
export function StatusPage() {
  const intl = useIntl();
  const q = useStatus({ poll: true });
  const d = q.data;
  return (
    <PageFrame>
      <h1 className={styles.h1}>
        <FormattedMessage id="status.title" />
      </h1>
      {q.isError ? (
        <LoadError onRetry={() => void q.refetch()} />
      ) : !d ? (
        <div className={styles.card} aria-busy="true" style={{ height: 220 }} />
      ) : (
        <>
          <p className={styles.sub} data-testid="status-overall">
            <FormattedMessage id={`status.overall.${d.overall}`} />
          </p>
          {d.incident && (
            <div className={styles.card} role="status">
              <h2 className={styles.h2}>
                <FormattedMessage id="status.incident" />
              </h2>
              <p className={styles.sub}>{d.incident.message}</p>
              <span className={styles.meta}>
                <FormattedMessage id="status.updated" values={{ when: intl.formatDate(d.incident.updatedAt, { dateStyle: 'medium', timeStyle: 'short' }) }} />
              </span>
            </div>
          )}
          {!d.generation.available && (
            <p className={styles.sub} role="status">
              <FormattedMessage id="status.generationPaused" />
            </p>
          )}
          <section className={styles.card} aria-label={intl.formatMessage({ id: 'status.components' })}>
            {d.components.map((c) => (
              <div key={c.id} className={styles.comp} data-component={c.id}>
                <span className={styles.compName}>
                  <FormattedMessage id={`status.component.${c.id}`} />
                </span>
                {c.uptime24h !== null && (
                  <span className={styles.meta}>
                    <FormattedMessage id="status.uptime" values={{ pct: intl.formatNumber(c.uptime24h, { style: 'percent', maximumFractionDigits: 1 }) }} />
                  </span>
                )}
                <span className={`${styles.chip} ${CHIP[c.status]}`}>
                  <FormattedMessage id={`status.state.${c.status}`} />
                </span>
              </div>
            ))}
          </section>
          <span className={styles.meta}>
            <FormattedMessage id="status.checked" values={{ when: intl.formatTime(d.updatedAt, { timeStyle: 'short' }) }} />
          </span>
        </>
      )}
    </PageFrame>
  );
}
