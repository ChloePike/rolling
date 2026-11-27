import { useCallback, useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { ThreadView } from '@rolling/core/collab';
import { getReviewPage, postReviewComment, postReviewDecision, ReviewError, sendReviewCode, unlockReview, verifyReviewCode, type ReviewAccess } from './api';
import type { ReviewPageData, ReviewPageItem } from './types';
import styles from './review.module.css';

/**
 * Public client review page (D-031), `/review/<token>`. No account: a
 * password link asks for the password first; commenting needs a name and an
 * email confirmed with a one-time code. Time-coded comments on videos (the
 * player's current time), approve or request changes. Access tokens stay in
 * this tab only (sessionStorage).
 */

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function stored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Private mode: the tokens just live in memory.
  }
}

type Gate = { kind: 'password'; wrong?: boolean } | { kind: 'gone'; state: 'expired' | 'revoked' | 'missing' } | { kind: 'error' };

export function ReviewPage({ token }: { token: string }) {
  const intl = useIntl();
  const [access, setAccess] = useState<ReviewAccess>(() => ({ pass: stored(`review.pass.${token}`), reviewerToken: stored(`review.reviewer.${token}`) }));
  const [data, setData] = useState<ReviewPageData | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);

  const load = useCallback(
    async (a: ReviewAccess = access) => {
      try {
        setData(await getReviewPage(token, a));
        setGate(null);
      } catch (e) {
        if (e instanceof ReviewError && e.code === 'PASSWORD_REQUIRED') setGate({ kind: 'password' });
        else if (e instanceof ReviewError && e.code === 'LINK_EXPIRED') setGate({ kind: 'gone', state: e.data.state === 'revoked' ? 'revoked' : 'expired' });
        else if (e instanceof ReviewError && e.status === 404) setGate({ kind: 'gone', state: 'missing' });
        else setGate({ kind: 'error' });
      }
    },
    [token, access],
  );
  useEffect(() => {
    document.title = intl.formatMessage({ id: 'review.page.title' });
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const update = (a: ReviewAccess) => {
    setAccess(a);
    store(`review.pass.${token}`, a.pass ?? null);
    store(`review.reviewer.${token}`, a.reviewerToken ?? null);
    return load(a);
  };

  if (gate?.kind === 'password') return <PasswordGate wrong={gate.wrong} onSubmit={async (pw) => {
    try {
      const pass = await unlockReview(token, pw);
      await update({ ...access, pass });
    } catch {
      setGate({ kind: 'password', wrong: true });
    }
  }} />;
  if (gate?.kind === 'gone') {
    return (
      <main className={styles.page} data-testid="review-gone">
        <div className={styles.center}>
          <h1 className={styles.h1}>
            <FormattedMessage id={`review.gone.${gate.state}`} />
          </h1>
          <p className={styles.muted}>
            <FormattedMessage id="review.gone.hint" />
          </p>
        </div>
      </main>
    );
  }
  if (gate?.kind === 'error') {
    return (
      <main className={styles.page}>
        <p className={styles.center} role="alert">
          <FormattedMessage id="review.error" />
        </p>
      </main>
    );
  }
  if (!data) return <main className={styles.page} aria-busy="true" />;
  return <ReviewBody token={token} data={data} access={access} onAccess={update} reload={() => load()} />;
}

function PasswordGate({ wrong, onSubmit }: { wrong?: boolean; onSubmit: (pw: string) => Promise<void> }) {
  const intl = useIntl();
  const [pw, setPw] = useState('');
  return (
    <main className={styles.page}>
      <form
        className={styles.card}
        data-testid="review-password"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) void onSubmit(pw);
        }}
      >
        <h1 className={styles.h1}>
          <FormattedMessage id="review.password.title" />
        </h1>
        <label className={styles.label}>
          <FormattedMessage id="review.password.label" />
          <input className={styles.input} type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} aria-label={intl.formatMessage({ id: 'review.password.label' })} />
        </label>
        {wrong ? (
          <p className={styles.error} role="alert">
            <FormattedMessage id="review.password.wrong" />
          </p>
        ) : null}
        <button type="submit" className={styles.primary} disabled={!pw}>
          <FormattedMessage id="review.password.submit" />
        </button>
      </form>
    </main>
  );
}

function ReviewBody({ token, data, access, onAccess, reload }: { token: string; data: ReviewPageData; access: ReviewAccess; onAccess: (a: ReviewAccess) => Promise<void>; reload: () => Promise<void> }) {
  const intl = useIntl();
  const { link } = data;
  return (
    <main className={styles.page} data-testid="review-page">
      <header className={styles.header}>
        <div>
          <h1 className={styles.h1}>{link.title}</h1>
          <p className={styles.muted}>
            {[link.workspaceName ? intl.formatMessage({ id: 'review.page.from' }, { workspace: link.workspaceName }) : null, link.expiresAt ? intl.formatMessage({ id: 'review.page.expires' }, { date: intl.formatDate(link.expiresAt, { month: 'long', day: 'numeric' }) }) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span className={styles.status} data-status={link.status} data-testid="review-status">
          <FormattedMessage id={`review.status.${link.status}`} />
        </span>
      </header>
      <div className={styles.layout}>
        <section className={styles.items}>
          {data.items.map((it) => (
            <ItemCard key={it.id} item={it} token={token} access={access} threads={data.threads.filter((t) => t.anchor.kind === 'review' && t.anchor.itemId === it.id)} canComment={!!data.me} onPosted={reload} />
          ))}
        </section>
        <aside className={styles.side}>
          {data.me ? <Decision token={token} access={access} me={data.me} onDone={reload} /> : <Join token={token} access={access} onVerified={(reviewerToken) => onAccess({ ...access, reviewerToken })} />}
        </aside>
      </div>
    </main>
  );
}

function ItemCard({ item, token, access, threads, canComment, onPosted }: { item: ReviewPageItem; token: string; access: ReviewAccess; threads: ThreadView[]; canComment: boolean; onPosted: () => Promise<void> }) {
  const intl = useIntl();
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const timed = item.kind === 'video' || item.kind === 'audio';
  const post = async (body: string, threadId?: string) => {
    setBusy(true);
    try {
      await postReviewComment(token, access, { itemId: item.id, at: timed && !threadId ? Math.round((video.current?.currentTime ?? now) * 10) / 10 : null, body, ...(threadId ? { threadId } : {}) });
      await onPosted();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={styles.item} data-testid="review-item">
      <h2 className={styles.h2}>{item.title}</h2>
      <div className={styles.media}>
        {item.withheld ? (
          <p className={styles.withheld} data-testid="review-withheld">
            <FormattedMessage id={`review.withheld.${item.withheld}`} />
          </p>
        ) : item.kind === 'image' ? (
          <img src={item.media?.url ?? undefined} alt={item.title} className={styles.mediaEl} />
        ) : item.kind === 'audio' ? (
          <audio ref={video as unknown as React.RefObject<HTMLAudioElement>} src={item.media?.url ?? undefined} controls className={styles.audio} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
        ) : (
          <video ref={video} src={item.media?.url ?? undefined} poster={item.media?.posterUrl ?? undefined} controls playsInline className={styles.mediaEl} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
        )}
      </div>
      <div className={styles.threads}>
        {threads.length === 0 ? (
          <p className={styles.muted}>
            <FormattedMessage id="review.comments.empty" />
          </p>
        ) : null}
        {threads.map((t) => (
          <div key={t.id} className={styles.thread} data-testid="review-thread">
            {t.anchor.kind === 'review' && t.anchor.at !== null ? (
              <button
                type="button"
                className={styles.time}
                onClick={() => {
                  if (video.current && t.anchor.kind === 'review' && t.anchor.at !== null) video.current.currentTime = t.anchor.at;
                }}
              >
                <FormattedMessage id="review.item.at" values={{ at: fmt(t.anchor.at) }} />
              </button>
            ) : null}
            {t.comments.filter((c) => !c.deleted).map((c) => (
              <p key={c.id} className={styles.comment}>
                <strong>{c.author.name}</strong> {c.body}
              </p>
            ))}
            {canComment ? <ReplyBox busy={busy} onSend={(b) => post(b, t.id)} label={intl.formatMessage({ id: 'review.comment.reply' })} /> : null}
          </div>
        ))}
      </div>
      {canComment ? (
        <form
          className={styles.commentForm}
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (body) void post(body).then((ok) => ok && setText(''));
          }}
        >
          <textarea className={styles.textarea} value={text} maxLength={4000} rows={2} placeholder={intl.formatMessage({ id: 'review.comment.placeholder' })} aria-label={intl.formatMessage({ id: 'review.comment.placeholder' })} onChange={(e) => setText(e.target.value)} data-testid="review-comment-input" />
          <button type="submit" className={styles.primary} disabled={!text.trim() || busy} data-testid="review-comment-submit">
            {timed ? <FormattedMessage id="review.item.commentAt" values={{ at: fmt(now) }} /> : <FormattedMessage id="review.item.commentAll" />}
          </button>
        </form>
      ) : null}
    </article>
  );
}

function ReplyBox({ onSend, busy, label }: { onSend: (b: string) => Promise<boolean>; busy: boolean; label: string }) {
  const [text, setText] = useState('');
  return (
    <form
      className={styles.replyForm}
      onSubmit={(e) => {
        e.preventDefault();
        const b = text.trim();
        if (b) void onSend(b).then((ok) => ok && setText(''));
      }}
    >
      <input className={styles.input} value={text} maxLength={4000} placeholder={label} aria-label={label} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className={styles.secondary} disabled={!text.trim() || busy}>
        {label}
      </button>
    </form>
  );
}

function Join({ token, access, onVerified }: { token: string; access: ReviewAccess; onVerified: (reviewerToken: string) => Promise<void> }) {
  const intl = useIntl();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={styles.card}
      data-testid="review-join"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (!sent) {
            await sendReviewCode(token, access, { name: name.trim(), email: email.trim() });
            setSent(true);
          } else {
            const r = await verifyReviewCode(token, access, { email: email.trim(), code: code.trim() });
            await onVerified(r.reviewerToken);
          }
        } catch (err) {
          const c = err instanceof ReviewError ? err.code : '';
          setError(intl.formatMessage({ id: c === 'INVALID_CODE' ? 'review.join.invalid' : c === 'CODE_EXPIRED' ? 'review.join.expired' : c === 'RATE_LIMITED' ? 'review.join.wait' : 'review.error' }));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className={styles.h2}>
        <FormattedMessage id="review.join.title" />
      </h2>
      {!sent ? (
        <>
          <label className={styles.label}>
            <FormattedMessage id="review.join.name" />
            <input className={styles.input} value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} data-testid="review-name" />
          </label>
          <label className={styles.label}>
            <FormattedMessage id="review.join.email" />
            <input className={styles.input} type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value)} data-testid="review-email" />
          </label>
        </>
      ) : (
        <>
          <p className={styles.muted}>
            <FormattedMessage id="review.join.sent" values={{ email }} />
          </p>
          <label className={styles.label}>
            <FormattedMessage id="review.join.code" />
            <input className={styles.input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} data-testid="review-code" />
          </label>
        </>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className={styles.primary} disabled={busy || (!sent ? !name.trim() || !/^\S+@\S+\.\S+$/.test(email) : code.length !== 6)} data-testid="review-join-submit">
        <FormattedMessage id={sent ? 'review.join.verify' : 'review.join.send'} />
      </button>
    </form>
  );
}

function Decision({ token, access, me, onDone }: { token: string; access: ReviewAccess; me: NonNullable<ReviewPageData['me']>; onDone: () => Promise<void> }) {
  const intl = useIntl();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approved' | 'changes_requested') => {
    setBusy(true);
    try {
      await postReviewDecision(token, access, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
      setNote('');
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.card} data-testid="review-decision">
      <p className={styles.muted}>
        <FormattedMessage id="review.join.as" values={{ name: me.name }} />
      </p>
      <h2 className={styles.h2}>
        <FormattedMessage id="review.decide.title" />
      </h2>
      {me.decision ? (
        <p className={styles.done} data-decision={me.decision}>
          <FormattedMessage id={`review.decide.done.${me.decision}`} />
        </p>
      ) : null}
      <textarea className={styles.textarea} rows={2} maxLength={2000} value={note} placeholder={intl.formatMessage({ id: 'review.decide.note' })} aria-label={intl.formatMessage({ id: 'review.decide.note' })} onChange={(e) => setNote(e.target.value)} />
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void decide('changes_requested')} data-testid="review-changes">
          <FormattedMessage id="review.decide.changes" />
        </button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void decide('approved')} data-testid="review-approve">
          <FormattedMessage id="review.decide.approve" />
        </button>
      </div>
    </div>
  );
}
