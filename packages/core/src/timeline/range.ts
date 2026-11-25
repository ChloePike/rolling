import { clipEnd, isCaptionClip, type CaptionClip, type Edl, type MediaClip, type Track } from './types';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const EPS = 1e-6;

/**
 * The part of the timeline between `start` and `end` (seconds) as its own EDL
 * starting at 0: clips outside are dropped, clips crossing an edge are cut
 * (source in/out follow speed and reverse), keyframes and fades shift with the
 * head cut, and a transition is dropped when its clip's tail is cut.
 */
export function cropEdl(edl: Edl, start: number, end: number): Edl {
  const from = Math.max(0, start);
  const to = Math.max(from, end);
  const tracks: Track[] = edl.tracks.map((track) => {
    if (track.kind === 'caption') {
      const clips: CaptionClip[] = [];
      for (const c of track.clips) {
        const s = Math.max(c.start, from);
        const e = Math.min(c.end, to);
        if (e - s <= EPS) continue;
        clips.push({ ...c, start: round(s - from), end: round(e - from) });
      }
      return { ...track, clips };
    }
    const clips: MediaClip[] = [];
    for (const c of track.clips) {
      const cEnd = clipEnd(c);
      const s = Math.max(c.start, from);
      const e = Math.min(cEnd, to);
      if (e - s <= EPS) continue;
      const speed = c.speed ?? 1;
      const head = s - c.start;
      const tail = cEnd - e;
      const next: MediaClip = { ...c, start: round(s - from) };
      if (c.reverse) {
        next.out = round(c.out - head * speed);
        next.in = round(c.in + tail * speed);
      } else {
        next.in = round(c.in + head * speed);
        next.out = round(c.out - tail * speed);
      }
      if (head > EPS) {
        if (c.fadeIn) {
          const f = round(c.fadeIn - head);
          if (f > EPS) next.fadeIn = f;
          else delete next.fadeIn;
        }
        if (c.gainKeyframes) {
          next.gainKeyframes = c.gainKeyframes.map((k) => ({ ...k, t: round(k.t - head) }));
        }
      }
      if (tail > EPS) delete next.transitionOut;
      clips.push(next);
    }
    return { ...track, clips };
  });
  return { ...edl, tracks };
}

/** True when the EDL has nothing to show or hear. */
export function isEmptyEdl(edl: Edl): boolean {
  return edl.tracks.every((t) => t.clips.length === 0 || (t.kind !== 'caption' && t.clips.every((c) => !isCaptionClip(c) && !c.assetId)));
}
