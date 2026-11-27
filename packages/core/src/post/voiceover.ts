/**
 * Imported voiceover (D-037): split a voice clip on its pauses and line the
 * parts up with the shots. Silences come from the container's `silencedetect`
 * (`/silences`), in the clip's source time.
 */
import { clipEnd, findClip, isCaptionClip, type Clip, type Edl, type MediaClip, type TimelineOp } from '../timeline/types';

export interface Silence {
  start: number;
  end: number;
}

const EPS = 1e-6;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export const SILENCE_DEFAULTS = { noiseDb: -35, minSilence: 0.45, minPart: 0.8 } as const;

/** `silence_start: 1.23` / `silence_end: 2.5 | silence_duration: …` lines of ffmpeg's log, paired. */
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
    const v = Math.max(0, Number(m[2]));
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'start') open = v;
    else if (open !== null) {
      if (v > open) out.push({ start: round(open), end: round(v) });
      open = null;
    }
  }
  return out;
}

/**
 * Cut points (source seconds) in the middle of each pause inside `[in, out)`,
 * skipping cuts that would leave a part shorter than `minPart`.
 */
export function cutsFromSilences(silences: readonly Silence[], range: { in: number; out: number }, minPart: number = SILENCE_DEFAULTS.minPart): number[] {
  const cuts: number[] = [];
  let last = range.in;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const mid = (s.start + s.end) / 2;
    if (mid <= range.in + minPart || mid >= range.out - minPart) continue;
    if (mid - last < minPart) continue;
    cuts.push(round(mid));
    last = mid;
  }
  return cuts;
}

/** Split ops for a voice clip at source-time cuts (timeline times account for the clip's speed). */
export function splitOps(edl: Edl, clipId: string, cuts: readonly number[]): { ops: TimelineOp[]; partIds: string[] } | null {
  const ref = findClip(edl, clipId);
  if (!ref || isCaptionClip(ref.clip)) return null;
  const clip = ref.clip as MediaClip;
  const speed = clip.speed ?? 1;
  const used = new Set<string>();
  for (const t of edl.tracks) for (const c of t.clips as Clip[]) used.add(c.id);
  // `split` names the right part with the next free id of the same prefix: predict them in order.
  const prefix = /^[a-z]+/i.exec(clip.id)?.[0] ?? 'clip';
  let n = 1;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const ops: TimelineOp[] = [];
  const partIds = [clip.id];
  let current = clip.id;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const at = round(clip.start + (cut - clip.in) / speed);
    if (at <= clip.start + EPS || at >= clipEnd(clip) - EPS) continue;
    ops.push({ op: 'split', clipId: current, at });
    while (used.has(`${prefix}${n}`)) n++;
    current = `${prefix}${n}`;
    used.add(current);
    partIds.push(current);
  }
  return { ops, partIds };
}

/**
 * Moves voice parts to the starts of the shots, in order (part i → shot i),
 * when it keeps every part from overlapping the next; parts beyond the shots
 * follow the last one. Returns move ops (empty when nothing changes).
 */
export function assignToShots(edl: Edl, partIds: readonly string[], shotTrackId?: string): TimelineOp[] {
  const shots = edl.tracks.find((t) => t.kind === 'video' && (!shotTrackId || t.id === shotTrackId));
  if (!shots || !shots.clips.length) return [];
  const starts = [...(shots.clips as MediaClip[])].sort((a, b) => a.start - b.start).map((c) => c.start);
  const parts = partIds.map((id) => findClip(edl, id)?.clip).filter((c): c is MediaClip => !!c && !isCaptionClip(c));
  if (!parts.length) return [];
  const voiceTrack = edl.tracks.find((t) => (t.clips as Clip[]).some((c) => c.id === parts[0]!.id))!;
  const others = (voiceTrack.clips as MediaClip[]).filter((c) => !partIds.includes(c.id));
  const placed: { id: string; start: number; len: number }[] = [];
  let cursor = 0;
  parts.forEach((p, i) => {
    const len = clipEnd(p) - p.start;
    const target = i < starts.length ? Math.max(starts[i]!, cursor) : cursor;
    placed.push({ id: p.id, start: round(target), len });
    cursor = target + len;
  });
  // Refuse a layout that runs into other clips of the voice track.
  for (const p of placed) for (const o of others) if (p.start < clipEnd(o) - EPS && p.start + p.len > o.start + EPS) return [];
  const ops: TimelineOp[] = [];
  // Moves right go last-first, moves left first-last, so neighbours never collide mid-patch (only the end state is validated anyway).
  for (const p of placed) {
    const cur = parts.find((c) => c.id === p.id)!;
    if (Math.abs(cur.start - p.start) > EPS) ops.push({ op: 'move', clipId: p.id, start: p.start });
  }
  return ops;
}
