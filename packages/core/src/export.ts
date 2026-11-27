/**
 * Export presets and the render job the Worker sends to the FFmpeg container
 * (`POST /render`, containers/ffmpeg). The container keeps its own copy of the
 * job shape (it is built from its own directory); keep both in sync.
 */
import { z } from 'zod';
import { cropEdl, edlDuration, isEmptyEdl, type Edl } from './timeline';
import type { ResolvedCaptionLook } from './post/styles';
import type { WatermarkPosition } from './post/brandKit';

/**
 * `mp4_*`: the cut's own aspect ratio at a short side. Social presets (D-034)
 * have a fixed frame; when it differs from the cut's aspect, shots are
 * reframed (cropped around the subject) instead of letterboxed.
 */
export const EXPORT_PRESETS = ['mp4_1080p', 'mp4_720p', 'vertical_9x16', 'square_1x1', 'landscape_16x9'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];
export const SOCIAL_PRESETS = ['vertical_9x16', 'square_1x1', 'landscape_16x9'] as const satisfies readonly ExportPreset[];

/** Short side of the output per original-aspect preset; the long side follows the EDL's aspect ratio. */
const SHORT_SIDE: Partial<Record<ExportPreset, number>> = { mp4_1080p: 1080, mp4_720p: 720 };
const FIXED_SIZE: Partial<Record<ExportPreset, { width: number; height: number }>> = {
  vertical_9x16: { width: 1080, height: 1920 },
  square_1x1: { width: 1080, height: 1080 },
  landscape_16x9: { width: 1920, height: 1080 },
};

/**
 * Encoder settings per preset. Social presets follow the platforms' upload
 * guidance: H.264 High, yuv420p, a target bitrate with a VBV cap, AAC 48 kHz,
 * and the mix normalised to -14 LUFS integrated, -1 dBTP (TikTok / Reels /
 * Shorts / YouTube all normalise playback near -14). Original-aspect presets
 * keep constant quality and the mix as is.
 */
export interface EncodeSettings {
  /** Constant quality (x264 CRF) when no bitrate is set. */
  crf: number | null;
  videoKbps: number | null;
  maxKbps: number | null;
  bufferKbps: number | null;
  profile: 'high';
  level: '4.1' | '4.2';
  audioKbps: number;
  /** Integrated loudness target (LUFS) of the final mix, or null to leave it. */
  loudnessLufs: number | null;
  truePeakDb: number;
}

const BASE_ENCODE: EncodeSettings = { crf: 20, videoKbps: null, maxKbps: null, bufferKbps: null, profile: 'high', level: '4.1', audioKbps: 192, loudnessLufs: null, truePeakDb: -1 };

export const PRESET_ENCODE: Record<ExportPreset, EncodeSettings> = {
  mp4_1080p: BASE_ENCODE,
  mp4_720p: BASE_ENCODE,
  vertical_9x16: { ...BASE_ENCODE, crf: null, videoKbps: 8000, maxKbps: 10000, bufferKbps: 16000, level: '4.2', audioKbps: 192, loudnessLufs: -14 },
  square_1x1: { ...BASE_ENCODE, crf: null, videoKbps: 6000, maxKbps: 8000, bufferKbps: 12000, level: '4.2', audioKbps: 192, loudnessLufs: -14 },
  landscape_16x9: { ...BASE_ENCODE, crf: null, videoKbps: 10000, maxKbps: 12000, bufferKbps: 20000, level: '4.2', audioKbps: 384, loudnessLufs: -14 },
};

/** Frame rates "Smoother motion" can reach with motion-compensated interpolation. */
export const INTERPOLATE_FPS = [48, 60] as const;
export type InterpolateFps = (typeof INTERPOLATE_FPS)[number];
/** Interpolation is slow (CPU motion search): exports with it are capped at this length. */
export const MAX_INTERPOLATED_SECONDS = 180;
/** A preview renders this long, around the playhead, at 540p. */
export const PREVIEW_SECONDS = 4;

const Seconds = z.number().finite().min(0).max(24 * 3600);

/** Export options beyond preset and range (`POST /api/canvases/:id/export`). */
export const ExportOptionsSchema = z.object({
  /** Burn the caption track in (default on when there are captions). */
  burnCaptions: z.boolean().optional(),
  /** Smoother motion: interpolate to this frame rate. */
  interpolate: z.union([z.literal(48), z.literal(60)]).nullable().optional(),
  /** Apply the workspace brand kit: logo watermark, intro and end cards, brand caption font and color. */
  brand: z.boolean().optional(),
  /** A short low-resolution preview (not saved to Assets). */
  preview: z.boolean().optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const ExportRequestSchema = z.object({
  preset: z.enum(EXPORT_PRESETS).optional(),
  /** Batch export: one export per preset, started together. */
  presets: z.array(z.enum(EXPORT_PRESETS)).min(1).max(EXPORT_PRESETS.length).optional(),
  range: z.object({ start: Seconds, end: Seconds }).refine((r) => r.end > r.start, { message: 'end must be after start' }).optional(),
  options: ExportOptionsSchema.optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export function isSocialPreset(p: ExportPreset): boolean {
  return (SOCIAL_PRESETS as readonly string[]).includes(p);
}

/** Preview frame: the export's aspect with a 540 short side. */
export function previewSize(size: { width: number; height: number }): { width: number; height: number } {
  const scale = 540 / Math.min(size.width, size.height);
  return { width: even(size.width * scale), height: even(size.height * scale) };
}

/** True when the export frame's aspect differs from the cut's by more than 1%: shots are reframed. */
export function needsReframe(edl: Pick<Edl, 'width' | 'height'>, size: { width: number; height: number }): boolean {
  return Math.abs(edl.width / edl.height - size.width / size.height) / (size.width / size.height) > 0.01;
}

/** Longest export the renderer takes, seconds. */
export const MAX_EXPORT_SECONDS = 15 * 60;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output frame size for a preset: the EDL's aspect ratio, short side at the preset, even sides. */
export function exportSize(edl: Pick<Edl, 'width' | 'height'>, preset: ExportPreset): { width: number; height: number } {
  const fixed = FIXED_SIZE[preset];
  if (fixed) return { ...fixed };
  const short = SHORT_SIDE[preset]!;
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
  /** Encoder settings (default: constant quality, mix untouched). */
  encode?: EncodeSettings;
  /** Crop shots to the frame around their subject (aspect change) instead of letterboxing. */
  reframe?: boolean;
  /** Motion-interpolate the picture to this frame rate (`minterpolate`). */
  interpolateFps?: InterpolateFps;
  /** Caption burn-in: the resolved look; null = no burn-in; absent = the default look. */
  captions?: RenderCaptions | null;
  /** Font files the captions and cards use (downloaded into the job's font folder). */
  fonts?: RenderFont[];
  /** Brand kit pieces to apply. */
  brand?: RenderBrand;
  /** Audio only (transcription): mono MP3 chunks instead of an MP4. */
  audioOnly?: { sampleRate: 16000; chunkSeconds: number };
  /** Voice-lane clips are normalised to this loudness before the mix (imported voiceovers vary a lot). */
  voiceLufs?: number;
}

export interface RenderCaptions {
  look: ResolvedCaptionLook;
  lang: string | null;
}

export interface RenderFont {
  family: string;
  url: string;
  format: 'woff2' | 'ttf' | 'otf';
}

export interface RenderCard {
  seconds: number;
  /** `#RRGGBB`. */
  background: string;
  color: string;
  text: string;
  /** Font family of a `fonts` entry (else the bundled Noto Sans). */
  fontFamily?: string;
  logoUrl?: string;
}

export interface RenderBrand {
  watermark?: { url: string; position: WatermarkPosition; opacity: number; size: number };
  intro?: RenderCard;
  outro?: RenderCard;
}

/** Voice lanes are evened out to this integrated loudness before mixing (D-037). */
export const VOICE_LUFS = -16;

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
