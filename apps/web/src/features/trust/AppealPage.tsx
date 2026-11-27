import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { submitAppeal, useTrustMe } from './api';
import { PageFrame } from './PageFrame';
import { useSubmit } from './useSubmit';
import styles from './Trust.module.css';

/** `/appeal` (signed in, D-028): appeal a suspension, or a blocked run (`?run=<id>`). Lands in the review queue. */
export function AppealPage({ runId }: { runId?: string }) {
  const intl = useIntl();
  const me = useTrustMe(true);
  const [message, setMessage] = useState('');
  const s = useSubmit(submitAppeal, intl.formatMessage({ id: 'trust.error' }));
  const suspension = me.data?.suspension ?? null;
  const subject: 'suspension' | 'block' = runId ? 'block' : 'suspension';
  if (s.caseId) {
    return (
      <PageFrame>
        <h1 className={styles.h1}><FormattedMessage id="trust.appeal.doneTitle" /></h1>
        <p className={styles.sub} role="status"><FormattedMessage id="trust.appeal.done" /></p>
        <Link to="/" className={styles.link}><FormattedMessage id="trust.backHome" /></Link>
      </PageFrame>
    );
  }
  return (
    <PageFrame>
      <h1 className={styles.h1}><FormattedMessage id="trust.appeal.title" /></h1>
      <p className={styles.sub}><FormattedMessage id={subject === 'block' ? 'trust.appeal.subBlock' : 'trust.appeal.subSuspension'} /></p>
      {subject === 'suspension' && me.data && !suspension ? (
        <p className={styles.sub} role="status"><FormattedMessage id="trust.appeal.nothing" /></p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            s.submit({ subject, ...(runId ? { runId } : {}), ...(suspension ? { suspensionId: suspension.id } : {}), message });
          }}
        >
          <label className={styles.field}>
            <FormattedMessage id="trust.appeal.message" />
            <textarea className={styles.textarea} required minLength={1} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
            <span className={styles.hint}><FormattedMessage id="trust.appeal.hint" /></span>
          </label>
          {s.error && <p className={styles.error} role="alert">{s.error}</p>}
          <button type="submit" className={styles.submit} disabled={s.busy || !message.trim()}><FormattedMessage id="trust.appeal.submit" /></button>
        </form>
      )}
    </PageFrame>
  );
}

/** "Appeal" next to a blocked run's message (Activity). */
export function AppealLink({ runId }: { runId: string }) {
  return (
    <Link to="/appeal" search={{ run: runId }} className={styles.bannerLink}>
      <FormattedMessage id="trust.appeal.action" />
    </Link>
  );
}
