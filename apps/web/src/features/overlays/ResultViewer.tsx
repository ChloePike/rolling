import { posterUrl } from './backend';
import { cx, Dialog, staggerStyle } from '@rolling/ui';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { FormattedMessage, FormattedNumber, useIntl, type IntlShape } from 'react-intl';
import { Svg, type OverlayIcon } from './icons';
import styles from './ResultViewer.module.css';
import type { ResultAction, ResultActionId, ResultAsset, ResultParam, ResultVersion } from './types';

export interface ResultViewerContentProps {
  /** Result title, e.g. "Two-person product demo · New lighting". */
  title: string;
  /** Who ran it. */
  author: string;
  /** When it finished; shown as "10 min ago". */
  createdAt: Date;
  /** Media aspect ratio as a CSS ratio, e.g. "9/16", "16/9", "2/3". */
  aspectRatio: string;
  /** `video` shows the scrubber and mute button; `image` hides them. */
  mediaKind?: 'video' | 'image';
  /** Versions shown as thumbnails under the player. */
  versions: ResultVersion[];
  /** Selected version id. The last version is "Current". */
  versionId: string;
  onVersionChange: (id: string) => void;
  /** Id of the version marked "Current" (default: the last one). */
  currentVersionId?: string;
  /** Media URL for the selected version; without it a placeholder tile (version tone) is shown. */
  src?: string;
  /** Clip length in seconds (video). */
  durationSec?: number;
  /** Initial playhead in seconds (video). */
  positionSec?: number;
  prompt: string;
  /** D-020: the prompt that rendered when the gateway rewrote it; a version's own value wins. */
  expandedPrompt?: string;
  /** Parameter cards, 2 per row (Model, Mode, Aspect ratio, Duration, Resolution, Seed, Took, Cost). */
  params: ResultParam[];
  /** Assets used as references. */
  assets: ResultAsset[];
  /** Action buttons; the first is the primary (Edit from here). Paid ones show their cost. */
  actions: ResultAction[];
  onAction: (id: ResultActionId, versionId: string) => void;
  favorite?: boolean;
  onFavoriteChange?: (favorite: boolean) => void;
  /** Close button. */
  onClose: () => void;
}

export interface ResultViewerProps extends Omit<ResultViewerContentProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ACTION_ICON: Record<ResultActionId, OverlayIcon> = {
  edit: 'edit',
  regenerate: 'regenerate',
  extend: 'extend',
  hd: 'hd',
  sendToCanvas: 'sendToCanvas',
  download: 'download',
};

export function formatAgo(intl: IntlShape, date: Date, now = Date.now()): string {
  const min = Math.round((now - date.getTime()) / 60000);
  if (min < 1) return intl.formatMessage({ id: 'overlays.viewer.ago.now' });
  if (min < 60) return intl.formatMessage({ id: 'overlays.viewer.ago.minutes' }, { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return intl.formatMessage({ id: 'overlays.viewer.ago.hours' }, { n: h });
  const d = Math.round(h / 24);
  if (d < 7) return intl.formatMessage({ id: 'overlays.viewer.ago.days' }, { n: d });
  return intl.formatDate(date, { month: 'short', day: 'numeric' });
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Full-screen result viewer (ResultViewer.dc.html): player with versions on the
 * left, prompt, parameters, assets and actions on the right. The scrim fades,
 * the panel rises in 320ms; switching versions cross-fades the media in place.
 */
export function ResultViewer({ open, onOpenChange, ...content }: ResultViewerProps) {
  const intl = useIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      bare
      label={intl.formatMessage({ id: 'overlays.viewer.label' })}
      overlayClassName={styles.scrim}
      className={styles.dialog}
    >
      <ResultViewerContent {...content} onClose={() => onOpenChange(false)} />
    </Dialog>
  );
}

/** The viewer's content (both columns), for embedding inside a sized container. */
export function ResultViewerContent({
  title,
  author,
  createdAt,
  aspectRatio,
  mediaKind = 'video',
  versions,
  versionId,
  onVersionChange,
  currentVersionId,
  src,
  durationSec = 15,
  positionSec = 4,
  prompt,
  expandedPrompt: expandedProp,
  params,
  assets,
  actions,
  onAction,
  favorite: favoriteProp = false,
  onFavoriteChange: onFavoriteProp,
  onClose,
}: ResultViewerContentProps) {
  const intl = useIntl();
  // Uncontrolled when the host does not handle favorites.
  const [favLocal, setFavLocal] = useState(favoriteProp);
  const favorite = onFavoriteProp ? favoriteProp : favLocal;
  const onFavoriteChange = onFavoriteProp ?? setFavLocal;
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id: `overlays.viewer.${id}` }, v);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pos, setPos] = useState(positionSec);
  const [copied, setCopied] = useState(false);
  const [copiedEnhanced, setCopiedEnhanced] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const versionsId = useId();
  const version = versions.find((v) => v.id === versionId) ?? versions[0];
  const currentId = currentVersionId ?? versions[versions.length - 1]?.id;
  const expandedPrompt = version?.expandedPrompt ?? expandedProp;
  const versionLabel = version ? (version.id === currentId ? t('current', { version: version.label }) : version.label) : '';

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, src]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard blocked; nothing to do. */
    }
  };

  const copyEnhanced = async () => {
    if (!expandedPrompt) return;
    try {
      await navigator.clipboard.writeText(expandedPrompt);
      setCopiedEnhanced(true);
      setTimeout(() => setCopiedEnhanced(false), 1500);
    } catch {
      /* Clipboard blocked; nothing to do. */
    }
  };

  const ratio = durationSec > 0 ? Math.min(1, pos / durationSec) : 0;
  const mediaStyle: CSSProperties = { aspectRatio, background: version?.tone ?? 'var(--c-surface-5)' };

  return (
    <>
      <div className={styles.stage}>
        <div className={styles.media} style={mediaStyle}>
          {src ? (
            mediaKind === 'video' ? (
              <video
                key={version?.id}
                ref={videoRef}
                className={cx('rl-reveal', styles.mediaEl)}
                src={src}
                poster={posterUrl(src)}
                muted={muted}
                playsInline
                onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
                onEnded={() => setPlaying(false)}
              />
            ) : (
              <img key={version?.id} className={cx('rl-reveal', styles.mediaEl)} src={src} alt={title} />
            )
          ) : (
            <span key={version?.id} className={cx('rl-reveal', styles.mediaEl)} style={{ background: version?.tone }} aria-hidden="true" />
          )}
          {mediaKind === 'video' ? (
            <button type="button" className={styles.play} aria-label={t(playing ? 'pause' : 'play')} onClick={() => setPlaying((p) => !p)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="var(--c-text-1)" aria-hidden="true">
                <path d={playing ? 'M6 4h4v16H6z M14 4h4v16h-4z' : 'M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z'} />
              </svg>
            </button>
          ) : null}
          <span className={styles.verLabel}>{versionLabel}</span>
        </div>

        {mediaKind === 'video' ? (
          <div className={styles.scrub}>
            <span className={styles.time}>{clock(pos)}</span>
            <div
              className={styles.track}
              role="slider"
              tabIndex={0}
              aria-label={t('seek')}
              aria-valuemin={0}
              aria-valuemax={Math.round(durationSec)}
              aria-valuenow={Math.round(pos)}
              aria-valuetext={clock(pos)}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const next = ((e.clientX - r.left) / r.width) * durationSec;
                setPos(next);
                if (videoRef.current) videoRef.current.currentTime = next;
              }}
              onKeyDown={(e) => {
                const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const next = Math.min(durationSec, Math.max(0, pos + d));
                setPos(next);
                if (videoRef.current) videoRef.current.currentTime = next;
              }}
            >
              <span className={styles.fill} style={{ width: `${ratio * 100}%` }} />
            </div>
            <span className={styles.dur}>{clock(durationSec)}</span>
            <button type="button" className={styles.mute} aria-label={t(muted ? 'unmute' : 'mute')} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
              <Svg name="volume" size={14} />
            </button>
          </div>
        ) : null}

        <div className={styles.versions} role="group" aria-labelledby={versionsId}>
          <span id={versionsId} className="rl-visually-hidden">
            {t('versions')}
          </span>
          {versions.map((v) => {
            const on = v.id === version?.id;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={on}
                aria-label={v.label}
                className={styles.version}
                style={{ background: v.thumbnailUrl ? `center / cover url(${v.thumbnailUrl})` : v.tone }}
                onClick={() => onVersionChange(v.id)}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      <aside className={styles.side}>
        <div className={styles.sideHead}>
          <span className={styles.titleBlock}>
            <span className={styles.title}>{title}</span>
            <span className={styles.meta}>{t('meta', { time: formatAgo(intl, createdAt), author })}</span>
          </span>
          <button type="button" className={styles.round} aria-label={t('favorite')} aria-pressed={favorite} onClick={() => onFavoriteChange?.(!favorite)}>
            <Svg name="star" size={15} fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button type="button" className={styles.round} aria-label={intl.formatMessage({ id: 'overlays.close' })} onClick={onClose}>
            <Svg name="close" size={16} />
          </button>
        </div>
        <div className={styles.sideBody}>
          <div className={styles.promptCard}>
            <div className={styles.promptHead}>
              <span className={styles.promptLabel}>{t('prompt')}</span>
              <button type="button" className={styles.copy} onClick={copy}>
                {t(copied ? 'copied' : 'copy')}
              </button>
            </div>
            <span className={styles.prompt}>{prompt}</span>
          </div>
          {expandedPrompt ? (
            <div className={styles.promptCard} data-testid="viewer-enhanced-prompt">
              <div className={styles.promptHead}>
                <span className={styles.promptLabel}>{intl.formatMessage({ id: 'prompt.enhanced.title' })}</span>
                <button type="button" className={styles.copy} onClick={copyEnhanced} aria-label={intl.formatMessage({ id: 'prompt.enhanced.copy' })}>
                  {t(copiedEnhanced ? 'copied' : 'copy')}
                </button>
              </div>
              <span className={styles.prompt}>{expandedPrompt}</span>
            </div>
          ) : null}
          <div className={styles.params}>
            {params.map((p, i) => (
              <div key={p.label} className={cx('rl-stagger', styles.param)} style={staggerStyle(i)}>
                <span className={styles.paramK}>{p.label}</span>
                <span className={styles.paramV}>{p.value}</span>
              </div>
            ))}
          </div>
          {assets.length ? (
            <div className={styles.assets}>
              <span className={styles.assetsLabel}>{t('assets')}</span>
              <div className={styles.assetRow}>
                {assets.map((a) => (
                  <span
                    key={a.id}
                    className={styles.asset}
                    role="img"
                    aria-label={a.name}
                    title={a.name}
                    style={{ background: a.thumbnailUrl ? `center / cover url(${a.thumbnailUrl})` : a.tone }}
                  />
                ))}
              </div>
            </div>
          ) : null}
          <div className={styles.actions}>
            {actions.map((a, i) => (
              <button
                key={a.id}
                type="button"
                disabled={a.disabled}
                className={cx(styles.action, i === 0 ? cx('rl-press', styles.primary) : null)}
                onClick={() => version && onAction(a.id, version.id)}
              >
                <Svg name={ACTION_ICON[a.id]} size={15} />
                <FormattedMessage id={`overlays.viewer.action.${a.id}`} />
                {a.cost ? (
                  <span className={styles.cost}>
                    <FormattedNumber value={a.cost} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
