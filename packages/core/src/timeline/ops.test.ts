import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './ops';
import { clipEnd, findClip, sourceTime, type Edl, type MediaClip } from './types';

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
          { id: 'v1', assetId: 'a', in: 0, out: 4, start: 0 },
          { id: 'v2', assetId: 'b', in: 0, out: 5, start: 4 },
        ],
      },
      { id: 'A1', kind: 'voice', clips: [{ id: 'a1', assetId: 'vo', in: 0, out: 8, start: 0.4 }] },
    ],
  };
}

const media = (e: Edl, id: string) => findClip(e, id)!.clip as MediaClip;

describe('setTransform', () => {
  it('merges into the identity transform and clamps', () => {
    const r = applyOp(edl(), { op: 'setTransform', clipId: 'v1', transform: { scale: 1.5, opacity: 2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(media(r.edl, 'v1').transform).toEqual({ scale: 1.5, x: 0, y: 0, rotation: 0, opacity: 1 });
    const r2 = applyOp(r.edl, { op: 'setTransform', clipId: 'v1', transform: { x: 12, rotation: 400 } });
    expect(r2.ok && media(r2.edl, 'v1').transform).toEqual({ scale: 1.5, x: 12, y: 0, rotation: 360, opacity: 1 });
  });

  it('refuses audio and caption clips', () => {
    expect(applyOp(edl(), { op: 'setTransform', clipId: 'a1', transform: { scale: 2 } }).ok).toBe(false);
    expect(applyOp(edl(), { op: 'setTransform', clipId: 't1', transform: { scale: 2 } }).ok).toBe(false);
  });
});

describe('setSpeed', () => {
  it('speeds a clip up and ripples later clips on the same track', () => {
    const r = applyOp(edl(), { op: 'setSpeed', clipId: 'v1', speed: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(clipEnd(media(r.edl, 'v1'))).toBe(2);
    expect(media(r.edl, 'v2').start).toBe(2);
    // Other tracks do not move.
    expect(media(r.edl, 'a1').start).toBe(0.4);
  });

  it('slows a clip down without overlapping the next one', () => {
    const r = applyOp(edl(), { op: 'setSpeed', clipId: 'v1', speed: 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(clipEnd(media(r.edl, 'v1'))).toBe(8);
    expect(media(r.edl, 'v2').start).toBe(8);
  });

  it('clamps speed and sets reverse', () => {
    const r = applyOp(edl(), { op: 'setSpeed', clipId: 'v2', speed: 100, reverse: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = media(r.edl, 'v2');
    expect(c.speed).toBe(4);
    expect(c.reverse).toBe(true);
    expect(sourceTime(c, c.start)).toBe(5);
    expect(sourceTime(c, c.start + 1)).toBe(1);
  });

  it('keeps split and head trim in source time', () => {
    const fast = applyOp(edl(), { op: 'setSpeed', clipId: 'v1', speed: 2 });
    if (!fast.ok) throw new Error(fast.error);
    const split = applyOp(fast.edl, { op: 'split', clipId: 'v1', at: 1 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(media(split.edl, 'v1').out).toBe(2);
    const trimmed = applyOp(fast.edl, { op: 'trim', clipId: 'v1', in: 2 });
    expect(trimmed.ok && media(trimmed.edl, 'v1').start).toBe(1);
  });

  it('refuses captions', () => {
    expect(applyOp(edl(), { op: 'setSpeed', clipId: 't1', speed: 2 }).ok).toBe(false);
  });
});

describe('setFade, setTransition, insert', () => {
  it('sets and clamps a fade-in', () => {
    const r = applyOp(edl(), { op: 'setFade', clipId: 'a1', fadeIn: 20 });
    expect(r.ok && media(r.edl, 'a1').fadeIn).toBe(8);
  });

  it('adds and removes a dissolve', () => {
    const r = applyOp(edl(), { op: 'setTransition', clipId: 'v1', transition: { type: 'dissolve', dur: 0.5 } });
    if (!r.ok) throw new Error(r.error);
    expect(media(r.edl, 'v1').transitionOut).toEqual({ type: 'dissolve', dur: 0.5 });
    const off = applyOp(r.edl, { op: 'setTransition', clipId: 'v1', transition: null });
    expect(off.ok && 'transitionOut' in media(off.edl, 'v1')).toBe(false);
  });

  it('inserts a clip in a free spot and refuses overlaps', () => {
    const ok = applyOps(edl(), [{ op: 'insert', trackId: 'V1', clip: { id: 'v3', assetId: 'c', in: 0, out: 3, start: 9 } }]);
    expect(ok.ok && findClip(ok.edl, 'v3')?.track.id).toBe('V1');
    expect(applyOp(edl(), { op: 'insert', trackId: 'V1', clip: { id: 'v3', assetId: 'c', in: 0, out: 3, start: 8 } }).ok).toBe(false);
    expect(applyOp(edl(), { op: 'insert', trackId: 'V1', clip: { id: 'v1', assetId: 'c', in: 0, out: 3, start: 20 } }).ok).toBe(false);
    expect(applyOp(edl(), { op: 'insert', trackId: 'T1', clip: { id: 'v9', assetId: 'c', in: 0, out: 3, start: 20 } }).ok).toBe(false);
    expect(applyOp(edl(), { op: 'insert', trackId: 'X', clip: { id: 'v9', assetId: 'c', in: 0, out: 3, start: 20 } }).ok).toBe(false);
  });
});

describe('post-production ops', () => {
  const base: import('./types').Edl = {
    fps: 24,
    width: 1920,
    height: 1080,
    tracks: [
      { id: 'C1', kind: 'caption', clips: [] },
      { id: 'V1', kind: 'video', clips: [{ id: 'v1', assetId: 'a', in: 0, out: 4, start: 0 }] },
      { id: 'A1', kind: 'voice', clips: [{ id: 'a1', assetId: 'vo', in: 0, out: 4, start: 0 }] },
      { id: 'A2', kind: 'music', clips: [{ id: 'm1', assetId: 'mu', in: 0, out: 4, start: 0 }] },
    ],
  };

  it('sets and clears a caption track style and language', () => {
    const r = applyOps(base, [{ op: 'setCaptionTrack', trackId: 'C1', style: 'minimal', lang: 'ko' }]);
    expect(r.ok && r.edl.tracks[0]).toMatchObject({ style: 'minimal', lang: 'ko' });
    if (!r.ok) return;
    const cleared = applyOps(r.edl, [{ op: 'setCaptionTrack', trackId: 'C1', lang: null }]);
    expect(cleared.ok && cleared.edl.tracks[0]).toEqual({ id: 'C1', kind: 'caption', clips: [], style: 'minimal' });
    expect(applyOps(base, [{ op: 'setCaptionTrack', trackId: 'V1', style: 'clean' }]).ok).toBe(false);
  });

  it('sets reframing on shots only and survives a split', () => {
    const r = applyOps(base, [{ op: 'setReframe', clipId: 'v1', reframe: { mode: 'manual', x: 0.2 } }, { op: 'split', clipId: 'v1', at: 2 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edl.tracks[1]!.clips.map((c) => (c as { reframe?: unknown }).reframe)).toEqual([{ mode: 'manual', x: 0.2 }, { mode: 'manual', x: 0.2 }]);
    expect(applyOps(base, [{ op: 'setReframe', clipId: 'a1', reframe: { mode: 'center' } }]).ok).toBe(false);
  });

  it('ducks music under the voice lane, and refuses unknown or caption tracks', () => {
    const r = applyOps(base, [{ op: 'setDuck', clipId: 'm1', duckUnder: ['A1', 'A1', 'A2'] }]);
    expect(r.ok && (r.edl.tracks[3]!.clips[0] as { duckUnder?: string[] }).duckUnder).toEqual(['A1']);
    expect(applyOps(base, [{ op: 'setDuck', clipId: 'm1', duckUnder: ['C1'] }]).ok).toBe(false);
    if (!r.ok) return;
    const off = applyOps(r.edl, [{ op: 'setDuck', clipId: 'm1', duckUnder: [] }]);
    expect(off.ok && 'duckUnder' in off.edl.tracks[3]!.clips[0]!).toBe(false);
  });
});
