import { describe, expect, it } from 'vitest';
import { applyOps, assembleFromScript, type Edl } from '@rolling/core/timeline';
import { TIMELINE_OP_NAMES } from '@rolling/core/timeline';
import { canvasIdFor, SERVER_OPS, timelineDiff, transitionOps } from './realTimeline';
import { MOCK_SCRIPT } from './mocks';

const base = (): Edl => assembleFromScript(MOCK_SCRIPT);

function after(edl: Edl, ops: Parameters<typeof applyOps>[1]): Edl {
  const r = applyOps(edl, ops);
  if (!r.ok) throw new Error(r.error);
  return r.edl;
}

describe('timeline sync diff', () => {
  it('maps project ids to canvas ids', () => {
    expect(canvasIdFor('prj_01ABC')).toBe('cnv_01ABC');
  });

  it('turns undo of a trim and a move into server ops that redo the same timeline', () => {
    const a = base();
    const b = after(a, [{ op: 'trim', clipId: 'v2', out: 4 }, { op: 'move', clipId: 'v3', start: 8 }]);
    const ops = timelineDiff(b, a)!;
    expect(ops.every((o) => SERVER_OPS.has(o.op))).toBe(true);
    expect(after(b, ops)).toEqual(a);
  });

  it('undo of a split removes the new clip and trims the original back', () => {
    const a = base();
    const b = after(a, [{ op: 'split', clipId: 'v2', at: 6 }]);
    const ops = timelineDiff(b, a)!;
    expect(ops.some((o) => o.op === 'remove')).toBe(true);
    expect(after(b, ops)).toEqual(a);
  });

  it('cannot express a restored clip or an effect change', () => {
    const a = base();
    const removed = after(a, [{ op: 'remove', clipId: 'v3', ripple: false }]);
    expect(timelineDiff(removed, a)).toBeNull();
    const faded = after(a, [{ op: 'setFade', clipId: 'v1', fadeIn: 0.5 }]);
    expect(timelineDiff(a, faded)).toBeNull();
  });

  it('the server takes every op the editor applies', () => {
    expect([...SERVER_OPS].sort()).toEqual([...TIMELINE_OP_NAMES].sort());
    for (const op of ['insert', 'setTransform', 'setSpeed', 'setFade', 'setTransition', 'setFormat', 'replaceEdl'] as const) expect(SERVER_OPS.has(op)).toBe(true);
  });

  it('undo of an effect, a restored clip or a format change replaces the whole cut', () => {
    const a = base();
    const faded = after(a, [{ op: 'setFade', clipId: 'v1', fadeIn: 0.5 }, { op: 'setSpeed', clipId: 'v2', speed: 2 }]);
    const undo = transitionOps(faded, a);
    expect(undo).toEqual([{ op: 'replaceEdl', edl: a, baseRevision: 0 }]);
    expect(after(faded, undo)).toEqual(a);
    const wide = after(a, [{ op: 'setFormat', width: 1920, height: 1080, fps: 30 }]);
    expect(transitionOps(wide, a)[0]!.op).toBe('replaceEdl');
    // A plain trim still goes as a trim.
    const trimmed = after(a, [{ op: 'trim', clipId: 'v2', out: 4 }]);
    expect(transitionOps(trimmed, a).every((o) => o.op !== 'replaceEdl')).toBe(true);
  });

  it('caption text and gain changes', () => {
    const a = base();
    const cap = a.tracks.find((t) => t.kind === 'caption')!.clips[0]!;
    const b = after(a, [{ op: 'setCaption', clipId: cap.id, text: 'New line' }, { op: 'setGain', clipId: 'v1', gainDb: -3 }]);
    expect(timelineDiff(a, b)).toEqual(
      expect.arrayContaining([
        { op: 'setGain', clipId: 'v1', gainDb: -3 },
        { op: 'setCaption', clipId: cap.id, text: 'New line' },
      ]),
    );
  });
});
