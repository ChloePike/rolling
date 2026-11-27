import { useEffect, useRef, useState } from 'react';

/**
 * Real progress only (handoff 7). A provider that reports none sends 0 (or nothing)
 * the whole time a job runs, so only a value above 0 is a number to show; otherwise
 * the UI shows the elapsed time and an indeterminate bar (`rl-indeterminate`).
 * `p` is a fraction (0..1).
 */
export function knownProgress(p: number | null | undefined): number | null {
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? Math.min(1, p) : null;
}

/** `m:ss` for an elapsed time in seconds. */
export function elapsedClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Seconds since `since` (epoch ms), ticking once a second while `active`. Without
 * `since`, counts from when this view first saw it active (e.g. a canvas node that
 * started generating), and resets when it stops.
 */
export function useElapsed(active: boolean, since?: number | null): number {
  const seen = useRef<number | null>(null);
  if (active && seen.current === null) seen.current = Date.now();
  if (!active) seen.current = null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  const start = since ?? seen.current ?? now;
  return Math.max(0, (now - start) / 1000);
}
