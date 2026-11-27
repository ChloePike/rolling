import { cx } from '@rolling/ui';
import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { assetMediaUrl, isMockApi, posterUrl } from '@/features/overlays/backend';
import { EnhancedPrompt, PromptIcon } from '@/features/prompt';
import { clock, isActive, remainingSeconds, type HomeRunCard } from './model';
import styles from './RunCard.module.css';

export interface RunCardActions {
  onCancel: (card: HomeRunCard) => void;
  onRetry: (card: HomeRunCard) => void;
  onRunAgain: (card: HomeRunCard) => void;
  onView: (card: HomeRunCard) => void;
  onOpenCanvas: (card: HomeRunCard) => void;
  onDownload: (card: HomeRunCard) => void;
  onRemove: (card: HomeRunCard) => void;
}

/** Ticks once a second while `on` (elapsed and time left on active cards). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * One Home generation (node card states, handoff 3): starting → queued →
 * generating with real progress → done with the result inline, or failed /
 * canceled with the refund. Prompt, model and settings stay on the card.
 */
export function RunCard({ card, actions, index }: { card: HomeRunCard; actions: RunCardActions; index: number }) {
  const intl = useIntl();
  const active = isActive(card);
  const now = useNow(active);
  const elapsed = Math.max(0, ((card.finishedAt ?? now) - card.createdAt) / 1000);
  const left = remainingSeconds(card, elapsed);
  // A provider that reports 0% the whole time says nothing: the card shows the elapsed time instead of a stuck 0%.
  const pct = card.progress !== null && card.progress > 0 ? Math.round(card.progress * 100) : null;
  const ratio = card.aspect || '9/16';
  const tall = (() => {
    const [w, h] = ratio.split('/').map(Number);
    return (h || 1) >= (w || 1);
  })();
  const media = card.assetIds.slice(0, 4);
  const mock = isMockApi();

  const statusLabel = (() => {
    switch (card.status) {
      case 'starting':
        return intl.formatMessage({ id: 'home.run.status.starting' });
      case 'queued':
        return intl.formatMessage({ id: 'home.run.status.queued' });
      case 'running':
        // A chain (D-005) says which step it is on; the percentage covers both steps.
        if (card.chain?.step) {
          const step = card.chain.step;
          return pct !== null ? intl.formatMessage({ id: `home.run.step.${step}Progress` }, { pct }) : intl.formatMessage({ id: `home.run.step.${step}` });
        }
        return pct !== null ? intl.formatMessage({ id: 'home.run.status.progress' }, { pct }) : intl.formatMessage({ id: 'home.run.status.running' });
      case 'done':
        return intl.formatMessage({ id: 'home.run.status.done' });
      case 'failed':
        return intl.formatMessage({ id: 'home.run.status.failed' });
      case 'canceled':
        return intl.formatMessage({ id: 'home.run.status.canceled' });
    }
  })();

  const costLine =
    card.status === 'failed' || card.status === 'canceled'
      ? intl.formatMessage({ id: 'home.run.noCharge' }, { n: card.refunded || card.credits })
      : card.status === 'done'
        ? card.credits > card.spent && card.spent > 0
          ? intl.formatMessage({ id: 'home.run.chargedPart' }, { n: card.spent, released: card.credits - card.spent })
          : intl.formatMessage({ id: 'home.run.charged' }, { n: card.spent || card.credits })
        : card.status === 'starting'
          ? null
          : intl.formatMessage({ id: 'home.run.held' }, { n: card.credits });

  return (
    <article
      className={cx(styles.card, 'rl-stagger')}
      style={{ ['--rl-i' as string]: Math.min(index, 5) }}
      data-testid="home-run"
      data-status={card.status}
      data-run={card.runId ?? undefined}
      aria-label={intl.formatMessage({ id: 'home.run.label' }, { prompt: card.title })}
      aria-busy={active || undefined}
    >
      <div className={cx(styles.media, tall ? styles.mediaTall : styles.mediaWide)} style={{ aspectRatio: ratio }}>
        {card.status === 'done' && media.length && !mock ? (
          card.kind === 'video' ? (
            <video
              key={media[0]}
              className={cx(styles.video, 'rl-reveal')}
              src={assetMediaUrl(media[0]!)}
              poster={posterUrl(assetMediaUrl(media[0]!))}
              muted
              playsInline
              loop
              controls
              autoPlay={!reducedMotion()}
              preload="metadata"
              aria-label={intl.formatMessage({ id: 'home.run.result' }, { prompt: card.title })}
              data-testid="home-run-video"
            />
          ) : (
            <div className={cx(styles.images, media.length > 1 && styles.imagesGrid)}>
              {media.map((id) => (
                <button key={id} type="button" className={styles.imageBtn} onClick={() => actions.onView(card)} aria-label={intl.formatMessage({ id: 'home.run.open' }, { prompt: card.title })}>
                  <img className={cx(styles.image, 'rl-reveal')} src={assetMediaUrl(id)} alt="" loading="lazy" data-testid="home-run-image" />
                </button>
              ))}
            </div>
          )
        ) : card.status === 'done' ? (
          <button type="button" className={styles.placeholder} onClick={() => actions.onView(card)} aria-label={intl.formatMessage({ id: 'home.run.open' }, { prompt: card.title })}>
            <PromptIcon name={card.kind === 'video' ? 'video' : 'image'} size={20} />
          </button>
        ) : card.status === 'failed' && card.chain?.keyframeAssetId && !mock ? (
          // The animation failed: the first frame it was made from is still a result.
          <button type="button" className={styles.imageBtn} onClick={() => actions.onView(card)} aria-label={intl.formatMessage({ id: 'home.run.open' }, { prompt: card.title })}>
            <img className={cx(styles.image, 'rl-reveal')} src={assetMediaUrl(card.chain.keyframeAssetId)} alt="" loading="lazy" data-testid="home-run-keyframe" />
          </button>
        ) : (
          <div className={cx(styles.placeholder, (card.status === 'failed' || card.status === 'canceled') && styles.placeholderOff)} aria-hidden="true">
            {active ? <span className={styles.pct}>{pct !== null ? `${pct}%` : clock(elapsed)}</span> : <PromptIcon name={card.kind === 'video' ? 'video' : 'image'} size={20} />}
          </div>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.status} data-tone={card.status} role="status" aria-live="polite">
            <span className={styles.dot} aria-hidden="true" />
            {statusLabel}
          </span>
          <span className={styles.time}>
            {active ? (
              left !== null ? (
                <FormattedMessage id="home.run.elapsedLeft" values={{ elapsed: clock(elapsed), left: left >= 60 ? intl.formatMessage({ id: 'home.run.leftMin' }, { n: Math.round(left / 60) }) : intl.formatMessage({ id: 'home.run.leftSec' }, { n: left }) }} />
              ) : (
                clock(elapsed)
              )
            ) : card.finishedAt ? (
              <FormattedMessage id="home.run.took" values={{ time: clock(elapsed) }} />
            ) : null}
          </span>
          <button type="button" className={styles.remove} onClick={() => actions.onRemove(card)} aria-label={intl.formatMessage({ id: 'home.run.remove' }, { prompt: card.title })} disabled={active}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className={styles.prompt}>{card.prompt || card.title}</p>
        <p className={styles.meta}>{card.meta}</p>
        {card.expandedPrompt && card.status === 'done' ? <EnhancedPrompt text={card.expandedPrompt} testId="home-run-enhanced" /> : null}
        {card.chain ? (
          <p className={styles.meta} data-testid="home-run-steps">
            <FormattedMessage id="home.run.steps" />
          </p>
        ) : null}
        {active ? (
          <div
            className={cx('rl-progress', styles.progress)}
            role="progressbar"
            aria-label={intl.formatMessage({ id: 'home.run.progressLabel' })}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(pct !== null ? { 'aria-valuenow': pct } : { 'aria-valuetext': statusLabel })}
          >
            {/* No progress reported: an indeterminate bar beside the elapsed time, never a made-up number. */}
            <span className={cx('rl-progress-fill', pct === null && 'rl-indeterminate')} style={pct !== null ? { width: `${pct}%` } : undefined} />
          </div>
        ) : null}
        {card.status === 'failed' && card.error ? (
          <p className={styles.error} data-testid="home-run-error">
            {card.error}
          </p>
        ) : null}
        {card.status === 'failed' && card.chain?.keyframeAssetId ? (
          <p className={styles.meta}>
            <FormattedMessage id="home.run.keyframeKept" />
          </p>
        ) : null}
        {costLine ? (
          <p className={cx(styles.cost, (card.status === 'failed' || card.status === 'canceled') && styles.refund)} data-testid="home-run-cost">
            {costLine}
          </p>
        ) : null}
        <div className={styles.actions}>
          {active ? (
            <button type="button" className={styles.secondary} onClick={() => actions.onCancel(card)} disabled={!card.runId && !mock}>
              <FormattedMessage id="home.run.cancel" />
            </button>
          ) : null}
          {card.status === 'done' ? (
            <>
              <button type="button" className={cx(styles.primary, 'rl-press')} onClick={() => actions.onView(card)}>
                <FormattedMessage id="home.run.view" />
              </button>
              <button type="button" className={styles.secondary} onClick={() => actions.onOpenCanvas(card)}>
                <FormattedMessage id="home.run.openCanvas" />
              </button>
              <button type="button" className={styles.secondary} onClick={() => actions.onDownload(card)}>
                <FormattedMessage id="home.run.download" />
              </button>
              <button type="button" className={styles.secondary} onClick={() => actions.onRunAgain(card)}>
                <FormattedMessage id="home.run.again" />
              </button>
            </>
          ) : null}
          {card.status === 'failed' || card.status === 'canceled' ? (
            <button type="button" className={cx(styles.primary, 'rl-press')} onClick={() => actions.onRetry(card)}>
              <FormattedMessage id="home.run.retry" />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
