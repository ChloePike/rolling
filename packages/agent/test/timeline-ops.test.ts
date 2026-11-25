import { describe, expect, it } from 'vitest';
import { ProposeTimelinePatchInput } from '../src/tools/schemas';

const base = { canvasId: 'cnv_1', baseRevision: 3, summary: 'Slow the hero shot' };

describe('agent timeline ops', () => {
  it('accepts the editor effects the agent may propose', () => {
    const ops = [
      { op: 'setSpeed', clipId: 'v1', speed: 0.5 },
      { op: 'setFade', clipId: 'v1', fadeIn: 0.5 },
      { op: 'setTransition', clipId: 'v1', transition: { type: 'dissolve', dur: 0.25 } },
      { op: 'setTransition', clipId: 'v2', transition: null },
    ];
    expect(ProposeTimelinePatchInput.safeParse({ ...base, ops }).success).toBe(true);
  });

  it('refuses out-of-range effects and ops reserved for the editor (insert, setFormat, replaceEdl)', () => {
    for (const op of [
      { op: 'setSpeed', clipId: 'v1', speed: 8 },
      { op: 'insert', trackId: 'V1', clip: {} },
      { op: 'setFormat', width: 1080, height: 1920, fps: 24 },
      { op: 'replaceEdl', edl: {}, baseRevision: 3 },
    ]) {
      expect(ProposeTimelinePatchInput.safeParse({ ...base, ops: [op] }).success, JSON.stringify(op)).toBe(false);
    }
  });
});
