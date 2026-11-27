import { useState } from 'react';
import { useIntl } from 'react-intl';
import { cx } from '@rolling/ui';
import { initialsOf, type PresenceEntry } from '@rolling/core/collab';
import { peopleOf } from './presence';
import { PinIcon } from './CanvasCollabLayer';
import styles from './collab.module.css';

const MAX_AVATARS = 4;

/**
 * Canvas top bar (D-031): avatars of the other people on the project now and
 * the Comments button with the unread count. The avatars appear only when
 * someone else is here.
 */
export function CollabBar({ entries, unread, open, onToggle }: { entries: readonly PresenceEntry[]; unread: number; open: boolean; onToggle: () => void }) {
  const intl = useIntl();
  const people = peopleOf(entries);
  const shown = people.slice(0, MAX_AVATARS);
  const more = people.length - shown.length;
  return (
    <>
      {people.length ? (
        <div className={styles.avatars} role="group" aria-label={intl.formatMessage({ id: 'collab.presence.label' }, { n: people.length })} data-testid="presence-avatars">
          {shown.map((p) => (
            <Avatar key={p.userId} name={p.name} image={p.image} title={intl.formatMessage({ id: p.canEdit ? 'collab.presence.editing' : 'collab.presence.viewing' }, { name: p.name })} />
          ))}
          {more > 0 ? <span className={cx(styles.avatar, styles.avatarMore)}>{intl.formatMessage({ id: 'collab.presence.more' }, { n: more })}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.barBtn}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={intl.formatMessage({ id: 'collab.comments.button' }, { n: unread })}
        data-testid="comments-button"
        onClick={onToggle}
      >
        <PinIcon size={15} />
        {unread > 0 ? (
          <span className={styles.barBadge} data-testid="comments-unread">
            {intl.formatNumber(unread)}
          </span>
        ) : null}
      </button>
    </>
  );
}

export function Avatar({ name, image, title, size = 28 }: { name: string; image: string | null; title?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={styles.avatar} title={title} aria-label={title ?? name} role="img" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} data-testid="presence-avatar">
      {image && !broken ? <img src={image} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : initialsOf(name)}
    </span>
  );
}
