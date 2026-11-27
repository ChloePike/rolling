import { useState, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isApiError } from '@/lib/api/errors';
import styles from './Admin.module.css';

export function useFormat() {
  const intl = useIntl();
  return {
    n: (v: number) => intl.formatNumber(v),
    date: (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : intl.formatDate(typeof v === 'string' ? Date.parse(v) : v, { dateStyle: 'medium', timeStyle: 'short' })),
  };
}

export function errorText(e: unknown, fallback: string): string {
  if (isApiError(e)) return e.message || fallback;
  return fallback;
}

/** An action that needs a written reason (kept in the audit log). */
export function ReasonAction({ label, onSubmit, children, danger, testId }: { label: string; onSubmit: (reason: string) => Promise<unknown>; children?: ReactNode; danger?: boolean; testId?: string }) {
  const intl = useIntl();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className={styles.form}
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        onSubmit(reason.trim())
          .then(() => {
            setMsg({ ok: true, text: intl.formatMessage({ id: 'admin.action.done' }) });
            setReason('');
          })
          .catch((err: unknown) => setMsg({ ok: false, text: errorText(err, intl.formatMessage({ id: 'admin.action.failed' })) }))
          .finally(() => setBusy(false));
      }}
    >
      {children}
      <label className={styles.field}>
        <FormattedMessage id="admin.reason" />
        <input className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={1000} placeholder={intl.formatMessage({ id: 'admin.reason.placeholder' })} />
      </label>
      <div className={styles.row}>
        <button type="submit" className={`${styles.btn} ${danger ? styles.danger : styles.primary}`} disabled={busy || reason.trim().length < 3}>
          {label}
        </button>
        {msg && (
          <span role="status" className={styles.sub}>
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}

export function Priority({ p }: { p: number }) {
  const cls = p >= 2 ? styles.chipUrgent : p === 1 ? styles.chipHigh : styles.chip;
  return (
    <span className={`${styles.chip} ${cls}`}>
      <FormattedMessage id={`admin.priority.${p >= 2 ? 'urgent' : p === 1 ? 'high' : 'normal'}`} />
    </span>
  );
}
