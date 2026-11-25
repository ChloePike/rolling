import type { CaptionClip, Edl, MediaClip } from './types';

export interface ScriptShot {
  nodeId: string;
  /** Generated asset, or null when the shot is still a plan. */
  assetId: string | null;
  seconds: number;
  /** Caption shown during the shot: `at` seconds into it, for `dur` seconds (default: to the end of the shot). */
  caption?: { text: string; at: number; dur?: number };
}

export interface AssembleInput {
  fps: number;
  width: number;
  height: number;
  shots: ScriptShot[];
  voiceover?: { assetId: string; seconds: number; at: number };
  music?: { assetId: string; seconds: number; gainDb: number };
  /** Level of the shots' own audio, dB (sits under the voiceover). */
  shotGainDb?: number;
}

/** Cross dissolve the agent puts between two generated shots. */
export const DEFAULT_DISSOLVE = 0.25;
/** Music level at the very start and end of its fade, in dB. */
export const MUSIC_FADE_FROM_DB = -30;
export const MUSIC_FADE_TO_DB = -32;

/**
 * Builds the first cut from a script (mock of `core/timeline/assemble`): shots
 * back to back on V1, captions on C1, the voiceover on A1 and music on A2 that
 * fades in under the voice start, holds, then fades out after the voice ends.
 */
export function assembleFromScript(input: AssembleInput): Edl {
  const video: MediaClip[] = [];
  const captions: CaptionClip[] = [];
  let t = 0;
  input.shots.forEach((shot, i) => {
    const clip: MediaClip = { id: `v${i + 1}`, assetId: shot.assetId, nodeId: shot.nodeId, in: 0, out: shot.seconds, start: t };
    if (input.shotGainDb !== undefined) clip.gainDb = input.shotGainDb;
    const next = input.shots[i + 1];
    if (shot.assetId && next?.assetId) clip.transitionOut = { type: 'dissolve', dur: DEFAULT_DISSOLVE };
    video.push(clip);
    if (shot.caption) {
      const start = t + shot.caption.at;
      const end = shot.caption.dur === undefined ? t + shot.seconds : start + shot.caption.dur;
      captions.push({ id: `c${captions.length + 1}`, start: round(start), end: round(end), text: shot.caption.text });
    }
    t = round(t + shot.seconds);
  });

  const voice: MediaClip[] = input.voiceover
    ? [{ id: 'a1', assetId: input.voiceover.assetId, in: 0, out: input.voiceover.seconds, start: input.voiceover.at, gainDb: 0 }]
    : [];

  const music: MediaClip[] = [];
  if (input.music) {
    const { assetId, seconds, gainDb } = input.music;
    const clip: MediaClip = { id: 'm1', assetId, in: 0, out: seconds, start: 0, gainDb };
    if (input.voiceover) {
      const vStart = input.voiceover.at;
      const vEnd = round(input.voiceover.at + input.voiceover.seconds);
      clip.duckUnder = ['A1'];
      clip.gainKeyframes = [
        { t: 0, db: MUSIC_FADE_FROM_DB },
        { t: vStart, db: gainDb },
        { t: vEnd, db: gainDb },
        { t: seconds, db: MUSIC_FADE_TO_DB },
      ];
    }
    music.push(clip);
  }

  return {
    fps: input.fps,
    width: input.width,
    height: input.height,
    tracks: [
      { id: 'C1', kind: 'caption', clips: captions },
      { id: 'V1', kind: 'video', clips: video },
      { id: 'A1', kind: 'voice', clips: voice },
      { id: 'A2', kind: 'music', clips: music },
    ],
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
