import {
  clipEnd,
  findClip,
  FRAME_LIMITS,
  IDENTITY_TRANSFORM,
  isCaptionClip,
  MAX_SPEED,
  MIN_SPEED,
  TRANSFORM_LIMITS,
  type CaptionClip,
  type Clip,
  type Edl,
  type MediaClip,
  type TimelineOp,
  type Track,
} from './types';

/** Shortest clip the editor allows: one frame at 24 fps is ~0.042s, keep a little more. */
export const MIN_CLIP_SECONDS = 0.1;
const EPS = 1e-6;

export interface ApplyOptions {
  /** Length of a media clip's source, to stop trims past the end of the media. */
  sourceDuration?: (clip: MediaClip) => number | undefined;
}

export type ApplyResult = { ok: true; edl: Edl } | { ok: false; error: string };

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function replaceClip(edl: Edl, trackIndex: number, update: (clips: Clip[]) => Clip[]): Edl {
  return {
    ...edl,
    tracks: edl.tracks.map((t, i) =>
      i === trackIndex ? ({ ...t, clips: [...update(t.clips as Clip[])].sort((a, b) => a.start - b.start) } as Track) : t,
    ),
  };
}

/** Next free id with the same letter prefix as `base` (`v3` → `v4`). */
export function nextClipId(edl: Edl, base: string): string {
  const prefix = /^[a-z]+/i.exec(base)?.[0] ?? 'clip';
  const used = new Set<string>();
  for (const t of edl.tracks) for (const c of t.clips as Clip[]) used.add(c.id);
  let n = 1;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Returns an error message when two clips overlap on a track or a clip is too short. */
export function validateEdl(edl: Edl): string | null {
  const { minSide, maxSide, minFps, maxFps } = FRAME_LIMITS;
  const side = (v: number) => Number.isInteger(v) && v >= minSide && v <= maxSide;
  if (!side(edl.width) || !side(edl.height)) return 'Frame size is out of range';
  if (!Number.isInteger(edl.fps) || edl.fps < minFps || edl.fps > maxFps) return 'Frame rate is out of range';
  const ids = new Set<string>();
  const trackIds = new Set<string>();
  for (const track of edl.tracks) {
    if (trackIds.has(track.id)) return `Track ${track.id} appears twice`;
    trackIds.add(track.id);
    for (const c of track.clips as Clip[]) {
      if (ids.has(c.id)) return `Clip ${c.id} appears twice`;
      ids.add(c.id);
      if ((track.kind === 'caption') !== isCaptionClip(c)) return `Clip ${c.id} does not fit ${track.id}`;
    }
  }
  for (const track of edl.tracks) {
    const clips = [...(track.clips as Clip[])].sort((a, b) => a.start - b.start);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]!;
      if (c.start < -EPS) return `Clip ${c.id} starts before 0`;
      if (clipEnd(c) - c.start < MIN_CLIP_SECONDS - EPS) return `Clip ${c.id} is too short`;
      if (!isCaptionClip(c) && c.in < -EPS) return `Clip ${c.id} starts before its media`;
      const next = clips[i + 1];
      if (next && clipEnd(c) > next.start + EPS) return `Clips ${c.id} and ${next.id} overlap on ${track.id}`;
    }
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function applyUnchecked(edl: Edl, op: TimelineOp, opts: ApplyOptions): ApplyResult {
  if (op.op === 'replaceEdl') {
    return { ok: true, edl: structuredClone(op.edl) };
  }
  if (op.op === 'setFormat') {
    const { minSide, maxSide, minFps, maxFps } = FRAME_LIMITS;
    const side = (v: number) => Number.isInteger(v) && v >= minSide && v <= maxSide;
    if (!side(op.width) || !side(op.height)) return { ok: false, error: 'Frame size is out of range' };
    if (!Number.isInteger(op.fps) || op.fps < minFps || op.fps > maxFps) return { ok: false, error: 'Frame rate is out of range' };
    return { ok: true, edl: { ...edl, width: op.width, height: op.height, fps: op.fps } };
  }
  if (op.op === 'insert') {
    const trackIndex = edl.tracks.findIndex((t) => t.id === op.trackId);
    const track = edl.tracks[trackIndex];
    if (!track) return { ok: false, error: `Unknown track ${op.trackId}` };
    if (findClip(edl, op.clip.id)) return { ok: false, error: `Clip ${op.clip.id} already exists` };
    if ((track.kind === 'caption') !== isCaptionClip(op.clip)) return { ok: false, error: `Clip ${op.clip.id} does not fit ${track.id}` };
    return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => [...cs, op.clip]) };
  }
  const ref = findClip(edl, op.clipId);
  if (!ref) return { ok: false, error: `Unknown clip ${op.clipId}` };
  const { clip, trackIndex, track } = ref;
  const media = isCaptionClip(clip) ? null : clip;

  switch (op.op) {
    case 'trim': {
      if (op.in === undefined && op.out === undefined) return { ok: false, error: 'Trim needs in or out' };
      if (isCaptionClip(clip)) {
        // Captions have no source media: `in`/`out` are the new timeline start/end.
        const next: CaptionClip = { ...clip, start: round(op.in ?? clip.start), end: round(op.out ?? clip.end) };
        return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? next : c))) };
      }
      const m = clip as MediaClip;
      const newIn = op.in ?? m.in;
      const newOut = op.out ?? m.out;
      const limit = opts.sourceDuration?.(m);
      if (limit !== undefined && newOut > limit + EPS) return { ok: false, error: `Trim past the end of the media of ${m.id}` };
      // A head trim keeps the remaining frames where they were on the timeline.
      const next: MediaClip = { ...m, in: round(newIn), out: round(newOut), start: round(m.start + (newIn - m.in) / (m.speed ?? 1)) };
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? next : c))) };
    }
    case 'move': {
      const delta = op.start - clip.start;
      const next: Clip = isCaptionClip(clip)
        ? { ...clip, start: round(op.start), end: round(clip.end + delta) }
        : { ...clip, start: round(op.start) };
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? next : c))) };
    }
    case 'split': {
      const end = clipEnd(clip);
      if (op.at <= clip.start + MIN_CLIP_SECONDS - EPS || op.at >= end - MIN_CLIP_SECONDS + EPS) {
        return { ok: false, error: `Split point is outside ${clip.id}` };
      }
      const id = nextClipId(edl, clip.id);
      let left: Clip;
      let right: Clip;
      if (isCaptionClip(clip)) {
        left = { ...clip, end: round(op.at) };
        right = { ...clip, id, start: round(op.at) };
      } else {
        const cut = round(clip.in + (op.at - clip.start) * (clip.speed ?? 1));
        // The outgoing transition stays on the right part; a fade-in stays on the left.
        const { transitionOut: _t, ...leftBase } = clip;
        const { fadeIn: _f, ...rightBase } = clip;
        const l: MediaClip = { ...leftBase, out: cut };
        const r: MediaClip = { ...rightBase, id, in: cut, start: round(op.at) };
        if (clip.gainKeyframes) {
          const offset = op.at - clip.start;
          l.gainKeyframes = clip.gainKeyframes.filter((k) => k.t <= offset + EPS);
          r.gainKeyframes = clip.gainKeyframes.filter((k) => k.t >= offset - EPS).map((k) => ({ ...k, t: round(k.t - offset) }));
        }
        left = l;
        right = r;
      }
      return {
        ok: true,
        edl: replaceClip(edl, trackIndex, (cs) => cs.flatMap((c) => (c.id === clip.id ? [left, right] : [c]))),
      };
    }
    case 'remove': {
      const removed = clipEnd(clip) - clip.start;
      const end = clipEnd(clip);
      return {
        ok: true,
        edl: replaceClip(edl, trackIndex, (cs) =>
          cs
            .filter((c) => c.id !== clip.id)
            .map((c) => {
              if (!op.ripple || c.start < end - EPS) return c;
              return isCaptionClip(c)
                ? { ...c, start: round(c.start - removed), end: round(c.end - removed) }
                : { ...c, start: round(c.start - removed) };
            }),
        ),
      };
    }
    case 'setGain': {
      if (!media) return { ok: false, error: `Clip ${clip.id} has no audio` };
      return {
        ok: true,
        edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? { ...media, gainDb: op.gainDb } : c))),
      };
    }
    case 'setCaption': {
      if (!isCaptionClip(clip)) return { ok: false, error: `Clip ${clip.id} is not a caption` };
      return {
        ok: true,
        edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? { ...clip, text: op.text } : c))),
      };
    }
    case 'replaceShot': {
      if (track.kind !== 'video' || !media) return { ok: false, error: `Clip ${clip.id} is not a shot` };
      const next: MediaClip = { ...media, nodeId: op.nodeId, assetId: op.assetId ?? media.assetId };
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? next : c))) };
    }
    case 'setTransform': {
      if (track.kind !== 'video' || !media) return { ok: false, error: `Clip ${clip.id} has no picture` };
      const t = { ...IDENTITY_TRANSFORM, ...media.transform, ...op.transform };
      const L = TRANSFORM_LIMITS;
      const transform = {
        scale: round(clamp(t.scale, L.scale[0], L.scale[1])),
        x: round(clamp(t.x, L.offset[0], L.offset[1])),
        y: round(clamp(t.y, L.offset[0], L.offset[1])),
        rotation: round(clamp(t.rotation, L.rotation[0], L.rotation[1])),
        opacity: round(clamp(t.opacity, L.opacity[0], L.opacity[1])),
      };
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? { ...media, transform } : c))) };
    }
    case 'setSpeed': {
      if (!media) return { ok: false, error: `Clip ${clip.id} has no media` };
      if (!Number.isFinite(op.speed)) return { ok: false, error: 'Speed must be a number' };
      const speed = round(clamp(op.speed, MIN_SPEED, MAX_SPEED));
      const next: MediaClip = { ...media, speed, reverse: op.reverse ?? media.reverse ?? false };
      const delta = clipEnd(next) - clipEnd(media);
      const oldEnd = clipEnd(media);
      return {
        ok: true,
        edl: replaceClip(edl, trackIndex, (cs) =>
          cs.map((c) => {
            if (c.id === clip.id) return next;
            // Ripple: later clips on this track keep their distance to this clip's end.
            if (c.start < oldEnd - EPS) return c;
            return isCaptionClip(c) ? { ...c, start: round(c.start + delta), end: round(c.end + delta) } : { ...c, start: round(c.start + delta) };
          }),
        ),
      };
    }
    case 'setFade': {
      if (!media) return { ok: false, error: `Clip ${clip.id} has no media` };
      const fadeIn = round(clamp(op.fadeIn, 0, clipEnd(media) - media.start));
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? { ...media, fadeIn } : c))) };
    }
    case 'setTransition': {
      if (track.kind !== 'video' || !media) return { ok: false, error: `Clip ${clip.id} is not a shot` };
      const { transitionOut: _old, ...rest } = media;
      const next: MediaClip = op.transition ? { ...rest, transitionOut: { ...op.transition } } : rest;
      return { ok: true, edl: replaceClip(edl, trackIndex, (cs) => cs.map((c) => (c.id === clip.id ? next : c))) };
    }
  }
}

/** Applies one op and validates the result (no overlaps, no clips shorter than MIN_CLIP_SECONDS). */
export function applyOp(edl: Edl, op: TimelineOp, opts: ApplyOptions = {}): ApplyResult {
  const result = applyUnchecked(edl, op, opts);
  if (!result.ok) return result;
  const error = validateEdl(result.edl);
  return error ? { ok: false, error } : result;
}

/**
 * Applies ops in order, all or nothing. Intermediate states may overlap (a
 * proposal can trim one clip and then move the next into the gap); only the
 * final timeline is validated.
 */
export function applyOps(edl: Edl, ops: readonly TimelineOp[], opts: ApplyOptions = {}): ApplyResult {
  let current = edl;
  for (const op of ops) {
    const result = applyUnchecked(current, op, opts);
    if (!result.ok) return result;
    current = result.edl;
  }
  const error = validateEdl(current);
  return error ? { ok: false, error } : { ok: true, edl: current };
}
