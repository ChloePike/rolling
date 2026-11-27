/**
 * Timeline placement of a clip that a run will make (D-029, D-030):
 * - `after`: Extend clip — a planned clip right after the original on its
 *   track; later clips on that track move right by its length.
 * - `replace`: Lip-sync — the talking-head result replaces the shot in place.
 * The planned clip has no asset (it draws as not generated) until the run
 * lands; then `resolvePlacementOps` gives it the asset and the real length, or
 * `dropPlacementOps` removes it when the run fails.
 */
import { clipEnd, findClip, isCaptionClip, type Clip, type Edl, type MediaClip, type TimelineOp } from '../timeline/types';

const EPS = 1e-6;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export type PlacementMode = 'after' | 'replace';

export interface PlannedPlacement {
  trackId: string;
  clipId: string;
  ops: TimelineOp[];
}

function freshId(edl: Edl, prefix: string): string {
  const used = new Set<string>();
  for (const t of edl.tracks) for (const c of t.clips as Clip[]) used.add(c.id);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Ops for a planned `seconds`-long clip after `clipId` (ripple on its track).
 * `skipHead` trims the new clip's first frame: an extension starts on the
 * original's last frame, so showing it twice would hold the picture.
 */
export function planAfter(edl: Edl, clipId: string, seconds: number, opts: { skipHead?: number } = {}): PlannedPlacement | null {
  const ref = findClip(edl, clipId);
  if (!ref || ref.track.kind !== 'video' || isCaptionClip(ref.clip)) return null;
  const at = clipEnd(ref.clip);
  const head = Math.max(0, Math.min(opts.skipHead ?? 0, seconds / 2));
  const len = seconds - head;
  const id = freshId(edl, 'ext');
  const ops: TimelineOp[] = [];
  // Later clips first, furthest first, so no two clips ever share a spot.
  const later = (ref.track.clips as MediaClip[]).filter((c) => c.id !== clipId && c.start >= at - EPS).sort((a, b) => b.start - a.start);
  for (const c of later) ops.push({ op: 'move', clipId: c.id, start: round(c.start + len) });
  ops.push({ op: 'insert', trackId: ref.track.id, clip: { id, assetId: null, in: round(head), out: round(seconds), start: round(at) } });
  return { trackId: ref.track.id, clipId: id, ops };
}

/**
 * When the run lands: the timeline with the planned clip given its asset. An
 * extension's out point becomes the media's real length (later clips on the
 * track follow); a replaced shot plays the new take from its start for the
 * planned length (or less, when the take is shorter).
 */
export function resolvePlacement(edl: Edl, placedId: string, assetId: string, durationSec: number | null, mode: PlacementMode): Edl | null {
  const ref = findClip(edl, placedId);
  if (!ref || isCaptionClip(ref.clip)) return null;
  const clip = ref.clip;
  if (mode === 'replace') {
    const len = clipEnd(clip) - clip.start;
    const out = durationSec && durationSec > 0.1 ? Math.min(len, durationSec) : len;
    const { speed: _s, reverse: _r, ...rest } = clip;
    return patchClip(edl, placedId, { ...rest, assetId, in: 0, out: round(out) }, true);
  }
  const want = durationSec && durationSec > clip.in + 0.1 ? round(durationSec) : clip.out;
  const delta = (want - clip.out) / (clip.speed ?? 1);
  const end = clipEnd(clip);
  const shifted: Edl = {
    ...edl,
    tracks: edl.tracks.map((t) =>
      t.id !== ref.track.id ? t : ({ ...t, clips: (t.clips as Clip[]).map((c) => (c.id !== placedId && c.start >= end - EPS ? { ...c, start: round(Math.max(0, c.start + delta)) } : c)) } as Edl['tracks'][number]),
    ),
  };
  return patchClip(shifted, placedId, { assetId, out: want });
}

function patchClip(edl: Edl, clipId: string, patch: Partial<MediaClip>, replace = false): Edl {
  return {
    ...edl,
    tracks: edl.tracks.map((t) => ({ ...t, clips: (t.clips as Clip[]).map((c) => (c.id === clipId ? (replace ? ({ ...(patch as MediaClip), id: c.id, start: c.start } as Clip) : { ...c, ...patch }) : c)) }) as Edl['tracks'][number]),
  };
}

/**
 * When the run fails or is canceled: an extension's planned clip goes and its
 * gap closes (ripple); a replaced shot gets its previous take back.
 */
export function dropPlacement(edl: Edl, placedId: string, mode: PlacementMode, previous?: { assetId: string | null; in: number; out: number } | null): { ops: TimelineOp[] } | { edl: Edl } | null {
  const ref = findClip(edl, placedId);
  if (!ref || isCaptionClip(ref.clip)) return null;
  if (mode === 'after') return { ops: [{ op: 'remove', clipId: placedId, ripple: true }] };
  if (!previous) return null;
  return { edl: patchClip(edl, placedId, { assetId: previous.assetId, in: previous.in, out: previous.out }) };
}

/** Planned `replace`: the shot keeps its place and length and shows as not generated until the take lands. */
export function planReplace(edl: Edl, clipId: string): { trackId: string; clipId: string; previous: { assetId: string | null; in: number; out: number }; ops: TimelineOp[] } | null {
  const ref = findClip(edl, clipId);
  if (!ref || ref.track.kind !== 'video' || isCaptionClip(ref.clip)) return null;
  const c = ref.clip;
  return { trackId: ref.track.id, clipId, previous: { assetId: c.assetId, in: c.in, out: c.out }, ops: [] };
}
