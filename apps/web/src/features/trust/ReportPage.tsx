import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useSession } from '@/lib/session';
import { submitReport } from './api';
import { PageFrame } from './PageFrame';
import { REPORT_CATEGORIES, type ReportCategory } from './types';
import { useSubmit } from './useSubmit';
import styles from './Trust.module.css';

export interface ReportTarget {
  kind?: 'share' | 'profile';
  id?: string;
}

/**
 * `/report` (public, D-026): the abuse form linked from the AUP, and the target of
 * the Report action on share pages (`?kind=share&id=…`) and profiles (`?kind=profile&id=<handle>`).
 */
export function ReportPage({ target }: { target: ReportTarget }) {
  const intl = useIntl();
  const session = useSession();
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<ReportCategory | ''>('');
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState('');
  const s = useSubmit(submitReport, intl.formatMessage({ id: 'trust.error' }));
  const fixed = !!(target.kind && target.id);
  if (s.caseId) {
    return (
      <PageFrame>
        <h1 className={styles.h1}><FormattedMessage id="trust.report.doneTitle" /></h1>
        <p className={styles.sub} role="status"><FormattedMessage id="trust.report.done" values={{ id: s.caseId }} /></p>
        <Link to="/" className={styles.link}><FormattedMessage id="trust.backHome" /></Link>
      </PageFrame>
    );
  }
  return (
    <PageFrame>
      <h1 className={styles.h1}><FormattedMessage id="trust.report.title" /></h1>
      <p className={styles.sub}><FormattedMessage id="trust.report.sub" /></p>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (!category) return;
          s.submit({
            ...(fixed ? { targetKind: target.kind!, targetId: target.id! } : { targetKind: 'url' as const, url }),
            category,
            details,
            ...(email && session.status !== 'signedIn' ? { email } : {}),
          });
        }}
      >
        {fixed ? (
          <p className={styles.sub} data-testid="report-target">
            <FormattedMessage id={`trust.report.target.${target.kind}`} values={{ id: target.id }} />
          </p>
        ) : (
          <label className={styles.field}>
            <FormattedMessage id="trust.report.url" />
            <input className={styles.input} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://rolling.actor/share/…" />
          </label>
        )}
        <label className={styles.field}>
          <FormattedMessage id="trust.report.category" />
          <select className={styles.select} required value={category} onChange={(e) => setCategory(e.target.value as ReportCategory)}>
            <option value="" disabled>{intl.formatMessage({ id: 'trust.report.choose' })}</option>
            {REPORT_CATEGORIES.map((c) => <option key={c} value={c}>{intl.formatMessage({ id: `trust.category.${c}` })}</option>)}
          </select>
        </label>
        {category === 'child_safety' && (
          <p className={styles.hint} role="note"><FormattedMessage id="trust.report.childNote" /></p>
        )}
        <label className={styles.field}>
          <FormattedMessage id="trust.report.details" />
          <textarea className={styles.textarea} maxLength={4000} value={details} onChange={(e) => setDetails(e.target.value)} />
        </label>
        {session.status !== 'signedIn' && (
          <label className={styles.field}>
            <FormattedMessage id="trust.report.email" />
            <input className={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className={styles.hint}><FormattedMessage id="trust.report.emailHint" /></span>
          </label>
        )}
        {s.error && <p className={styles.error} role="alert">{s.error}</p>}
        <p className={styles.hint}>
          <FormattedMessage id="trust.report.copyright" values={{ link: (chunks) => <Link to="/dmca" className={styles.link}>{chunks}</Link> }} />
        </p>
        <button type="submit" className={styles.submit} disabled={s.busy || !category}><FormattedMessage id="trust.report.submit" /></button>
      </form>
    </PageFrame>
  );
}

/** The Report action on share pages and public profiles. */
export function ReportLink({ kind, id }: { kind: 'share' | 'profile'; id: string }) {
  return (
    <Link to="/report" search={{ kind, id }} className={styles.reportLink}>
      <FormattedMessage id="trust.report.action" />
    </Link>
  );
}
