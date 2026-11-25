/**
 * Edit decision list (EDL), as in docs/architecture.md section 8, and the
 * timeline patch ops from docs/harness.md section 5.
 *
 * Times are seconds. Media clips place source range `[in, out)` at timeline
 * `start`; caption clips carry timeline `start`/`end` directly.
 *
 * Extensions over the documented format (kept optional so documented EDLs
 * stay valid): `gainKeyframes` for keyframed gain (music envelope),
 * `fadeIn` (seconds), and `replaceShot.assetId` so a regenerated shot can name
 * its new asset.
 */

export type TrackKind = 'caption' | 'video' | 'voice' | 'music';

export interface Transition {
  type: 'dissolve';
  /** Seconds, centered on the cut. */
  dur: number;
}

export interface GainKeyframe {
  /** Seconds from the clip's timeline start. */
  t: number;
  db: number;
}

export interface CaptionClip {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface MediaClip {
  id: string;
  /** `null` while the shot is planned but not generated yet. */
  assetId: string | null;
  nodeId?: string;
  in: number;
  out: number;
  start: number;
  transitionOut?: Transition;
  gainDb?: number;
  duckUnder?: string[];
  gainKeyframes?: GainKeyframe[];
  fadeIn?: number;
}

export type Clip = CaptionClip | MediaClip;

export interface CaptionTrack {
  id: string;
  kind: 'caption';
  clips: CaptionClip[];
}

export interface MediaTrack {
  id: string;
  kind: 'video' | 'voice' | 'music';
  clips: MediaClip[];
}

export type Track = CaptionTrack | MediaTrack;

export interface Edl {
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
}

export type TimelineOp =
  | { op: 'trim'; clipId: string; in?: number; out?: number }
  | { op: 'move'; clipId: string; start: number }
  | { op: 'split'; clipId: string; at: number }
  | { op: 'remove'; clipId: string; ripple: boolean }
  | { op: 'setGain'; clipId: string; gainDb: number }
  | { op: 'setCaption'; clipId: string; text: string }
  | { op: 'replaceShot'; clipId: string; nodeId: string; assetId?: string };

export function isCaptionClip(clip: Clip): clip is CaptionClip {
  return 'text' in clip;
}

export function clipStart(clip: Clip): number {
  return clip.start;
}

export function clipEnd(clip: Clip): number {
  return isCaptionClip(clip) ? clip.end : clip.start + (clip.out - clip.in);
}

export function clipDuration(clip: Clip): number {
  return clipEnd(clip) - clip.start;
}

export interface ClipRef {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

export function findClip(edl: Edl, clipId: string): ClipRef | null {
  for (let trackIndex = 0; trackIndex < edl.tracks.length; trackIndex++) {
    const track = edl.tracks[trackIndex]!;
    const clips = track.clips as Clip[];
    const clipIndex = clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { track, trackIndex, clip: clips[clipIndex]!, clipIndex };
  }
  return null;
}

/** End of the last clip on any track. */
export function edlDuration(edl: Edl): number {
  let end = 0;
  for (const track of edl.tracks) for (const clip of track.clips as Clip[]) end = Math.max(end, clipEnd(clip));
  return end;
}
