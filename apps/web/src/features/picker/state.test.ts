import { describe, expect, it } from 'vitest';
import {
  acceptedFiles,
  acceptFor,
  allowedKinds,
  columnsFor,
  gridMove,
  initialState,
  isSelected,
  mineCells,
  nearEnd,
  pickerReducer,
  publicAllowed,
  pushRecent,
  toggle,
  visibleRows,
} from './state';
import type { AssetPick, PickerUpload } from './types';

const pick = (id: string, o: Partial<AssetPick> = {}): AssetPick => ({ id, assetId: id.startsWith('ast_') ? id : `ast_${id}`, kind: 'image', name: id, source: 'mine', thumbUrl: null, ...o });
const up = (id: string, o: Partial<PickerUpload> = {}): PickerUpload => ({ id, name: `${id}.png`, kind: 'image', previewUrl: null, status: 'uploading', ...o });

describe('picker: initial state from the caller', () => {
  it('opens on the public library when the caller names categories, else on My assets', () => {
    expect(initialState({ categories: ['portrait'] })).toMatchObject({ tab: 'public', category: 'portrait', kind: 'all', multiple: false });
    expect(initialState({})).toMatchObject({ tab: 'mine', category: 'all' });
    expect(initialState({ tab: 'recent', categories: ['pose'] }).tab).toBe('recent');
  });
  it('a caller that takes one kind gets that filter; audio-only callers never see the public library', () => {
    expect(initialState({ kinds: ['audio'] }).kind).toBe('audio');
    expect(publicAllowed({ kinds: ['audio'] })).toBe(false);
    expect(initialState({ kinds: ['audio'], tab: 'public', categories: ['pose'] }).tab).toBe('mine');
    expect(publicAllowed({ kinds: ['character'] })).toBe(true);
    expect(allowedKinds({})).toEqual(['image', 'video', 'audio', 'character']);
  });
});

describe('picker: selection', () => {
  it('single select replaces the selection and a second click clears it', () => {
    expect(toggle([pick('a')], pick('b'), false).map((p) => p.id)).toEqual(['b']);
    expect(toggle([pick('a')], pick('a'), false)).toEqual([]);
  });
  it('multi select keeps picking order and toggles off', () => {
    let sel = toggle([], pick('a'), true);
    sel = toggle(sel, pick('b'), true);
    expect(sel.map((p) => p.id)).toEqual(['a', 'b']);
    expect(toggle(sel, pick('a'), true).map((p) => p.id)).toEqual(['b']);
  });
  it('the same asset reached from two places counts as selected once', () => {
    expect(isSelected([pick('pw_1', { assetId: 'ast_9' })], { id: 'ast_9', assetId: 'ast_9' })).toBe(true);
  });
  it('a finished upload is selected (single: replaces, multi: joins) and its tile becomes the asset', () => {
    let s = initialState({ tab: 'public', categories: ['pose'] });
    s = pickerReducer(s, { type: 'toggle', pick: pick('x') });
    s = pickerReducer(s, { type: 'uploadStarted', uploads: [up('upl_1')] });
    expect(s.tab).toBe('mine');
    s = pickerReducer(s, { type: 'uploadDone', id: 'upl_1', pick: pick('ast_new') });
    expect(s.selected.map((p) => p.assetId)).toEqual(['ast_new']);
    expect(s.uploads[0]).toMatchObject({ status: 'done', pick: { assetId: 'ast_new' } });

    let m = initialState({ multiple: true });
    m = pickerReducer(m, { type: 'toggle', pick: pick('x') });
    m = pickerReducer(m, { type: 'uploadStarted', uploads: [up('upl_2')] });
    m = pickerReducer(m, { type: 'uploadDone', id: 'upl_2', pick: pick('ast_two') });
    expect(m.selected.map((p) => p.assetId)).toEqual(['ast_x', 'ast_two']);
  });
  it('a failed upload is marked failed and selects nothing; unknown ids are ignored', () => {
    let s = pickerReducer(initialState({}), { type: 'uploadStarted', uploads: [up('upl_1')] });
    s = pickerReducer(s, { type: 'uploadFailed', id: 'upl_1' });
    expect(s.uploads[0]!.status).toBe('failed');
    expect(s.selected).toEqual([]);
    expect(pickerReducer(s, { type: 'uploadDone', id: 'nope', pick: pick('a') })).toBe(s);
  });
  it('changing tab, filter or search puts the cursor back at the start', () => {
    let s = pickerReducer(initialState({}), { type: 'active', index: 7 });
    expect(pickerReducer(s, { type: 'kind', kind: 'video' }).active).toBe(0);
    s = pickerReducer(s, { type: 'active', index: 3 });
    expect(pickerReducer(s, { type: 'query', query: 'cat' }).active).toBe(0);
    expect(pickerReducer(s, { type: 'tab', tab: 'recent' }).active).toBe(0);
  });
});

describe('picker: My assets cells', () => {
  it('uploads in flight first, then finished uploads, then fetched items without duplicates', () => {
    const cells = mineCells([up('upl_a'), up('upl_b', { status: 'done', pick: pick('ast_b') })], [pick('ast_b'), pick('ast_c')], 'all');
    expect(cells.map((c) => (c.type === 'upload' ? c.upload.id : c.pick.assetId))).toEqual(['upl_a', 'ast_b', 'ast_c']);
  });
  it('the kind filter and the search apply to uploads too', () => {
    const cells = mineCells([up('upl_v', { kind: 'video', name: 'clip.mp4' })], [pick('ast_i'), pick('ast_v', { kind: 'video' })], 'video', 'clip');
    expect(cells.map((c) => (c.type === 'upload' ? c.upload.id : c.pick.assetId))).toEqual(['upl_v', 'ast_v']);
  });
});

describe('picker: keyboard and virtual grid', () => {
  it('arrows move by one or by a row and stop at the edges', () => {
    expect(gridMove(0, 'ArrowRight', 4, 10)).toBe(1);
    expect(gridMove(0, 'ArrowLeft', 4, 10)).toBe(0);
    expect(gridMove(1, 'ArrowDown', 4, 10)).toBe(5);
    expect(gridMove(8, 'ArrowDown', 4, 10)).toBe(8);
    expect(gridMove(5, 'ArrowUp', 4, 10)).toBe(1);
    expect(gridMove(2, 'ArrowUp', 4, 10)).toBe(2);
    expect(gridMove(4, 'End', 4, 10)).toBe(9);
    expect(gridMove(4, 'Home', 4, 10)).toBe(0);
    expect(gridMove(12, 'ArrowRight', 4, 10)).toBe(9);
    expect(gridMove(3, 'ArrowDown', 4, 0)).toBe(0);
  });
  it('columns fit the width; the window renders only rows near the viewport', () => {
    expect(columnsFor(920, 132, 10)).toBe(6);
    expect(columnsFor(300, 132, 10)).toBe(2);
    expect(columnsFor(0, 132, 10)).toBe(4);
    expect(visibleRows({ scrollTop: 0, height: 500, rowHeight: 180, rows: 100 })).toEqual({ start: 0, end: 5 });
    expect(visibleRows({ scrollTop: 1800, height: 500, rowHeight: 180, rows: 100 })).toEqual({ start: 8, end: 15 });
    expect(visibleRows({ scrollTop: 0, height: 500, rowHeight: 180, rows: 2 })).toEqual({ start: 0, end: 2 });
    expect(nearEnd(15, 100)).toBe(false);
    expect(nearEnd(98, 100)).toBe(true);
  });
});

describe('picker: uploads and recent', () => {
  it('accept and file checks follow the kinds the caller takes', () => {
    expect(acceptFor(['image', 'character'])).toBe('image/*');
    expect(acceptFor(['video', 'audio'])).toBe('video/*,audio/*');
    const { ok, refused } = acceptedFiles([{ type: 'image/png' }, { type: 'audio/mpeg' }, { type: 'text/plain' }], ['image']);
    expect(ok).toEqual([{ type: 'image/png' }]);
    expect(refused).toHaveLength(2);
  });
  it('recent keeps the newest first, without duplicates, at most 24', () => {
    const r = pushRecent([pick('a'), pick('b')], [pick('b'), pick('c')]);
    expect(r.map((p) => p.id)).toEqual(['c', 'b', 'a']);
    const many = pushRecent([], Array.from({ length: 30 }, (_, i) => pick(`p${i}`)));
    expect(many).toHaveLength(24);
    expect(many[0]!.id).toBe('p29');
  });
});
