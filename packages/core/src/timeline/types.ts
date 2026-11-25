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
  /** Picture transform (video clips). Missing means identity. */
  transform?: ClipTransform;
  /** Playback speed, 1 = normal. The clip lasts `(out - in) / speed` on the timeline. */
  speed?: number;
  /** Plays the source range backwards. */
  reverse?: boolean;
}

/** Picture transform of a video clip: scale 1 = 100%, position in output pixels, rotation in degrees, opacity 0..1. */
export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
}

export const IDENTITY_TRANSFORM: ClipTransform = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };

/** Speed limits for `setSpeed`. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

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
  | { op: 'replaceShot'; clipId: string; nodeId: string; assetId?: string }
  | { op: 'setTransform'; clipId: string; transform: Partial<ClipTransform> }
  /** Changes speed (and direction); later clips on the same track ripple so nothing overlaps. */
  | { op: 'setSpeed'; clipId: string; speed: number; reverse?: boolean }
  | { op: 'setFade'; clipId: string; fadeIn: number }
  | { op: 'setTransition'; clipId: string; transition: Transition | null }
  /** Adds a clip to a track; refused when it overlaps. */
  | { op: 'insert'; trackId: string; clip: Clip };

export function isCaptionClip(clip: Clip): clip is CaptionClip {
  return 'text' in clip;
}

export function clipStart(clip: Clip): number {
  return clip.start;
}

export function clipEnd(clip: Clip): number {
  return isCaptionClip(clip) ? clip.end : clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
}

/** Source time shown at timeline time `t` inside a media clip (speed and reverse applied). */
export function sourceTime(clip: MediaClip, t: number): number {
  const local = (t - clip.start) * (clip.speed ?? 1);
  return clip.reverse ? clip.out - local : clip.in + local;
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
