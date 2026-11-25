/**
 * Zod schemas for the EDL and every `TimelineOp`. One schema for the editor
 * (client) and the ProjectRoom (server): what one accepts, the other accepts.
 * Bounds match the clamps in `applyOps` (`TRANSFORM_LIMITS`, `MIN_SPEED`,
 * `MAX_SPEED`, `FRAME_LIMITS`); overlap and length rules are `validateEdl`'s.
 */
import { z } from 'zod';
import { FRAME_LIMITS, MAX_SPEED, MIN_SPEED, TRANSFORM_LIMITS, type Edl, type TimelineOp } from './types';

/** Most ops one patch may carry. */
export const MAX_PATCH_OPS = 500;
/** Size limits for a stored EDL. */
export const EDL_LIMITS = { tracks: 32, clipsPerTrack: 2000, captionChars: 2000 } as const;

const ClipId = z.string().min(1).max(64);
const TrackId = z.string().min(1).max(64);
const RefId = z.string().min(1).max(80);
const Seconds = z.number().finite().min(0).max(24 * 3600);
const Db = z.number().finite().min(-96).max(24);
const L = TRANSFORM_LIMITS;

export const TransitionSchema = z.object({ type: z.literal('dissolve'), dur: z.number().finite().gt(0).max(10) });

export const ClipTransformSchema = z.object({
  scale: z.number().finite().min(L.scale[0]).max(L.scale[1]),
  x: z.number().finite().min(L.offset[0]).max(L.offset[1]),
  y: z.number().finite().min(L.offset[0]).max(L.offset[1]),
  rotation: z.number().finite().min(L.rotation[0]).max(L.rotation[1]),
  opacity: z.number().finite().min(L.opacity[0]).max(L.opacity[1]),
});

export const GainKeyframeSchema = z.object({ t: Seconds, db: Db });

export const CaptionClipSchema = z.object({
  id: ClipId,
  start: Seconds,
  end: Seconds,
  text: z.string().max(EDL_LIMITS.captionChars),
});

export const MediaClipSchema = z.object({
  id: ClipId,
  assetId: RefId.nullable(),
  nodeId: RefId.optional(),
  in: Seconds,
  out: Seconds,
  start: Seconds,
  transitionOut: TransitionSchema.optional(),
  gainDb: Db.optional(),
  duckUnder: z.array(TrackId).max(8).optional(),
  gainKeyframes: z.array(GainKeyframeSchema).max(256).optional(),
  fadeIn: Seconds.optional(),
  transform: ClipTransformSchema.optional(),
  speed: z.number().finite().min(MIN_SPEED).max(MAX_SPEED).optional(),
  reverse: z.boolean().optional(),
});

/** A clip of either kind (`insert`): a caption has `text`, media has `in`/`out`. */
export const ClipSchema = z.union([CaptionClipSchema.strict(), MediaClipSchema.strict()]);

export const TrackSchema = z.discriminatedUnion('kind', [
  z.object({ id: TrackId, kind: z.literal('caption'), clips: z.array(CaptionClipSchema).max(EDL_LIMITS.clipsPerTrack) }),
  z.object({ id: TrackId, kind: z.enum(['video', 'voice', 'music']), clips: z.array(MediaClipSchema).max(EDL_LIMITS.clipsPerTrack) }),
]);

export const EdlSchema = z.object({
  fps: z.number().int().min(FRAME_LIMITS.minFps).max(FRAME_LIMITS.maxFps),
  width: z.number().int().min(FRAME_LIMITS.minSide).max(FRAME_LIMITS.maxSide),
  height: z.number().int().min(FRAME_LIMITS.minSide).max(FRAME_LIMITS.maxSide),
  tracks: z.array(TrackSchema).max(EDL_LIMITS.tracks),
});

export const TimelineOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim'), clipId: ClipId, in: Seconds.optional(), out: Seconds.optional() }),
  z.object({ op: z.literal('move'), clipId: ClipId, start: Seconds }),
  z.object({ op: z.literal('split'), clipId: ClipId, at: Seconds }),
  z.object({ op: z.literal('remove'), clipId: ClipId, ripple: z.boolean() }),
  z.object({ op: z.literal('setGain'), clipId: ClipId, gainDb: Db }),
  z.object({ op: z.literal('setCaption'), clipId: ClipId, text: z.string().max(EDL_LIMITS.captionChars) }),
  z.object({ op: z.literal('replaceShot'), clipId: ClipId, nodeId: RefId, assetId: RefId.optional() }),
  z.object({ op: z.literal('setTransform'), clipId: ClipId, transform: ClipTransformSchema.partial() }),
  z.object({ op: z.literal('setSpeed'), clipId: ClipId, speed: z.number().finite().min(MIN_SPEED).max(MAX_SPEED), reverse: z.boolean().optional() }),
  z.object({ op: z.literal('setFade'), clipId: ClipId, fadeIn: z.number().finite().min(0).max(600) }),
  z.object({ op: z.literal('setTransition'), clipId: ClipId, transition: TransitionSchema.nullable() }),
  z.object({ op: z.literal('insert'), trackId: TrackId, clip: ClipSchema }),
  z.object({
    op: z.literal('setFormat'),
    width: z.number().int().min(FRAME_LIMITS.minSide).max(FRAME_LIMITS.maxSide),
    height: z.number().int().min(FRAME_LIMITS.minSide).max(FRAME_LIMITS.maxSide),
    fps: z.number().int().min(FRAME_LIMITS.minFps).max(FRAME_LIMITS.maxFps),
  }),
  z.object({ op: z.literal('replaceEdl'), edl: EdlSchema, baseRevision: z.number().int().nonnegative() }),
]);

/** Every op name the schema (and so the server) accepts. */
export const TIMELINE_OP_NAMES = TimelineOpSchema.options.map((o) => o.shape.op.value) as TimelineOp['op'][];

export const TimelinePatchSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(TimelineOpSchema).min(1).max(MAX_PATCH_OPS),
});

export function parseTimelineOps(raw: unknown): { ok: true; ops: TimelineOp[] } | { ok: false; message: string } {
  const parsed = z.array(TimelineOpSchema).max(MAX_PATCH_OPS).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `Invalid timeline op: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown shape'}` };
  }
  return { ok: true, ops: parsed.data as TimelineOp[] };
}

export function parseEdl(raw: unknown): { ok: true; edl: Edl } | { ok: false; message: string } {
  const parsed = EdlSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `Invalid EDL: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown shape'}` };
  }
  return { ok: true, edl: parsed.data as Edl };
}

// Compile-time parity: the schema's output and the TimelineOp / Edl types are assignable both ways.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _opsMatch: Mutual<z.infer<typeof TimelineOpSchema>, TimelineOp> = true;
const _edlMatch: Mutual<z.infer<typeof EdlSchema>, Edl> = true;
void _opsMatch;
void _edlMatch;
