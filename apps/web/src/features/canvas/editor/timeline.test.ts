import { describe, expect, it } from 'vitest';
import { MOCK_CUT_TO_10, MOCK_SCRIPT } from './mocks';
import { assembleFromScript } from '@rolling/core/timeline';
import { moveRange, trimRange } from '@rolling/core/timeline';
import { clipRect, gainY, hitTest, ppsToZoom, rowLayout, rulerTicks, thumbCount, zoomToPps } from '@rolling/core/timeline';
import { applyOp, applyOps, nextClipId, validateEdl } from '@rolling/core/timeline';
import { planCutTo } from '@rolling/core/timeline';
import { snapCandidates, snapMove, snapTime } from '@rolling/core/timeline';
import { formatClipLength, formatTimecode } from '@rolling/core/timeline';
import { clipEnd, edlDuration, findClip, type Edl, type MediaClip } from '@rolling/core/timeline';

const edl = (): Edl => assembleFromScript(MOCK_SCRIPT);
const ok = (r: ReturnType<typeof applyOp>) => {
  if (!r.ok) throw new Error(r.error);
  return r.edl;
};
const clip = (e: Edl, id: string) => findClip(e, id)!.clip;

describe('assembleFromScript', () => {
  it('builds the cut in CanvasEdit.dc.html: captions, three shots, voiceover and music', () => {
    expect(edl()).toEqual({
      fps: 24,
      width: 1080,
      height: 1920,
      tracks: [
        {
          id: 'C1',
          kind: 'caption',
          clips: [
            { id: 'c1', start: 0.4, end: 4, text: 'Morning. The first sip of the mountains.' },
            { id: 'c2', start: 4.6, end: 6.6, text: 'Pop it open.' },
          ],
        },
        {
          id: 'V1',
          kind: 'video',
          clips: [
            { id: 'v1', assetId: 'ast_shot_a', nodeId: 'node_shot_a', in: 0, out: 4, start: 0, gainDb: -6, transitionOut: { type: 'dissolve', dur: 0.25 } },
            { id: 'v2', assetId: 'ast_shot_b', nodeId: 'node_shot_b', in: 0, out: 5, start: 4, gainDb: -6 },
            { id: 'v3', assetId: null, nodeId: 'node_shot_c', in: 0, out: 3, start: 9, gainDb: -6 },
          ],
        },
        { id: 'A1', kind: 'voice', clips: [{ id: 'a1', assetId: 'ast_voiceover', in: 0, out: 8, start: 0.4, gainDb: 0 }] },
        {
          id: 'A2',
          kind: 'music',
          clips: [
            {
              id: 'm1',
              assetId: 'ast_music_morning',
              in: 0,
              out: 10,
              start: 0,
              gainDb: -6,
              duckUnder: ['A1'],
              gainKeyframes: [
                { t: 0, db: -30 },
                { t: 0.4, db: -6 },
                { t: 8.4, db: -6 },
                { t: 10, db: -32 },
              ],
            },
          ],
        },
      ],
    });
    expect(edlDuration(edl())).toBe(12);
  });
});

describe('applyOp', () => {
  it('trims a tail by changing out only', () => {
    const e = ok(applyOp(edl(), { op: 'trim', clipId: 'v2', out: 4 }));
    expect(clip(e, 'v2')).toMatchObject({ in: 0, out: 4, start: 4 });
  });

  it('trims a head and keeps the remaining frames in place', () => {
    const e = ok(applyOp(edl(), { op: 'trim', clipId: 'v2', in: 1 }));
    expect(clip(e, 'v2')).toMatchObject({ in: 1, out: 5, start: 5 });
    expect(clipEnd(clip(e, 'v2'))).toBe(9);
  });

  it('trims captions by timeline start and end', () => {
    const e = ok(applyOp(edl(), { op: 'trim', clipId: 'c2', in: 5, out: 6 }));
    expect(clip(e, 'c2')).toMatchObject({ start: 5, end: 6 });
  });

  it('refuses a trim past the end of the media', () => {
    const r = applyOp(edl(), { op: 'trim', clipId: 'v1', out: 4.5 }, { sourceDuration: () => 4 });
    expect(r.ok).toBe(false);
  });

  it('moves a clip and refuses an overlap', () => {
    const e = ok(applyOp(edl(), { op: 'move', clipId: 'c2', start: 5 }));
    expect(clip(e, 'c2')).toMatchObject({ start: 5, end: 7 });
    expect(applyOp(edl(), { op: 'move', clipId: 'v3', start: 8 }).ok).toBe(false);
  });

  it('splits a shot: the left part keeps the id, the right part gets the next id and the outgoing transition', () => {
    const e = ok(applyOp(edl(), { op: 'split', clipId: 'v1', at: 2.5 }));
    const v1 = clip(e, 'v1') as MediaClip;
    const v4 = clip(e, 'v4') as MediaClip;
    expect(v1).toMatchObject({ in: 0, out: 2.5, start: 0 });
    expect(v1.transitionOut).toBeUndefined();
    expect(v4).toMatchObject({ in: 2.5, out: 4, start: 2.5, assetId: 'ast_shot_a', transitionOut: { type: 'dissolve', dur: 0.25 } });
    expect(e.tracks[1]!.clips.map((c) => c.id)).toEqual(['v1', 'v4', 'v2', 'v3']);
  });

  it('splits keyframed gain at the cut', () => {
    const e = ok(applyOp(edl(), { op: 'split', clipId: 'm1', at: 5 }));
    expect((clip(e, 'm1') as MediaClip).gainKeyframes).toEqual([
      { t: 0, db: -30 },
      { t: 0.4, db: -6 },
    ]);
    expect((clip(e, 'm2') as MediaClip).gainKeyframes).toEqual([
      { t: 3.4, db: -6 },
      { t: 5, db: -32 },
    ]);
  });

  it('refuses a split outside the clip', () => {
    expect(applyOp(edl(), { op: 'split', clipId: 'v1', at: 4 }).ok).toBe(false);
    expect(applyOp(edl(), { op: 'split', clipId: 'v1', at: 0 }).ok).toBe(false);
  });

  it('ripple delete closes the gap on the same track only', () => {
    const e = ok(applyOp(edl(), { op: 'remove', clipId: 'v2', ripple: true }));
    expect(e.tracks[1]!.clips.map((c) => [c.id, c.start])).toEqual([
      ['v1', 0],
      ['v3', 4],
    ]);
    expect(clip(e, 'c2').start).toBe(4.6);
  });

  it('lift delete leaves the gap', () => {
    const e = ok(applyOp(edl(), { op: 'remove', clipId: 'v2', ripple: false }));
    expect(clip(e, 'v3').start).toBe(9);
  });

  it('sets gain, caption text and replaces a shot in place', () => {
    let e = ok(applyOp(edl(), { op: 'setGain', clipId: 'a1', gainDb: -3 }));
    expect((clip(e, 'a1') as MediaClip).gainDb).toBe(-3);
    e = ok(applyOp(e, { op: 'setCaption', clipId: 'c2', text: 'Open it.' }));
    expect(clip(e, 'c2')).toMatchObject({ text: 'Open it.' });
    e = ok(applyOp(e, { op: 'replaceShot', clipId: 'v3', nodeId: 'node_shot_c', assetId: 'ast_shot_c' }));
    expect(clip(e, 'v3')).toMatchObject({ assetId: 'ast_shot_c', in: 0, out: 3, start: 9 });
    expect(applyOp(e, { op: 'setCaption', clipId: 'v1', text: 'x' }).ok).toBe(false);
    expect(applyOp(e, { op: 'replaceShot', clipId: 'a1', nodeId: 'n' }).ok).toBe(false);
  });

  it('reports unknown clips', () => {
    expect(applyOp(edl(), { op: 'move', clipId: 'nope', start: 0 })).toEqual({ ok: false, error: 'Unknown clip nope' });
  });

  it('does not mutate its input', () => {
    const before = edl();
    const snapshot = JSON.stringify(before);
    applyOp(before, { op: 'split', clipId: 'v2', at: 6 });
    applyOp(before, { op: 'remove', clipId: 'v1', ripple: true });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('applyOps', () => {
  it('applies the “cut to 10s” proposal: Shot B 4s, Shot C 8–10s, sequence 10s', () => {
    const r = applyOps(edl(), MOCK_CUT_TO_10.ops);
    if (!r.ok) throw new Error(r.error);
    expect(r.edl.tracks[1]!.clips.map((c) => [c.id, c.start, clipEnd(c)])).toEqual([
      ['v1', 0, 4],
      ['v2', 4, 8],
      ['v3', 8, 10],
    ]);
    expect(edlDuration(r.edl)).toBe(10);
  });

  it('is all or nothing', () => {
    const r = applyOps(edl(), [{ op: 'trim', clipId: 'v2', out: 4 }, { op: 'move', clipId: 'missing', start: 1 }]);
    expect(r.ok).toBe(false);
  });

  it('validates only the final state', () => {
    const r = applyOps(edl(), [{ op: 'move', clipId: 'v3', start: 8 }]);
    expect(r.ok).toBe(false);
    expect(validateEdl(edl())).toBeNull();
  });
});

describe('nextClipId', () => {
  it('continues the prefix numbering', () => {
    expect(nextClipId(edl(), 'v2')).toBe('v4');
    expect(nextClipId(edl(), 'c1')).toBe('c3');
    expect(nextClipId(edl(), 'm1')).toBe('m2');
  });
});

describe('snapping', () => {
  const cands = snapCandidates(edl(), { playhead: 2.6, exclude: 'c2' });
  it('collects 0, the playhead and clip edges, minus the dragged clip', () => {
    expect(cands).toContain(2.6);
    expect(cands).toContain(9);
    expect(cands).not.toContain(6.6);
  });
  it('snaps within the threshold only', () => {
    expect(snapTime(2.55, cands, 0.08)).toEqual({ time: 2.6, target: 2.6 });
    expect(snapTime(2.3, cands, 0.08)).toEqual({ time: 2.3, target: null });
  });
  it('snaps a moving clip by its nearer edge', () => {
    // 2s clip whose tail lands near 9.
    expect(snapMove(6.96, 2, cands, 0.08)).toEqual({ time: 7, target: 9 });
    expect(snapMove(3.97, 2, cands, 0.08)).toEqual({ time: 4, target: 4 });
  });
});

describe('constraints', () => {
  it('limits moves to the gap between neighbours', () => {
    expect(moveRange(edl(), 'c2')).toEqual({ min: 4, max: Infinity });
    expect(moveRange(edl(), 'c1')).toEqual({ min: 0, max: 1 });
  });
  it('limits trims by neighbours, media and minimum length', () => {
    expect(trimRange(edl(), 'v2', 'end', 5)).toEqual({ min: 4.1, max: 9 });
    expect(trimRange(edl(), 'v2', 'start')).toEqual({ min: 4, max: 8.9 });
    expect(trimRange(edl(), 'a1', 'end', 8)).toEqual({ min: 0.5, max: 8.4 });
  });
});

describe('planCutTo', () => {
  it('trims the last shots, closes the gap and trims audio past the new end', () => {
    const plan = planCutTo(edl(), 10)!;
    const r = applyOps(edl(), plan.ops);
    if (!r.ok) throw new Error(r.error);
    expect(edlDuration(r.edl)).toBe(10);
    expect(plan.removed).toBe(2);
    expect(plan.highlights[0]).toEqual({ clipId: 'v3', from: 10, to: 12, kind: 'remove' });
  });
  it('returns null when nothing can be cut', () => {
    expect(planCutTo(edl(), 20)).toBeNull();
    expect(planCutTo(edl(), 1)).toBeNull();
  });
});

describe('geometry', () => {
  const { rows, height } = rowLayout(edl().tracks);
  it('matches the design rows: ruler 26+1, captions 32, video 64, voice 44, music 44', () => {
    expect(rows.map((r) => [r.top, r.height])).toEqual([
      [27, 32],
      [60, 64],
      [125, 44],
      [170, 44],
    ]);
    expect(height).toBe(215);
  });
  it('places clips 1px inside their time range at 100px/s', () => {
    expect(clipRect(clip(edl(), 'v2'), rows[1]!, 100, 0)).toEqual({ x: 401, y: 63, w: 498, h: 58 });
    expect(clipRect(clip(edl(), 'c1'), rows[0]!, 100, 0)).toEqual({ x: 41, y: 30, w: 358, h: 26 });
  });
  it('hit tests edges, bodies, lanes and the ruler', () => {
    const e = edl();
    expect(hitTest(e, rows, 100, 0, 403, 80)).toMatchObject({ kind: 'clip', clipId: 'v2', zone: 'head' });
    expect(hitTest(e, rows, 100, 0, 600, 80)).toMatchObject({ kind: 'clip', clipId: 'v2', zone: 'body' });
    expect(hitTest(e, rows, 100, 0, 897, 80)).toMatchObject({ kind: 'clip', clipId: 'v2', zone: 'tail' });
    expect(hitTest(e, rows, 100, 0, 20, 40)).toMatchObject({ kind: 'lane', trackId: 'C1' });
    expect(hitTest(e, rows, 100, 0, 260, 10)).toEqual({ kind: 'ruler', time: 2.6 });
  });
  it('ruler: 1s majors and quarter-second minors at 100px/s, up to the sequence end', () => {
    const { ticks, major } = rulerTicks(12, 100, 0, 20);
    expect(major).toBe(1);
    expect(ticks).toHaveLength(49);
    expect(ticks.filter((t) => t.major).map((t) => t.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rulerTicks(12, 30, 0, 20).major).toBe(5);
  });
  it('zoom slider sits at 58% for 100px/s and round-trips', () => {
    expect(ppsToZoom(100)).toBeCloseTo(0.58, 2);
    expect(zoomToPps(ppsToZoom(140))).toBeCloseTo(140, 6);
  });
  it('thumbnails and gain envelope match the design', () => {
    expect(thumbCount(398)).toBe(8);
    expect(thumbCount(498)).toBe(10);
    expect(gainY(-6)).toBe(14);
    expect(gainY(-30)).toBe(34);
  });
});

describe('timecode', () => {
  it('formats HH:MM:SS:FF with floored frames', () => {
    expect(formatTimecode(2.6, 24)).toBe('00:00:02:14');
    expect(formatTimecode(12, 24)).toBe('00:00:12:00');
    expect(formatTimecode(3725.5, 24)).toBe('01:02:05:12');
  });
  it('formats clip lengths as m:ss', () => {
    expect(formatClipLength(4)).toBe('0:04');
    expect(formatClipLength(30)).toBe('0:30');
    expect(formatClipLength(75)).toBe('1:15');
  });
});
