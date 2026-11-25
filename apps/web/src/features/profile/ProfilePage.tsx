import { useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMe } from '@/features/account/api';
import { motion, ResultModal, Segmented } from '@/features/account/shared';
import { useProfile } from './api';
import styles from './Profile.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
const TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)', 'var(--c-tone-moss)', 'var(--c-tone-clay)', 'var(--c-tone-slate)'];

type ProfileTab = 'published' | 'template';

function timecode(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** `/u/$handle` (Profile.dc.html). Public page: mature works are never listed (D-005). */
export function ProfilePage({ handle }: { handle: string }) {
  const intl = useIntl();
  const toast = useToast();
  const { data: profile } = useProfile(handle);
  const { data: me } = useMe();
  const [tab, setTab] = useState<ProfileTab>('published');
  const [viewing, setViewing] = useState<{ title: string; durationSec: number } | null>(null);
  const navigate = useNavigate();
  if (!profile) return null;
  const own = me?.user.handle === profile.handle;
  const count = (k: ProfileTab) => profile.works.filter((w) => w.kind === k).length;
  const works = profile.works.filter((w) => w.kind === tab);

  async function share() {
    const url = `${window.location.origin}/u/${profile!.handle}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can be blocked; the toast still names the link.
    }
    toast.show({ message: intl.formatMessage({ id: 'profile.share.copied' }) });
  }

  return (
    <div className={styles.page}>
      <section className={styles.head} aria-labelledby="profile-name">
        <span className={styles.avatar} aria-hidden="true">
          {profile.name.slice(0, 1)}
        </span>
        <div className={styles.who}>
          <h1 id="profile-name" className={styles.name}>
            {profile.name}
          </h1>
          <span className={styles.handle}>@{profile.handle}</span>
          <p className={styles.bio}>{profile.bio ?? intl.formatMessage({ id: 'profile.bio.placeholder' })}</p>
        </div>
        <div className={styles.actions}>
          {own && (
            <Link to="/settings/$section" params={{ section: 'account' }} className={cx(styles.btn, motion.hover)}>
              <FormattedMessage id="profile.edit" />
            </Link>
          )}
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => void share()}>
            <FormattedMessage id="profile.share" />
          </button>
        </div>
      </section>
      <Segmented<ProfileTab>
        kind="tablist"
        label={intl.formatMessage({ id: 'profile.tabs' })}
        value={tab}
        onChange={setTab}
        className={styles.tabs}
        optionClassName={styles.tab}
        indicatorClassName={styles.tabLine}
        options={(['published', 'template'] as const).map((k) => ({
          value: k,
          label: (
            <>
              <FormattedMessage id={`profile.tab.${k}`} />
              <span className={styles.count}>{intl.formatNumber(count(k))}</span>
            </>
          ),
        }))}
      />
      <div key={tab} className={styles.grid} role="tabpanel" aria-label={intl.formatMessage({ id: `profile.tab.${tab}` })}>
        {works.map((w, i) => (
          <button
            key={w.id}
            type="button"
            className={cx(styles.work, motion.stagger)}
            style={{ '--i': i } as CSSProperties}
            data-work={w.id}
            onClick={() => (tab === 'template' ? void navigate({ to: '/templates' }) : setViewing({ title: w.title, durationSec: w.durationSec }))}
          >
            <span className={styles.thumb} style={{ background: TONES[i % TONES.length] }}>
              <span className={styles.dur}>{timecode(w.durationSec)}</span>
            </span>
            <span className={styles.title}>{w.title}</span>
          </button>
        ))}
        {works.length === 0 && (
          <p className={styles.empty}>
            <FormattedMessage id="profile.empty" />
          </p>
        )}
      </div>
      <ResultModal
        item={viewing ? { title: viewing.title, prompt: viewing.title, aspect: '9/16', kind: 'video', minutesAgo: 60 * 24, durationSec: viewing.durationSec, params: [] } : null}
        actions={own ? [{ id: 'edit' }, { id: 'download' }] : [{ id: 'download' }]}
        onClose={() => setViewing(null)}
        onAction={(id) => {
          setViewing(null);
          if (id === 'edit') void navigate({ to: '/create/quick' });
          else toast.show({ message: intl.formatMessage({ id: 'profile.downloaded' }) });
        }}
      />
    </div>
  );
}
