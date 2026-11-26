import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { fetchShowcase } from './showcase';
import styles from './Login.module.css';

const ShowcaseTiles = lazy(() => import('./ShowcaseTiles'));

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** Runs `cb` once the page has painted and the main thread is idle, so the form is interactive first. */
function afterFirstPaint(cb: () => void): () => void {
  let raf = 0;
  let timer = 0;
  let idle = 0;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  raf = window.requestAnimationFrame(() => {
    timer = window.setTimeout(() => {
      if (w.requestIdleCallback) idle = w.requestIdleCallback(cb, { timeout: 1500 });
      else cb();
    }, 0);
  });
  return () => {
    window.cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    if (idle) w.cancelIdleCallback?.(idle);
  };
}

/** The design's three tone tiles: shown first, and kept when there are no clips. */
function ToneTiles() {
  return (
    <div className={styles.frames} data-showcase="tones">
      <div className={cx(styles.frame, styles.frameA)} />
      <div className={cx(styles.frame, styles.frameB)} />
      <div className={cx(styles.frame, styles.frameC)} />
    </div>
  );
}

/**
 * The right panel's tiles on `/login` and `/signup`: tone tiles at first paint, then
 * (after paint and idle) real template previews from `GET /api/showcase`. The same
 * boxes either way, so nothing shifts. No clips or a failed request: the tone tiles stay.
 */
export function AuthShowcase() {
  const [ready, setReady] = useState(false);
  useEffect(() => afterFirstPaint(() => setReady(true)), []);
  const q = useQuery({ queryKey: ['auth', 'showcase'], queryFn: fetchShowcase, enabled: ready, staleTime: 5 * 60_000, retry: false });
  const items = q.data ?? [];
  if (!items.length) return <ToneTiles />;
  return (
    <Suspense fallback={<ToneTiles />}>
      <ShowcaseTiles items={items} />
    </Suspense>
  );
}
