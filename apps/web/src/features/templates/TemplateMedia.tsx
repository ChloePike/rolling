import { useEffect, useRef, useState } from 'react';
import type { TemplateSummary } from './types';
import styles from './TemplateMedia.module.css';

/** True when the viewer asked for less motion or less data: show the poster only. */
export function previewsAllowed(win: Window = window): boolean {
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const conn = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

/**
 * A template card's picture (built-in covers, migration 0020): the poster at once
 * (AVIF / WebP / JPEG, sized from the stored dimensions so nothing shifts), and for
 * video templates a muted looping preview. The preview loads nothing
 * (`preload="none"`) until it should play: while the card is hovered or focused
 * on devices that hover, else while the card is in view. Reduced motion and
 * data saver keep the poster only. Place it first inside the card.
 */
export function TemplateMedia({ t }: { t: Pick<TemplateSummary, 'cover' | 'previewUrl'> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const preview = t.previewUrl ?? null;

  useEffect(() => {
    // The card is the nearest `data-template-card` (it gets hover and focus), else the direct parent.
    const card = ref.current?.closest<HTMLElement>('[data-template-card]') ?? ref.current?.parentElement;
    if (!card || !preview || !previewsAllowed()) return;
    if (window.matchMedia?.('(hover: hover)').matches) {
      const on = () => setActive(true);
      const off = () => setActive(card.matches(':hover') || card.contains(document.activeElement));
      card.addEventListener('pointerenter', on);
      card.addEventListener('pointerleave', off);
      card.addEventListener('focusin', on);
      const blur = () => requestAnimationFrame(off);
      card.addEventListener('focusout', blur);
      return () => {
        card.removeEventListener('pointerenter', on);
        card.removeEventListener('pointerleave', off);
        card.removeEventListener('focusin', on);
        card.removeEventListener('focusout', blur);
      };
    }
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setActive(!!e && e.isIntersecting && e.intersectionRatio >= 0.6), { threshold: [0, 0.6, 1] });
    io.observe(card);
    return () => io.disconnect();
  }, [preview]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active) {
      setArmed(true);
      v.play().catch(() => undefined);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, [active]);

  const c = t.cover;
  if (!c) return null;
  return (
    <span ref={ref} className={styles.media} aria-hidden="true">
      <picture>
        {c.avif ? <source srcSet={c.avif} type="image/avif" /> : null}
        {c.webp ? <source srcSet={c.webp} type="image/webp" /> : null}
        <img className={styles.poster} src={c.jpg} width={c.width} height={c.height} alt="" decoding="async" data-testid="template-poster" />
      </picture>
      {preview ? (
        <video
          ref={videoRef}
          className={styles.video}
          src={preview}
          poster={c.webp ?? c.jpg}
          muted
          loop
          playsInline
          disablePictureInPicture
          preload={armed ? 'auto' : 'none'}
          tabIndex={-1}
          data-playing={playing || undefined}
          onPlaying={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          data-testid="template-preview"
        />
      ) : null}
    </span>
  );
}
