import { clipEnd, type Clip, type Edl } from './types';

/** Snap distance in CSS pixels; divide by pixels per second for seconds. */
export const SNAP_PX = 8;

export interface SnapResult {
  time: number;
  /** The candidate it snapped to, or null when nothing was close enough. */
  target: number | null;
}

/** Times a dragged edge can snap to: 0, the playhead and every clip edge (except excluded clips). */
export function snapCandidates(edl: Edl, opts: { playhead?: number; exclude?: ReadonlySet<string> | string } = {}): number[] {
  const exclude = typeof opts.exclude === 'string' ? new Set([opts.exclude]) : opts.exclude;
  const out = new Set<number>([0]);
  if (opts.playhead !== undefined) out.add(opts.playhead);
  for (const track of edl.tracks) {
    for (const clip of track.clips as Clip[]) {
      if (exclude?.has(clip.id)) continue;
      out.add(clip.start);
      out.add(clipEnd(clip));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Snaps a time to the nearest candidate within `threshold` seconds. */
export function snapTime(time: number, candidates: readonly number[], threshold: number): SnapResult {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - time);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best === null ? { time, target: null } : { time: best, target: best };
}

/** Snaps a moving clip by whichever of its edges lands closer to a candidate. */
export function snapMove(start: number, duration: number, candidates: readonly number[], threshold: number): SnapResult {
  const head = snapTime(start, candidates, threshold);
  const tail = snapTime(start + duration, candidates, threshold);
  const headDist = head.target === null ? Infinity : Math.abs(head.target - start);
  const tailDist = tail.target === null ? Infinity : Math.abs(tail.target - (start + duration));
  if (headDist === Infinity && tailDist === Infinity) return { time: start, target: null };
  return headDist <= tailDist ? { time: head.time, target: head.target } : { time: tail.time - duration, target: tail.target };
}
