import { useToast } from '@rolling/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { motion } from '@/features/account/shared';
import { isApiError } from '@/lib/api/errors';
import { safeRedirect } from '@/lib/session/guard';
import { useSession } from '@/lib/session';
import { authErrorMessage, CODE_LENGTH, fetchProviders, oauthErrorMessage, sendEmailCode, verifyEmailCode, type SendCodeResult } from './api';
import { GooglePopupError, requestGoogleAccessToken, signInWithGoogleAccessToken, signInWithGoogleIdToken, startGoogleRedirect, useGoogleIdentity, useGoogleTokenClient } from './google';
import type { AuthSearch } from './search';
import { AuthShowcase } from './ShowcasePanel';
import styles from './Login.module.css';

export type AuthMode = 'login' | 'signup';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** If Google's popup gives no answer this long after focus comes back, the button is usable again. */
const POPUP_GRACE_MS = 1500;

/** The design's Google mark (Login.dc.html). */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={styles.mark}>
      <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" fill="#4285F4" />
      <path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" />
      <path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6z" fill="#FBBC05" />
      <path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z" fill="#EA4335" />
    </svg>
  );
}

type GooglePhase = 'idle' | 'popup' | 'signingIn' | 'redirecting';

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
            <CodeStep key="code" mode={mode} sent={sent} onBack={() => setSent(null)} onResent={setSent} />
          ) : (
            <StartStep key={mode} mode={mode} onSent={setSent} />
          )}
        </div>
        <p className={styles.legal}>
          <FormattedMessage
            id="auth.legal"
            values={{
              terms: (chunks) => <Link to="/terms">{chunks}</Link>,
              privacy: (chunks) => <Link to="/privacy">{chunks}</Link>,
            }}
          />
        </p>
      </main>
      <aside aria-hidden="true" className={styles.aside}>
        <AuthShowcase />
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
  const [phase, setPhase] = useState<GooglePhase>('idle');
  const googleBusy = phase !== 'idle';
  const search = useSearch({ strict: false }) as AuthSearch;
  // A Google fallback that failed comes back with `?error=<code>`.
  const [failure, setFailure] = useState<{ id: string; values?: Record<string, number> } | null>(search.error ? { id: oauthErrorMessage(search.error) } : null);
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: fetchProviders, staleTime: 5 * 60_000 });
  const showGoogle = providers.data ? !!providers.data.google : true;
  const navigate = useNavigate();
  const toast = useToast();
  const session = useSession();
  const signup = mode === 'signup';
  const target = safeRedirect(search.redirect);
  const googleConfig = providers.data?.google || null;

  function signedIn(href: string) {
    toast.show({ message: intl.formatMessage({ id: signup ? 'auth.toast.created' : 'auth.toast.signedIn' }) });
    return navigate({ href });
  }

  // D-017: our own button opens Google's popup (token client, prepared on mount) ...
  const tokenClient = useGoogleTokenClient(googleConfig);
  // ... and One Tap (Google's own prompt) for signed-out visitors.
  const oneTap = useGoogleIdentity({
    config: googleConfig,
    redirect: target,
    oneTap: session.status === 'signedOut',
    context: signup ? 'signup' : 'signin',
    onCredential: async (token, nonce) => {
      setPhase('signingIn');
      setFailure(null);
      try {
        const r = await signInWithGoogleIdToken(token, nonce, target);
        await signedIn(r.redirectTo);
      } catch (err) {
        setFailure(authErrorMessage(err));
        oneTap.refresh();
      } finally {
        setPhase('idle');
      }
    },
  });

  // A popup that closes without telling GIS (rare) must not leave the button stuck.
  useEffect(() => {
    if (phase !== 'popup') return;
    let timer = 0;
    const onFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPhase((p) => (p === 'popup' ? 'idle' : p)), POPUP_GRACE_MS);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(timer);
    };
  }, [phase]);

  /** The script-free fallback: GIS blocked, not loaded yet, or the popup was blocked. */
  async function googleRedirect() {
    setPhase('redirecting');
    setFailure(null);
    try {
      const r = await startGoogleRedirect(target);
      await signedIn(r.redirectTo);
    } catch (err) {
      setFailure(authErrorMessage(err));
    } finally {
      setPhase('idle');
    }
  }

  function googleClick() {
    if (tokenClient !== 'ready') {
      void googleRedirect();
      return;
    }
    setFailure(null);
    // Synchronously in the click: browsers only allow popups from a user gesture.
    const token = requestGoogleAccessToken();
    setPhase('popup');
    token.then(
      async (accessToken) => {
        setPhase('signingIn');
        try {
          const r = await signInWithGoogleAccessToken(accessToken, target);
          await signedIn(r.redirectTo);
        } catch (err) {
          setFailure(authErrorMessage(err));
        } finally {
          setPhase('idle');
        }
      },
      (err: unknown) => {
        const type = err instanceof GooglePopupError ? err.type : 'unknown';
        if (type === 'popup_failed_to_open' || type === 'unavailable') {
          void googleRedirect();
          return;
        }
        if (type === 'superseded') return;
        setPhase('idle');
        // Closed by the user: quiet.
        if (type === 'denied') setFailure({ id: 'auth.error.oauthDenied' });
        else if (type !== 'popup_closed') setFailure({ id: 'auth.error.oauth' });
      },
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      onSent(await sendEmailCode(value));
    } catch (err) {
      setFailure(authErrorMessage(err));
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
      {showGoogle && (
        <button
          type="button"
          className={cx(styles.btn, styles.primary, styles.google, motion.press)}
          disabled={googleBusy || busy}
          aria-busy={googleBusy || undefined}
          data-testid="google-button"
          data-gis={tokenClient}
          onClick={googleClick}
        >
          {googleBusy ? <span className={styles.spinner} aria-hidden="true" /> : <GoogleMark />}
          <FormattedMessage id={phase === 'signingIn' ? 'auth.google.signingIn' : phase === 'idle' ? 'auth.google' : 'auth.redirecting.google'} />
        </button>
      )}
      {showGoogle && (
        <div className={styles.divider}>
          <FormattedMessage id="auth.or" />
        </div>
      )}
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
      {!invalid && failure && (
        <p role="alert" className={cx(styles.error, motion.enter)} data-testid="auth-error">
          <FormattedMessage id={failure.id} values={failure.values} />
        </p>
      )}
      <button type="submit" disabled={busy || googleBusy} aria-busy={busy || undefined} className={cx(styles.btn, styles.mid, motion.hover)}>
        <FormattedMessage id={busy ? 'auth.email.sending' : 'auth.email.continue'} />
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
  mode,
  sent,
  onBack,
  onResent,
}: {
  mode: AuthMode;
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
  const [wrong, setWrong] = useState(false);
  const [failure, setFailure] = useState<{ id: string; values?: Record<string, number> } | null>(null);
  const [resending, setResending] = useState(false);
  const toast = useToast();
  const errorId = useId();
  const search = useSearch({ strict: false }) as AuthSearch;

  useEffect(() => {
    setLeft(sent.resendAfter);
    const t = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(t);
  }, [sent]);

  useEffect(() => inputRef.current?.focus(), []);

  async function verify(e?: FormEvent, value = code) {
    e?.preventDefault();
    if (value.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    try {
      await verifyEmailCode(sent.email, value);
      toast.show({ message: intl.formatMessage({ id: mode === 'signup' ? 'auth.toast.created' : 'auth.toast.signedIn' }) });
      await navigate({ href: safeRedirect(search.redirect) });
    } catch (err) {
      // Wrong, expired, too many tries or rate limited: say so inline and clear the cells.
      setWrong(true);
      setFailure(isApiError(err, 'INVALID_CODE') ? null : authErrorMessage(err));
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      onResent(await sendEmailCode(sent.email));
      setWrong(false);
      setFailure(null);
      toast.show({ message: intl.formatMessage({ id: 'auth.code.resent' }, { email: sent.email }) });
    } catch (err) {
      // The server's cooldown wins over the local timer.
      if (isApiError(err, 'RATE_LIMITED')) setLeft(Math.max(1, Number((err.data as { retryAfter?: number }).retryAfter) || 30));
      setWrong(true);
      setFailure(authErrorMessage(err));
    } finally {
      setResending(false);
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
          aria-invalid={wrong}
          aria-describedby={wrong ? errorId : undefined}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
            setCode(next);
            setWrong(false);
            setFailure(null);
            // A full code submits on its own (paste or the last digit).
            if (next.length === CODE_LENGTH) void verify(undefined, next);
          }}
        />
      </div>
      {wrong && (
        <p id={errorId} role="alert" className={cx(styles.error, motion.enter)}>
          {failure ? <FormattedMessage id={failure.id} values={failure.values} /> : <FormattedMessage id="auth.code.wrong" />}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || code.length !== CODE_LENGTH}
        aria-busy={busy || undefined}
        className={cx(styles.btn, styles.primary, styles.verify, motion.press)}
      >
        <FormattedMessage id={busy ? 'auth.code.verifying' : 'auth.code.verify'} />
      </button>
      <span className={styles.swap}>
        <FormattedMessage id="auth.code.resendLead" />{' '}
        <button
          type="button"
          className={styles.link}
          disabled={left > 0 || resending}
          onClick={() => void resend()}
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
