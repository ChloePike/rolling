import { applyOps } from './ops';
import { clipEnd, edlDuration, isCaptionClip, type Clip, type Edl, type MediaClip, type TimelineOp } from './types';

/** A span of one clip that a proposal changes; drawn as an outline on the timeline. */
export interface Highlight {
  clipId: string;
  /** Timeline seconds, before the proposal is applied. */
  from: number;
  to: number;
  kind: 'remove' | 'change';
}

export interface PlannedEdit {
  ops: TimelineOp[];
  highlights: Highlight[];
  /** Seconds removed from the sequence. */
  removed: number;
}

/** Shots are not shortened below this when planning a cut. */
const MIN_SHOT = 1;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Plans "cut to N seconds" without regenerating anything: trims the tail of
 * the last shots (never below 1s), slides later shots left to close the gap,
 * and trims or removes captions and audio that run past the new end.
 * Returns null when the cut is not possible this way.
 */
export function planCutTo(edl: Edl, target: number): PlannedEdit | null {
  const duration = edlDuration(edl);
  if (target <= 0 || target >= duration) return null;
  let toRemove = round(duration - target);
  const ops: TimelineOp[] = [];
  const highlights: Highlight[] = [];

  const videoTrack = edl.tracks.find((t) => t.kind === 'video');
  if (videoTrack) {
    const shots = [...(videoTrack.clips as MediaClip[])].sort((a, b) => a.start - b.start);
    const cuts = new Map<string, number>();
    for (let i = shots.length - 1; i >= 0 && toRemove > 1e-6; i--) {
      const s = shots[i]!;
      const cut = Math.min(toRemove, Math.max(0, s.out - s.in - MIN_SHOT));
      if (cut > 0) {
        cuts.set(s.id, round(cut));
        toRemove = round(toRemove - cut);
      }
    }
    if (toRemove > 1e-6) return null;
    let shift = 0;
    for (const s of shots) {
      const cut = cuts.get(s.id) ?? 0;
      const newStart = round(s.start - shift);
      if (shift > 0) ops.push({ op: 'move', clipId: s.id, start: newStart });
      if (cut > 0) {
        ops.push({ op: 'trim', clipId: s.id, out: round(s.out - cut) });
        highlights.push({ clipId: s.id, from: round(clipEnd(s) - cut), to: clipEnd(s), kind: 'remove' });
      }
      shift = round(shift + cut);
    }
  }

  for (const track of edl.tracks) {
    if (track.kind === 'video') continue;
    for (const c of track.clips as Clip[]) {
      const end = clipEnd(c);
      if (end <= target + 1e-6) continue;
      highlights.push({ clipId: c.id, from: Math.max(c.start, target), to: end, kind: 'remove' });
      if (c.start >= target - 1e-6) ops.push({ op: 'remove', clipId: c.id, ripple: false });
      else if (isCaptionClip(c)) ops.push({ op: 'trim', clipId: c.id, out: target });
      else ops.push({ op: 'trim', clipId: c.id, out: round(c.in + (target - c.start)) });
    }
  }

  if (!applyOps(edl, ops).ok) return null;
  return { ops, highlights, removed: round(duration - target) };
}
