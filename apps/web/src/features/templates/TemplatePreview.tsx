import { Button, cx, Dialog } from '@rolling/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { modelLabel, useModels } from '@/lib/models';
import { useTemplate } from './api';
import styles from './TemplatePreview.module.css';
import type { TemplateDetail, TemplateSummary } from './types';
import { coverStyle } from './cover';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Shots (video nodes, else image nodes) and the distinct models of a template graph. */
export function graphFacts(graph: TemplateDetail['graph'] | undefined): { shots: number; models: string[] } | null {
  if (!graph) return null;
  const gen = graph.nodes.filter((n) => n.kind === 'video' || n.kind === 'image');
  const videos = gen.filter((n) => n.kind === 'video').length;
  const models = [...new Set(gen.map((n) => n.params.model).filter((m): m is string => typeof m === 'string' && m.length > 0))];
  return { shots: videos || gen.length, models };
}

/** CSS aspect (`w/h`) of a template's preview: its cover's size, else the card aspect. */
function previewAspect(t: TemplateSummary): string {
  return t.cover ? `${t.cover.width}/${t.cover.height}` : t.coverAspect;
}

/**
 * Layout by the preview's shape: vertical and squarish media sit beside the details (`side`);
 * landscape media span the panel with the details below (`stacked`), so neither leaves a large
 * empty area next to or under the facts.
 */
export function previewLayout(aspect: string): 'side' | 'stacked' {
  const [w = 1, h = 1] = aspect.split('/').map(Number);
  return w / (h || 1) >= 1.2 ? 'stacked' : 'side';
}

/**
 * Template preview (a card on Home Inspiration or Templates): the silent preview clip large with
 * the native controls (play/pause, scrub, fullscreen; the cover for image templates), then name,
 * description, duration, ratio, shot count and models, and Use template. Esc and the backdrop
 * close it; the arrow keys and the prev/next buttons move through `items` (the current tab).
 * Reduced motion: no autoplay, a play button instead.
 */
export function TemplatePreview({
  template,
  items = [],
  tone,
  ratio,
  onClose,
  onSelect,
  onUse,
}: {
  template: TemplateSummary | null;
  /** The templates of the current tab, for prev/next. */
  items?: readonly TemplateSummary[];
  tone: string;
  /** The aspect ratio it will be made in (Templates: the Aspect ratio facet); defaults to the template's own. */
  ratio?: string;
  onClose: () => void;
  onSelect?: (t: TemplateSummary) => void;
  onUse: (t: TemplateSummary) => void;
}) {
  const intl = useIntl();
  const titleId = useId();
  const t = template;
  const detail = useTemplate(t?.id);
  const models = useModels();
  const facts = graphFacts(detail.data?.id === t?.id ? detail.data?.graph : undefined);
  const index = t ? items.findIndex((x) => x.id === t.id) : -1;
  const prev = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;

  useEffect(() => {
    if (!t || !onSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, video')) return;
      const to = e.key === 'ArrowLeft' ? prev : e.key === 'ArrowRight' ? next : undefined;
      if (!to) return;
      e.preventDefault();
      onSelect(to);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [t, prev, next, onSelect]);

  const shownRatio = ratio ?? t?.ratio;
  const aspect = t ? previewAspect(t) : '1/1';
  return (
    <Dialog open={!!t} onOpenChange={(o) => !o && onClose()} bare labelledBy={titleId} label={t?.name ?? ''}>
      {t ? (
        <div className={styles.panel} data-testid="template-preview" data-layout={previewLayout(aspect)}>
          <PreviewMedia key={t.id} t={t} tone={tone} aspect={aspect} />
          <div className={styles.body}>
            <div className={styles.head}>
              <h2 id={titleId} className={styles.title}>
                {t.name}
              </h2>
              <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'templates.preview.close' })} onClick={onClose}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18 M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className={styles.desc}>{t.description ?? intl.formatMessage({ id: 'templates.preview.desc' })}</p>
            <dl className={styles.facts}>
              {t.durationSec > 0 ? (
                <div className={styles.fact}>
                  <dt>
                    <FormattedMessage id="templates.facet.duration" />
                  </dt>
                  <dd>{intl.formatNumber(t.durationSec, { style: 'unit', unit: 'second', unitDisplay: 'narrow' })}</dd>
                </div>
              ) : null}
              {shownRatio ? (
                <div className={styles.fact}>
                  <dt>
                    <FormattedMessage id="templates.facet.aspect" />
                  </dt>
                  <dd>{shownRatio}</dd>
                </div>
              ) : null}
              {facts ? (
                <div className={styles.fact}>
                  <dt>
                    <FormattedMessage id="templates.preview.shots" />
                  </dt>
                  <dd>
                    <FormattedMessage id="templates.preview.shotCount" values={{ n: facts.shots }} />
                  </dd>
                </div>
              ) : null}
              {facts?.models.length ? (
                <div className={cx(styles.fact, styles.wide)}>
                  <dt>
                    <FormattedMessage id="templates.preview.models" />
                  </dt>
                  <dd>{intl.formatList(facts.models.map((m) => modelLabel(models.data, m)))}</dd>
                </div>
              ) : null}
            </dl>
            <p className={styles.note}>
              <FormattedMessage id="templates.preview.note" />
            </p>
            <div className={styles.actions}>
              {onSelect && items.length > 1 ? (
                <div className={styles.nav}>
                  <button type="button" className={styles.navBtn} disabled={!prev} aria-label={intl.formatMessage({ id: 'templates.preview.prev' })} onClick={() => prev && onSelect(prev)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 18-6-6 6-6" />
                    </svg>
                  </button>
                  <button type="button" className={styles.navBtn} disabled={!next} aria-label={intl.formatMessage({ id: 'templates.preview.next' })} onClick={() => next && onSelect(next)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                </div>
              ) : null}
              <Button variant="primary" className={cx('rl-press')} onClick={() => onUse(t)} autoFocus>
                <FormattedMessage id="templates.use" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The silent clip (loops, native controls) or the cover. Reduced motion shows a play button instead of autoplay. */
function PreviewMedia({ t, tone, aspect }: { t: TemplateSummary; tone: string; aspect: string }) {
  const intl = useIntl();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [still] = useState(reducedMotion);
  const [started, setStarted] = useState(!still);
  const c = t.cover;
  const [aw = 1, ah = 1] = aspect.split('/').map(Number);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !started) return;
    v.muted = true;
    v.play().catch(() => undefined);
  }, [started]);
  return (
    <div className={styles.media} data-portrait={ah > aw || undefined} style={coverStyle(c ? null : t.coverUrl, c?.color ?? tone, { aspectRatio: aspect })}>
      {c ? (
        <picture>
          {c.avif ? <source srcSet={c.avif} type="image/avif" /> : null}
          {c.webp ? <source srcSet={c.webp} type="image/webp" /> : null}
          <img className={styles.poster} src={c.jpg} width={c.width} height={c.height} alt="" />
        </picture>
      ) : null}
      {t.previewUrl ? (
        <>
          <video
            ref={videoRef}
            className={styles.video}
            src={t.previewUrl}
            poster={c ? (c.webp ?? c.jpg) : undefined}
            muted
            loop
            playsInline
            autoPlay={!still}
            controls={started}
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            preload={started ? 'auto' : 'none'}
            data-testid="template-preview-video"
          />
          {started ? null : (
            <button type="button" className={styles.play} aria-label={intl.formatMessage({ id: 'templates.preview.play' })} onClick={() => setStarted(true)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5.5v13l10.5-6.5z" />
              </svg>
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
