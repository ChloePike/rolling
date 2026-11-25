import { describe, expect, it } from 'vitest';
import { MOCK_CUT_TO_10, mockProject } from './mocks';
import { editPoints, gainAt, meterLevel, mixPeak, pictureAt } from './playback';
import { initEditorState, makeReducer } from './state';
import { clipEnd, findClip, type MediaClip } from './timeline/types';

const project = mockProject('prj_test');
const none = new Set<string>();

describe('pictureAt', () => {
  it('shows Shot A and the first caption at 2.6s', () => {
    const p = pictureAt(project.edl, 2.6, none);
    expect(p.layers.map((l) => [l.clip.id, l.opacity])).toEqual([['v1', 1]]);
    expect(p.caption?.text).toBe('Morning. The first sip of the mountains.');
  });
  it('cross-dissolves A into B around the 4s cut', () => {
    const p = pictureAt(project.edl, 4, none);
    expect(p.layers.map((l) => l.clip.id)).toEqual(['v1', 'v2']);
    expect(p.layers[1]!.opacity).toBeCloseTo(0.5, 5);
    expect(pictureAt(project.edl, 4.2, none).layers.map((l) => l.clip.id)).toEqual(['v2']);
  });
  it('hides hidden tracks', () => {
    expect(pictureAt(project.edl, 2.6, new Set(['C1'])).caption).toBeNull();
    expect(pictureAt(project.edl, 2.6, new Set(['V1'])).layers).toHaveLength(0);
  });
});

describe('audio', () => {
  const music = findClip(project.edl, 'm1')!.clip as MediaClip;
  it('follows the music envelope', () => {
    expect(gainAt(music, 0)).toBeCloseTo(Math.pow(10, -30 / 20), 6);
    expect(gainAt(music, 4)).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(gainAt(music, 9.2)).toBeCloseTo(Math.pow(10, -19 / 20), 6);
  });
  it('meter reads about 62% at the opening frame and drops when every track is muted', () => {
    expect(meterLevel(mixPeak(project, project.edl, 2.6, none))).toBeCloseTo(0.62, 2);
    expect(meterLevel(mixPeak(project, project.edl, 2.6, new Set(['A1', 'A2'])))).toBe(0);
  });
  it('lists every edit point', () => {
    expect(editPoints(project.edl)).toEqual([0, 0.4, 4, 4.6, 6.6, 8.4, 9, 10, 12]);
  });
});

describe('editor reducer', () => {
  const reducer = makeReducer({});
  const start = initEditorState(project.edl, project.marks, 'v1');
  it('commits, undoes and redoes with a slow tween', () => {
    const a = reducer(start, { type: 'commit', ops: MOCK_CUT_TO_10.ops, animate: true });
    expect(clipEnd(findClip(a.edl, 'v3')!.clip)).toBe(10);
    expect(a.change).toMatchObject({ version: 1, animate: true });
    expect(a.change.previous).toBe(start.edl);
    const b = reducer(a, { type: 'undo' });
    expect(b.edl).toBe(start.edl);
    expect(reducer(b, { type: 'redo' }).edl).toBe(a.edl);
  });
  it('ignores invalid ops', () => {
    expect(reducer(start, { type: 'commit', ops: [{ op: 'move', clipId: 'v3', start: 8 }], animate: false })).toBe(start);
  });
  it('coalesces a fader drag into one undo step', () => {
    let s = reducer(start, { type: 'commit', ops: [{ op: 'setGain', clipId: 'a1', gainDb: -1 }], animate: false, coalesce: 'g' });
    s = reducer(s, { type: 'commit', ops: [{ op: 'setGain', clipId: 'a1', gainDb: -2 }], animate: false, coalesce: 'g' });
    s = reducer(s, { type: 'commit', ops: [{ op: 'setGain', clipId: 'a1', gainDb: -3 }], animate: false, coalesce: 'g' });
    expect(s.past).toHaveLength(1);
    expect(reducer(s, { type: 'undo' }).edl).toBe(start.edl);
  });
});
