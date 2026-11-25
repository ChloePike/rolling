/**
 * Export presets and the render job the Worker sends to the FFmpeg container
 * (`POST /render`, containers/ffmpeg). The container keeps its own copy of the
 * job shape (it is built from its own directory); keep both in sync.
 */
import { cropEdl, edlDuration, isEmptyEdl, type Edl } from './timeline';

export const EXPORT_PRESETS = ['mp4_1080p', 'mp4_720p'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/** Short side of the output per preset; the long side follows the EDL's aspect ratio. */
const SHORT_SIDE: Record<ExportPreset, number> = { mp4_1080p: 1080, mp4_720p: 720 };

/** Longest export the renderer takes, seconds. */
export const MAX_EXPORT_SECONDS = 15 * 60;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output frame size for a preset: the EDL's aspect ratio, short side at the preset, even sides. */
export function exportSize(edl: Pick<Edl, 'width' | 'height'>, preset: ExportPreset): { width: number; height: number } {
  const short = SHORT_SIDE[preset];
  const scale = short / Math.min(edl.width, edl.height);
  return { width: even(edl.width * scale), height: even(edl.height * scale) };
}

export interface RenderInput {
  /** Signed, short-lived GET URL (D-008). */
  url: string;
}

export interface RenderJob {
  id: string;
  /** Cropped to the export range (starts at 0), only clips with a resolvable asset. */
  edl: Edl;
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  /** By asset id. */
  inputs: Record<string, RenderInput>;
  /** Presigned R2 `PUT` for the MP4; without it the container keeps the file for `GET /render/:id/file`. */
  putUrl?: string;
}

export type ExportPlan = { ok: true; edl: Edl; duration: number; assetIds: string[] } | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'BAD_RANGE' };

/**
 * What an export renders: the EDL cropped to `range` (whole cut by default),
 * the asset ids it needs, and its duration. Clips without an asset (planned
 * shots) render as black.
 */
export function planExport(edl: Edl, range?: { start: number; end: number }): ExportPlan {
  const total = edlDuration(edl);
  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, total) : total;
  if (range && (!(end > start) || start < 0)) return { ok: false, reason: 'BAD_RANGE' };
  const cut = cropEdl(edl, start, end);
  const duration = Math.round((end - start) * 1e6) / 1e6;
  if (duration <= 0 || isEmptyEdl(cut)) return { ok: false, reason: 'EMPTY' };
  if (duration > MAX_EXPORT_SECONDS) return { ok: false, reason: 'TOO_LONG' };
  const ids = new Set<string>();
  for (const t of cut.tracks) if (t.kind !== 'caption') for (const c of t.clips) if (c.assetId) ids.add(c.assetId);
  return { ok: true, edl: cut, duration, assetIds: [...ids] };
}
