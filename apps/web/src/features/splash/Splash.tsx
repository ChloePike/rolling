import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import styles from './Splash.module.css';

/** Total intro length; handoff 8 caps it under 1.2s. */
export const SPLASH_MS = 1150;
const SEEN_KEY = 'rolling.splashSeen';

/**
 * Decides whether the intro plays: only on a cold start of the installed app
 * (display-mode standalone), once per session. `?splash=1` forces it and
 * `?splash=hold` keeps the final frame on screen (previews and tests).
 */
export function shouldPlaySplash(): 'play' | 'hold' | false {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search).get('splash');
  if (q === 'hold') return 'hold';
  if (q === '1') return 'play';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  if (!standalone) return false;
  try {
    if (window.sessionStorage.getItem(SEEN_KEY)) return false;
    window.sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* Storage unavailable: play once for this page load. */
  }
  return 'play';
}

export interface SplashProps {
  /** `hold` keeps the final frame instead of fading out. */
  mode?: 'play' | 'hold';
  /** Called once the intro has finished (or was skipped). */
  onDone?: () => void;
}

/**
 * Cold-start intro (Splash.dc.html), compressed to one pass under 1.2s:
 * the mark pops on the spring curve (400ms brand), the hole follows, a ring
 * pings once, the wordmark slides in, then the layer fades out. Any key or
 * click skips it. Reduced motion: the final frame fades in and out.
 */
export function Splash({ mode = 'play', onDone }: SplashProps) {
  const intl = useIntl();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (mode === 'hold') return;
    const t1 = setTimeout(() => setLeaving(true), SPLASH_MS - 200);
    const t2 = setTimeout(() => onDone?.(), SPLASH_MS);
    const skip = () => {
      setLeaving(true);
      setTimeout(() => onDone?.(), 140);
    };
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [mode, onDone]);

  return (
    <div className={styles.sp} data-motion="" data-leaving={leaving || undefined} data-testid="splash">
      <div className={styles.tc} data-motion="" aria-hidden="true">
        <i data-motion="" />
        <FormattedMessage id="shell.splash.rec" />
      </div>
      <div className={styles.lk} role="img" aria-label={intl.formatMessage({ id: 'shell.splash.label' })}>
        <div className={styles.mk}>
          <span className={styles.r} data-motion="" />
          <span className={styles.c} data-motion="" />
          <span className={styles.h} data-motion="" />
        </div>
        <div className={styles.tx} data-motion="">
          <span data-motion="">
            <span className={styles.en}>
              <FormattedMessage id="app.name" />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
