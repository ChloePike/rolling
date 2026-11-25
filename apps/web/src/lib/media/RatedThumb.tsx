import { useState, type CSSProperties, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { usePref } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import styles from './RatedThumb.module.css';

/**
 * Content rating of an asset (D-005: `assets.rating`). Unknown (null) counts
 * as safe for display; the server already strips mature items from public
 * surfaces, this is the client-side second line.
 */
export type ContentRating = 'safe' | 'suggestive' | 'explicit';

export const isMatureRating = (r: ContentRating | null | undefined): boolean => r === 'suggestive' || r === 'explicit';

/** Whether this viewer sees mature media unblurred: an active plan, a workspace that allows it, and the preference on (D-005). */
export function useMatureVisible(): boolean {
  const { matureAllowed } = useSession();
  const pref = usePref('matureContent');
  return matureAllowed && pref;
}

/** Items a public surface (profile, share, templates, public library) may list: never suggestive or explicit. */
export function publicSafe<T extends { rating?: ContentRating | null; mature?: boolean }>(items: readonly T[]): T[] {
  return items.filter((i) => !i.mature && !isMatureRating(i.rating));
}

export interface RatedThumbProps {
  src: string | null | undefined;
  alt: string;
  rating?: ContentRating | null;
  kind?: 'image' | 'video';
  /** Poster for video thumbs. */
  poster?: string | null;
  /** Public surfaces render mature items as a neutral "hidden" tile, never the media. */
  publicSurface?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Overlays drawn above the media (badges, duration). */
  children?: ReactNode;
  onReveal?: () => void;
}

/**
 * A media thumbnail that respects content ratings (D-005): suggestive and
 * explicit items are blurred with a "Show" button unless the viewer has mature
 * content allowed; on public surfaces they are never shown. Shared by the
 * account side and the creation features (assets, canvas, Activity, `@` picker).
 */
export function RatedThumb({ src, alt, rating, kind = 'image', poster, publicSurface, className, style, children, onReveal }: RatedThumbProps) {
  const intl = useIntl();
  const visible = useMatureVisible();
  const [revealed, setRevealed] = useState(false);
  const mature = isMatureRating(rating);
  const cls = [styles.wrap, className].filter(Boolean).join(' ');

  if (mature && publicSurface) {
    return (
      <span className={cls} style={style} data-rating={rating} data-hidden="true">
        <span className={styles.hidden}>{intl.formatMessage({ id: 'shell.media.hidden' })}</span>
      </span>
    );
  }

  const blurred = mature && !visible && !revealed;
  const mediaCls = [styles.media, blurred && styles.blurred].filter(Boolean).join(' ');
  return (
    <span className={cls} style={style} data-rating={rating ?? 'safe'} data-blurred={blurred || undefined}>
      {src ? (
        kind === 'video' && !poster ? (
          <video className={mediaCls} src={src} muted playsInline preload="metadata" aria-label={alt} />
        ) : (
          <img className={mediaCls} src={kind === 'video' ? poster! : src} alt={blurred ? '' : alt} loading="lazy" decoding="async" draggable={false} />
        )
      ) : null}
      {blurred ? (
        <span className={styles.veil}>
          <span>{intl.formatMessage({ id: rating === 'explicit' ? 'shell.media.explicit' : 'shell.media.suggestive' })}</span>
          <button
            type="button"
            className={styles.show}
            aria-label={intl.formatMessage({ id: 'shell.media.show.label' }, { name: alt })}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setRevealed(true);
              onReveal?.();
            }}
          >
            {intl.formatMessage({ id: 'shell.media.show' })}
          </button>
        </span>
      ) : (
        children
      )}
    </span>
  );
}
