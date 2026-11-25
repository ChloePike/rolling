import { describe, expect, it } from 'vitest';
import { applyOps } from './ops';
import { cropEdl } from './range';
import { EdlSchema, parseEdl, parseTimelineOps, TIMELINE_OP_NAMES, TimelineOpSchema } from './schema';
import { clipEnd, edlDuration, findClip, type Edl, type MediaClip, type TimelineOp } from './types';
import { exportSize, planExport } from '../export';
import { parseTimelineOps as projectParse, TimelineOpSchema as ProjectSchema } from '../project/timeline';

function edl(): Edl {
  return {
    fps: 24,
    width: 1080,
    height: 1920,
    tracks: [
      { id: 'T1', kind: 'caption', clips: [{ id: 't1', start: 0.5, end: 2, text: 'Hi' }] },
      {
        id: 'V1',
        kind: 'video',
        clips: [
          { id: 'v1', assetId: 'ast_a', nodeId: 'node_a', in: 0, out: 4, start: 0, transitionOut: { type: 'dissolve', dur: 0.5 } },
          { id: 'v2', assetId: 'ast_b', nodeId: 'node_b', in: 1, out: 6, start: 4, fadeIn: 0.5 },
        ],
      },
      { id: 'A1', kind: 'voice', clips: [{ id: 'a1', assetId: 'ast_vo', in: 0, out: 8, start: 0.4 }] },
      { id: 'A2', kind: 'music', clips: [{ id: 'm1', assetId: 'ast_m', in: 0, out: 9, start: 0, gainDb: -6, duckUnder: ['A1'], gainKeyframes: [{ t: 0, db: -12 }, { t: 2, db: -6 }] }] },
    ],
  };
}

/** One sample of every op the client's `applyOps` supports, valid against `edl()`. */
function samples(base: Edl): Record<TimelineOp['op'], TimelineOp> {
  return {
    trim: { op: 'trim', clipId: 'v1', out: 3.5 },
    move: { op: 'move', clipId: 't1', start: 1 },
    split: { op: 'split', clipId: 'v2', at: 6 },
    remove: { op: 'remove', clipId: 'a1', ripple: false },
    setGain: { op: 'setGain', clipId: 'm1', gainDb: -3 },
    setCaption: { op: 'setCaption', clipId: 't1', text: 'Hello' },
    replaceShot: { op: 'replaceShot', clipId: 'v1', nodeId: 'node_a', assetId: 'ast_a2' },
    setTransform: { op: 'setTransform', clipId: 'v1', transform: { scale: 1.2, rotation: 10, opacity: 0.8 } },
    setSpeed: { op: 'setSpeed', clipId: 'v2', speed: 2, reverse: true },
    setFade: { op: 'setFade', clipId: 'v1', fadeIn: 0.25 },
    setTransition: { op: 'setTransition', clipId: 'v1', transition: null },
    insert: { op: 'insert', trackId: 'V1', clip: { id: 'v9', assetId: 'ast_c', in: 0, out: 2, start: 9 } },
    setFormat: { op: 'setFormat', width: 1920, height: 1080, fps: 30 },
    replaceEdl: { op: 'replaceEdl', baseRevision: 3, edl: { ...base, fps: 25 } },
  };
}

describe('timeline op schema parity', () => {
  it('accepts every op the client applies, and the op list matches', () => {
    const all = samples(edl());
    expect([...TIMELINE_OP_NAMES].sort()).toEqual(Object.keys(all).sort());
    for (const [name, op] of Object.entries(all)) {
      const parsed = parseTimelineOps([op]);
      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.ops[0]).toEqual(op);
      const applied = applyOps(edl(), parsed.ops);
      expect(applied.ok, `${name}: ${applied.ok ? '' : applied.error}`).toBe(true);
    }
  });

  it('the project module re-exports the same schema', () => {
    expect(ProjectSchema).toBe(TimelineOpSchema);
    expect(projectParse).toBe(parseTimelineOps);
  });

  it('applies all ops of one compound patch as the editor does', () => {
    const ops = Object.values(samples(edl())).filter((o) => o.op !== 'replaceEdl' && o.op !== 'remove');
    const r = applyOps(edl(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edl).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect((findClip(r.edl, 'v1')!.clip as MediaClip).transform).toMatchObject({ scale: 1.2, rotation: 10, opacity: 0.8, x: 0, y: 0 });
  });

  it('refuses out-of-range values the client clamps away', () => {
    const bad: unknown[] = [
      { op: 'setSpeed', clipId: 'v1', speed: 8 },
      { op: 'setSpeed', clipId: 'v1', speed: 0.1 },
      { op: 'setTransform', clipId: 'v1', transform: { opacity: 2 } },
      { op: 'setTransform', clipId: 'v1', transform: { scale: 0 } },
      { op: 'setFade', clipId: 'v1', fadeIn: -1 },
      { op: 'setTransition', clipId: 'v1', transition: { type: 'wipe', dur: 1 } },
      { op: 'setFormat', width: 1080.5, height: 1920, fps: 30 },
      { op: 'setFormat', width: 1080, height: 1920, fps: 120 },
      { op: 'insert', trackId: 'V1', clip: { id: 'x', start: 0 } },
      { op: 'replaceEdl', edl: { fps: 24, width: 10, height: 10, tracks: [] }, baseRevision: 0 },
      { op: 'replaceEdl', edl: edl() },
      { op: 'trim', clipId: 'v1', in: Number.NaN },
      { op: 'nope', clipId: 'v1' },
    ];
    for (const op of bad) expect(parseTimelineOps([op]).ok, JSON.stringify(op)).toBe(false);
  });

  it('applyOps refuses what validateEdl refuses after replaceEdl', () => {
    const e = edl();
    const v = e.tracks[1]!.clips as MediaClip[];
    v[1]!.start = 3; // overlaps v1
    expect(applyOps(edl(), [{ op: 'replaceEdl', edl: e, baseRevision: 0 }]).ok).toBe(false);
    const dup = edl();
    (dup.tracks[3]!.clips as MediaClip[])[0]!.id = 'v1';
    expect(applyOps(edl(), [{ op: 'replaceEdl', edl: dup, baseRevision: 0 }]).ok).toBe(false);
    expect(applyOps(edl(), [{ op: 'setFormat', width: 8, height: 1920, fps: 30 }]).ok).toBe(false);
  });

  it('round-trips a full EDL', () => {
    expect(EdlSchema.parse(edl())).toEqual(edl());
    expect(parseEdl({ ...edl(), tracks: [{ id: 'T', kind: 'caption', clips: [{ id: 'c', in: 0, out: 1, start: 0, assetId: null }] }] }).ok).toBe(false);
  });
});

describe('cropEdl and planExport', () => {
  it('cuts clips at the range edges, honouring speed, reverse, fades, keyframes and transitions', () => {
    const e = edl();
    const v2 = (e.tracks[1]!.clips as MediaClip[])[1]!;
    v2.speed = 2;
    v2.reverse = true; // v2: source [1,6) reversed at 2x, on the timeline 4 → 6.5
    const out = cropEdl(e, 1, 5);
    const v = out.tracks[1]!.clips as MediaClip[];
    expect(v[0]).toMatchObject({ id: 'v1', start: 0, in: 1, out: 4 });
    expect(v[0]!.transitionOut).toEqual({ type: 'dissolve', dur: 0.5 });
    // 1 s of v2 at 2x = 2 s of source, taken from the reversed head (its `out` end).
    expect(v[1]).toMatchObject({ id: 'v2', start: 3, in: 4, out: 6, fadeIn: 0.5 });
    expect(out.tracks[0]!.clips).toEqual([{ id: 't1', start: 0, end: 1, text: 'Hi' }]);
    const m = out.tracks[3]!.clips[0] as MediaClip;
    expect(m.gainKeyframes).toEqual([{ t: -1, db: -12 }, { t: 1, db: -6 }]);
    expect(edlDuration(out)).toBe(4);
    const tailCut = cropEdl(edl(), 0, 3).tracks[1]!.clips as MediaClip[];
    expect(tailCut).toHaveLength(1);
    expect(tailCut[0]!.transitionOut).toBeUndefined();
    expect(clipEnd(tailCut[0]!)).toBe(3);
  });

  it('plans the whole cut or a range and lists the assets', () => {
    const p = planExport(edl());
    expect(p).toMatchObject({ ok: true, duration: 9 });
    if (p.ok) expect(p.assetIds.sort()).toEqual(['ast_a', 'ast_b', 'ast_m', 'ast_vo']);
    const r = planExport(edl(), { start: 0.5, end: 3 });
    expect(r).toMatchObject({ ok: true, duration: 2.5 });
    if (r.ok) expect(r.assetIds.sort()).toEqual(['ast_a', 'ast_m', 'ast_vo']);
    expect(planExport(edl(), { start: 3, end: 3 })).toEqual({ ok: false, reason: 'BAD_RANGE' });
    expect(planExport({ fps: 24, width: 1080, height: 1920, tracks: [] })).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it('sizes presets by the short side', () => {
    expect(exportSize({ width: 1080, height: 1920 }, 'mp4_1080p')).toEqual({ width: 1080, height: 1920 });
    expect(exportSize({ width: 1080, height: 1920 }, 'mp4_720p')).toEqual({ width: 720, height: 1280 });
    expect(exportSize({ width: 1920, height: 1080 }, 'mp4_720p')).toEqual({ width: 1280, height: 720 });
    expect(exportSize({ width: 1080, height: 1350 }, 'mp4_720p')).toEqual({ width: 720, height: 900 });
  });
});
