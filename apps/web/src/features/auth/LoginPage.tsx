import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { motion } from '@/features/account/shared';
import { CODE_LENGTH, sendEmailCode, startOAuth, verifyEmailCode, type SendCodeResult } from './api';
import styles from './Login.module.css';

export type AuthMode = 'login' | 'signup';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** `/login` and `/signup` (Login.dc.html, LoginSignup, LoginCode). */
export function LoginPage({ mode }: { mode: AuthMode }) {
  const [sent, setSent] = useState<SendCodeResult | null>(null);
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.brand}>
          <svg width="28" height="28" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
            <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
          </svg>
          <span className={styles.wordmark}>
            <FormattedMessage id="app.name" />
          </span>
        </div>
        <div className={styles.center}>
          {sent ? (
            <CodeStep key="code" sent={sent} onBack={() => setSent(null)} onResent={setSent} />
          ) : (
            <StartStep key={mode} mode={mode} onSent={setSent} />
          )}
        </div>
        <p className={styles.legal}>
          <FormattedMessage
            id="auth.legal"
            values={{
              terms: (chunks) => <a href="/terms">{chunks}</a>,
              privacy: (chunks) => <a href="/privacy">{chunks}</a>,
            }}
          />
        </p>
      </main>
      <aside aria-hidden="true" className={styles.aside}>
        <div className={styles.frames}>
          <div className={cx(styles.frame, styles.frameA)} />
          <div className={cx(styles.frame, styles.frameB)}>
            <span className={styles.caption}>
              <FormattedMessage id="auth.preview.caption" />
            </span>
          </div>
          <div className={cx(styles.frame, styles.frameC)} />
        </div>
        <p className={styles.pitch}>
          <FormattedMessage id="auth.preview.pitch" />
        </p>
      </aside>
    </div>
  );
}

function StartStep({ mode, onSent }: { mode: AuthMode; onSent: (r: SendCodeResult) => void }) {
  const intl = useIntl();
  const emailId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    try {
      onSent(await sendEmailCode(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={cx(styles.form, motion.enter)} onSubmit={submit} noValidate data-testid="auth-start">
      <h1 className={styles.title}>
        <FormattedMessage id={signup ? 'auth.signup.title' : 'auth.login.title'} />
      </h1>
      <p className={styles.sub}>
        <FormattedMessage id={signup ? 'auth.signup.sub' : 'auth.login.sub'} />
      </p>
      <button type="button" className={cx(styles.btn, styles.primary, motion.press)} onClick={() => void startOAuth('google')}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" fill="#4285F4" />
          <path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" />
          <path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6z" fill="#FBBC05" />
          <path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z" fill="#EA4335" />
        </svg>
        <FormattedMessage id="auth.google" />
      </button>
      <button type="button" className={cx(styles.btn, styles.dark, motion.hover)} onClick={() => void startOAuth('apple')}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8a4.6 4.6 0 0 0-3.6-2c-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.8a4.9 4.9 0 0 0-4.1 2.5c-1.8 3.1-.5 7.6 1.3 10.1.8 1.2 1.8 2.6 3.1 2.5 1.3-.1 1.7-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.2 3.1-2.5a11 11 0 0 0 1.4-2.9 4.4 4.4 0 0 1-2.8-4zM14 5.2c.7-.8 1.2-2 1-3.2-1 0-2.2.7-3 1.5-.6.7-1.2 1.9-1 3.1 1.1.1 2.3-.6 3-1.4z"
            fill="currentColor"
          />
        </svg>
        <FormattedMessage id="auth.apple" />
      </button>
      <div className={styles.divider}>
        <FormattedMessage id="auth.or" />
      </div>
      <label htmlFor={emailId} className={styles.label}>
        <FormattedMessage id="auth.email" />
      </label>
      <input
        id={emailId}
        type="email"
        autoComplete="email"
        className={styles.input}
        placeholder={intl.formatMessage({ id: 'auth.email.placeholder' })}
        value={email}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => {
          setEmail(e.target.value);
          setInvalid(false);
        }}
      />
      {invalid && (
        <p id={errorId} role="alert" className={cx(styles.error, motion.enter)}>
          <FormattedMessage id="auth.email.invalid" />
        </p>
      )}
      <button type="submit" disabled={busy} className={cx(styles.btn, styles.mid, motion.hover)}>
        <FormattedMessage id="auth.email.continue" />
      </button>
      <span className={styles.swap}>
        <FormattedMessage id={signup ? 'auth.signup.swapLead' : 'auth.login.swapLead'} />{' '}
        <Link to={signup ? '/login' : '/signup'} className={styles.link}>
          <FormattedMessage id={signup ? 'auth.signup.swapCta' : 'auth.login.swapCta'} />
        </Link>
      </span>
    </form>
  );
}

function CodeStep({
  sent,
  onBack,
  onResent,
}: {
  sent: SendCodeResult;
  onBack: () => void;
  onResent: (r: SendCodeResult) => void;
}) {
  const intl = useIntl();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(true);
  const [left, setLeft] = useState(sent.resendAfter);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLeft(sent.resendAfter);
    const t = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(t);
  }, [sent]);

  useEffect(() => inputRef.current?.focus(), []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (code.length !== CODE_LENGTH) return;
    setBusy(true);
    try {
      const res = await verifyEmailCode(sent.email, code);
      if (res.ok) await navigate({ to: '/' });
    } finally {
      setBusy(false);
    }
  }

  const active = Math.min(code.length, CODE_LENGTH - 1);
  const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <form className={cx(styles.form, motion.enter)} onSubmit={verify} data-testid="auth-code">
      <button type="button" className={styles.back} onClick={onBack}>
        <FormattedMessage id="auth.code.back" />
      </button>
      <h1 className={cx(styles.title, styles.codeTitle)}>
        <FormattedMessage id="auth.code.title" />
      </h1>
      <p className={styles.sub}>
        <FormattedMessage
          id="auth.code.sub"
          values={{ digits: CODE_LENGTH, email: sent.email, minutes: sent.expiresInMinutes }}
        />
      </p>
      <div role="group" aria-label={intl.formatMessage({ id: 'auth.code.label' })} className={styles.code}>
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <span key={i} aria-hidden="true" className={cx(styles.cell, focused && i === active && styles.cellActive)}>
            {code[i] ? (
              <span key={code[i]} className={styles.digit}>
                {code[i]}
              </span>
            ) : null}
          </span>
        ))}
        <input
          ref={inputRef}
          className={styles.codeInput}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          aria-label={intl.formatMessage({ id: 'auth.code.label' })}
          value={code}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className={cx(styles.btn, styles.primary, styles.verify, motion.press)}
      >
        <FormattedMessage id="auth.code.verify" />
      </button>
      <span className={styles.swap}>
        <FormattedMessage id="auth.code.resendLead" />{' '}
        <button
          type="button"
          className={styles.link}
          disabled={left > 0}
          onClick={async () => onResent(await sendEmailCode(sent.email))}
        >
          {left > 0 ? (
            <FormattedMessage id="auth.code.resendIn" values={{ time: countdown }} />
          ) : (
            <FormattedMessage id="auth.code.resend" />
          )}
        </button>
      </span>
    </form>
  );
}
