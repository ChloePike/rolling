import { clipEnd, findClip, isCaptionClip, type Clip, type Edl } from './types';
import { MIN_CLIP_SECONDS } from './ops';

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface Range {
  min: number;
  max: number;
}

function neighbours(edl: Edl, clipId: string) {
  const ref = findClip(edl, clipId);
  if (!ref) return null;
  const clips = [...(ref.track.clips as Clip[])].sort((a, b) => a.start - b.start);
  const i = clips.findIndex((c) => c.id === clipId);
  return { clip: ref.clip, prev: clips[i - 1] ?? null, next: clips[i + 1] ?? null };
}

/** Where a clip's start can move without overlapping its neighbours on the track. */
export function moveRange(edl: Edl, clipId: string): Range | null {
  const n = neighbours(edl, clipId);
  if (!n) return null;
  const dur = clipEnd(n.clip) - n.clip.start;
  return { min: n.prev ? clipEnd(n.prev) : 0, max: n.next ? round(n.next.start - dur) : Infinity };
}

/**
 * Timeline range for a clip's head (`edge: 'start'`) or tail (`edge: 'end'`)
 * during a trim, limited by neighbours, the minimum clip length and, for media,
 * the source (`sourceDuration`).
 */
export function trimRange(edl: Edl, clipId: string, edge: 'start' | 'end', sourceDuration?: number): Range | null {
  const n = neighbours(edl, clipId);
  if (!n) return null;
  const { clip } = n;
  const end = clipEnd(clip);
  if (edge === 'start') {
    let min = n.prev ? clipEnd(n.prev) : 0;
    if (!isCaptionClip(clip)) min = Math.max(min, clip.start - clip.in);
    return { min, max: round(end - MIN_CLIP_SECONDS) };
  }
  let max = n.next ? n.next.start : Infinity;
  if (!isCaptionClip(clip) && sourceDuration !== undefined) max = Math.min(max, round(clip.start + (sourceDuration - clip.in)));
  return { min: round(clip.start + MIN_CLIP_SECONDS), max };
}

export const clamp = (v: number, r: Range) => Math.min(r.max, Math.max(r.min, v));
