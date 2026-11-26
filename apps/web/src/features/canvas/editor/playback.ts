import type { EditorProject } from './mocks';
import { clipEnd, type CaptionClip, type Clip, type Edl, type GainKeyframe, type MediaClip } from '@rolling/core/timeline';
import { PEAKS_PER_SECOND } from './peaks';

/** What the program monitor shows at a time: one shot, or two during a dissolve. */
export interface Picture {
  layers: Array<{ clip: MediaClip; opacity: number; local: number }>;
  caption: CaptionClip | null;
}

export function pictureAt(edl: Edl, t: number, hiddenTracks: ReadonlySet<string>): Picture {
  const layers: Picture['layers'] = [];
  let caption: CaptionClip | null = null;
  for (const track of edl.tracks) {
    if (hiddenTracks.has(track.id)) continue;
    if (track.kind === 'caption') {
      caption = track.clips.find((c) => t >= c.start && t < c.end) ?? caption;
      continue;
    }
    if (track.kind !== 'video') continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    clips.forEach((clip, i) => {
      const end = clipEnd(clip);
      const next = clips[i + 1];
      const half = (clip.transitionOut?.dur ?? 0) / 2;
      const adjacent = next && Math.abs(next.start - end) < 1e-6;
      if (half && adjacent && t >= end - half && t < end + half) {
        const mix = (t - (end - half)) / (2 * half);
        layers.push({ clip, opacity: 1, local: t - clip.start });
        layers.push({ clip: next, opacity: mix, local: t - next.start });
      } else if (t >= clip.start && t < end && !layers.some((l) => l.clip.id === clip.id)) {
        const prev = clips[i - 1];
        const prevHalf = (prev?.transitionOut?.dur ?? 0) / 2;
        if (prev && prevHalf && Math.abs(clipEnd(prev) - clip.start) < 1e-6 && t < clip.start + prevHalf) return;
        layers.push({ clip, opacity: 1, local: t - clip.start });
      }
    });
  }
  return { layers, caption };
}

/** Linear gain of a clip at a timeline time, from gainDb and keyframes. */
export function gainAt(clip: MediaClip, t: number): number {
  const kfs = clip.gainKeyframes;
  let db = clip.gainDb ?? 0;
  if (kfs?.length) db = interpolate(kfs, t - clip.start);
  return Math.pow(10, db / 20);
}

function interpolate(kfs: GainKeyframe[], local: number): number {
  if (local <= kfs[0]!.t) return kfs[0]!.db;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    if (local <= b.t) return a.db + ((b.db - a.db) * (local - a.t)) / (b.t - a.t || 1);
  }
  return kfs[kfs.length - 1]!.db;
}

/** Peak of the mix over a short window, as a linear amplitude (1 = full lane height of every source). */
export function mixPeak(project: EditorProject, edl: Edl, t: number, muted: ReadonlySet<string>, window = 0.15): number {
  let peak = 0;
  for (let s = t - window; s <= t + window + 1e-9; s += 0.03) peak = Math.max(peak, mixAt(project, edl, s, muted));
  return peak;
}

/** Meter reading 0..1 on a 36 dB scale. */
export function meterLevel(peak: number): number {
  if (peak <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(peak * MOCK_MIX_SCALE) + METER_RANGE_DB) / METER_RANGE_DB));
}
const METER_RANGE_DB = 36;
/** Mock peaks are lane heights, not sample values; scale them to a plausible program level (about −14 dBFS). */
const MOCK_MIX_SCALE = 0.218;

function mixAt(project: EditorProject, edl: Edl, t: number, muted: ReadonlySet<string>): number {
  let sum = 0;
  for (const track of edl.tracks) {
    if ((track.kind !== 'voice' && track.kind !== 'music') || muted.has(track.id)) continue;
    for (const clip of track.clips as Clip[]) {
      const m = clip as MediaClip;
      if (t < m.start || t >= clipEnd(m) || !m.assetId) continue;
      const info = project.audio[m.assetId];
      if (!info?.peaks.length) continue;
      const idx = Math.floor((m.in + t - m.start) * PEAKS_PER_SECOND) % info.peaks.length;
      sum += (info.peaks[idx]! / 150) * gainAt(m, t);
    }
  }
  return sum;
}

/** Every clip boundary, for previous/next edit. */
export function editPoints(edl: Edl): number[] {
  const set = new Set<number>([0]);
  for (const track of edl.tracks) for (const c of track.clips as Clip[]) set.add(c.start).add(clipEnd(c));
  return [...set].sort((a, b) => a - b);
}
