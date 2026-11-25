import { useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isApiError } from '@/lib/api/errors';
import { signOut, useSession } from '@/lib/session';
import { motion } from '../shared';
import { acceptInvite, useInviteLookup } from './api';
import styles from './Invite.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/**
 * `/invite/$token` (public landing): who invited you to which workspace, then
 * log in or sign up (returning here), or join when signed in with the invited
 * email. Used, revoked, expired and unknown links say so.
 */
export function InvitePage({ token }: { token: string }) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const lookup = useInviteLookup(token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = `/invite/${encodeURIComponent(token)}`;
  const invite = lookup.data;
  const signedIn = session.status === 'signedIn';
  const mismatch = signedIn && invite && session.user?.email && session.user.email.toLowerCase() !== invite.email.toLowerCase();

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await acceptInvite(token);
      toast.show({ message: intl.formatMessage({ id: 'invite.joined' }, { workspace: r.workspace.name }) });
      await navigate({ to: '/' });
    } catch (e) {
      setError(
        intl.formatMessage({
          id: isApiError(e, 'SEATS_REQUIRED') || isApiError(e, 'TEAM_REQUIRED')
            ? 'invite.error.noSeat'
            : isApiError(e, 'FORBIDDEN')
              ? 'invite.error.otherEmail'
              : isApiError(e, 'CONFLICT')
                ? 'invite.error.used'
                : 'invite.error.generic',
        }, { inviter: invite?.inviterName ?? '' }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/login', search: { redirect: here } });
  }

  let body;
  if (lookup.isPending) body = null;
  else if (lookup.isError) {
    body = (
      <p className={styles.sub} role="alert">
        <FormattedMessage id="invite.error.load" />
      </p>
    );
  } else if (!invite) {
    body = (
      <>
        <h1 className={styles.title}>
          <FormattedMessage id="invite.missing.title" />
        </h1>
        <p className={styles.sub}>
          <FormattedMessage id="invite.missing.sub" />
        </p>
        <Link to="/" className={cx(styles.btn, styles.quiet, motion.hover)}>
          <FormattedMessage id="invite.home" />
        </Link>
      </>
    );
  } else if (invite.state !== 'pending') {
    body = (
      <>
        <h1 className={styles.title}>
          <FormattedMessage id={`invite.${invite.state}.title`} values={{ workspace: invite.workspace.name }} />
        </h1>
        <p className={styles.sub}>
          <FormattedMessage id={`invite.${invite.state}.sub`} values={{ inviter: invite.inviterName }} />
        </p>
        <Link to="/" className={cx(styles.btn, styles.quiet, motion.hover)}>
          <FormattedMessage id="invite.home" />
        </Link>
      </>
    );
  } else {
    body = (
      <>
        <span className={styles.mark} aria-hidden="true">
          {Array.from(invite.workspace.name)[0]?.toUpperCase()}
        </span>
        <h1 className={styles.title}>
          <FormattedMessage id="invite.title" values={{ workspace: invite.workspace.name }} />
        </h1>
        <p className={styles.sub}>
          <FormattedMessage id="invite.sub" values={{ inviter: invite.inviterName || intl.formatMessage({ id: 'invite.someone' }), role: intl.formatMessage({ id: `invite.role.${invite.role}` }) }} />
        </p>
        <div className={styles.meta} data-testid="invite-meta">
          <span>
            <FormattedMessage id="invite.for" values={{ email: invite.email }} />
          </span>
          <span>
            <FormattedMessage id="invite.expires" values={{ date: intl.formatDate(invite.expiresAt, { month: 'short', day: 'numeric' }) }} />
          </span>
        </div>
        {error && (
          <p role="alert" className={cx(styles.error, motion.enter)}>
            {error}
          </p>
        )}
        {!signedIn ? (
          <>
            <Link to="/signup" search={{ redirect: here }} className={cx(styles.btn, styles.primary, motion.press)}>
              <FormattedMessage id="invite.signup" />
            </Link>
            <Link to="/login" search={{ redirect: here }} className={cx(styles.btn, styles.quiet, motion.hover)}>
              <FormattedMessage id="invite.login" />
            </Link>
          </>
        ) : mismatch ? (
          <>
            <p className={styles.sub} data-testid="invite-mismatch">
              <FormattedMessage id="invite.mismatch" values={{ email: invite.email, current: session.user?.email ?? '' }} />
            </p>
            <button type="button" className={cx(styles.btn, styles.primary, motion.press)} onClick={() => void switchAccount()}>
              <FormattedMessage id="invite.switch" />
            </button>
          </>
        ) : (
          <button type="button" className={cx(styles.btn, styles.primary, motion.press)} disabled={busy} aria-busy={busy || undefined} onClick={() => void join()}>
            <FormattedMessage id={busy ? 'invite.joining' : 'invite.join'} values={{ workspace: invite.workspace.name }} />
          </button>
        )}
      </>
    );
  }

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.brand} aria-label={intl.formatMessage({ id: 'header.home' })}>
        <svg width="28" height="28" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
          <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
        </svg>
        <span className={styles.wordmark}>
          <FormattedMessage id="app.name" />
        </span>
      </Link>
      <main className={styles.center}>
        <section className={cx(styles.card, motion.enter)} data-testid="invite" data-state={invite ? invite.state : lookup.isPending ? 'loading' : 'missing'}>
          {body}
        </section>
      </main>
    </div>
  );
}
