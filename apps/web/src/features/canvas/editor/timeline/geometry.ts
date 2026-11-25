import { clipEnd, type Clip, type Edl, type Track, type TrackKind } from './types';

/**
 * Timeline geometry in CSS pixels, from CanvasEdit.dc.html: a 26px ruler with
 * a 1px rule, then one row per track (content height + 1px rule). Clips sit 3px
 * inside their row and 1px inside their time range.
 */
export const RULER_HEIGHT = 26;
export const ROW_HEIGHT: Record<TrackKind, number> = { caption: 32, video: 64, voice: 44, music: 44 };
export const CLIP_INSET_Y = 3;
export const CLIP_INSET_X = 1;
/** Pointer distance from a clip edge that grabs the edge for trimming. */
export const EDGE_GRAB_PX = 6;
/** Extra room after the last clip, in seconds. */
export const TAIL_SECONDS = 0.4;

export const DEFAULT_PPS = 100;
export const MIN_PPS = 20;
export const MAX_PPS = 320;

export interface Row {
  trackId: string;
  kind: TrackKind;
  /** Top of the row's content box (below the previous rule). */
  top: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rowLayout(tracks: readonly Track[]): { rows: Row[]; height: number } {
  let y = RULER_HEIGHT + 1;
  const rows = tracks.map((t) => {
    const row = { trackId: t.id, kind: t.kind, top: y, height: ROW_HEIGHT[t.kind] };
    y += row.height + 1;
    return row;
  });
  return { rows, height: y };
}

export const timeToX = (t: number, pps: number, scrollX: number) => t * pps - scrollX;
export const xToTime = (x: number, pps: number, scrollX: number) => (x + scrollX) / pps;

export function clipRect(clip: Clip, row: Row, pps: number, scrollX: number): Rect {
  return {
    x: timeToX(clip.start, pps, scrollX) + CLIP_INSET_X,
    y: row.top + CLIP_INSET_Y,
    w: (clipEnd(clip) - clip.start) * pps - CLIP_INSET_X * 2,
    h: row.height - CLIP_INSET_Y * 2,
  };
}

/** Width of the scrollable content: the sequence plus a short tail, never narrower than the viewport. */
export function contentWidth(duration: number, pps: number, viewport: number): number {
  return Math.max(viewport, Math.round((duration + TAIL_SECONDS) * pps));
}

export function clampScroll(scrollX: number, duration: number, pps: number, viewport: number): number {
  return Math.min(Math.max(0, contentWidth(duration, pps, viewport) - viewport), Math.max(0, scrollX));
}

/** Zoom slider position 0..1 on a log scale between MIN_PPS and MAX_PPS. */
export const ppsToZoom = (pps: number) => Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
export const zoomToPps = (z: number) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, Math.min(1, Math.max(0, z)));
export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));

export type Hit =
  | { kind: 'ruler'; time: number }
  | { kind: 'clip'; trackId: string; clipId: string; zone: 'head' | 'body' | 'tail'; time: number }
  | { kind: 'lane'; trackId: string; time: number }
  | { kind: 'none'; time: number };

export function hitTest(edl: Edl, rows: readonly Row[], pps: number, scrollX: number, x: number, y: number): Hit {
  const time = xToTime(x, pps, scrollX);
  if (y < RULER_HEIGHT + 1) return { kind: 'ruler', time };
  const row = rows.find((r) => y >= r.top && y < r.top + r.height + 1);
  if (!row) return { kind: 'none', time };
  const track = edl.tracks.find((t) => t.id === row.trackId);
  if (!track) return { kind: 'none', time };
  for (const clip of track.clips as Clip[]) {
    const r = clipRect(clip, row, pps, scrollX);
    if (x < r.x - 2 || x > r.x + r.w + 2) continue;
    const grab = Math.min(EDGE_GRAB_PX, r.w / 3);
    const zone = x <= r.x + grab ? 'head' : x >= r.x + r.w - grab ? 'tail' : 'body';
    return { kind: 'clip', trackId: track.id, clipId: clip.id, zone, time };
  }
  return { kind: 'lane', trackId: track.id, time };
}

export interface Tick {
  t: number;
  major: boolean;
}

const MAJOR_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
/** Labels need about 90px between them. */
const MIN_MAJOR_PX = 90;

/** Ruler ticks from 0 to the sequence end: majors carry a timecode label, four minor steps per major. */
export function rulerTicks(duration: number, pps: number, fromT: number, toT: number): { ticks: Tick[]; major: number } {
  const major = MAJOR_STEPS.find((s) => s * pps >= MIN_MAJOR_PX) ?? MAJOR_STEPS[MAJOR_STEPS.length - 1]!;
  const minor = major / 4;
  const ticks: Tick[] = [];
  const first = Math.max(0, Math.floor(fromT / minor));
  const last = Math.floor(Math.min(duration, toT) / minor + 1e-6);
  for (let i = first; i <= last; i++) ticks.push({ t: i * minor, major: i % 4 === 0 });
  return { ticks, major };
}

/** Thumbnail tiles in a video clip: about one per 50px. */
export const thumbCount = (w: number) => Math.max(1, Math.round(w / 50));

/** Y of a gain keyframe inside a clip box (0dB at 9px, -6dB at 14px). */
export const gainY = (db: number) => 4 + (6 - db) * (5 / 6);
