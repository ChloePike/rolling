import { afterEach, describe, expect, it } from 'vitest';
import type { AssetPick } from './types';
import { mergeUploaded, noteUploadedAsset, pruneUploaded, resetUploaded, UPLOAD_LISTING_GRACE_MS, uploadedAssets } from './uploaded';

const pick = (assetId: string, o: Partial<AssetPick> = {}): AssetPick => ({ id: assetId, assetId, kind: 'image', name: assetId, source: 'mine', thumbUrl: null, ...o });

afterEach(resetUploaded);

describe('AssetPicker: uploads the server does not list yet', () => {
  it('a finished upload shows in My assets before the server lists it, first, once', () => {
    noteUploadedAsset(pick('ast_new', { name: 'beach' }));
    // The picker opens within the ~5 s before the asset list has it: the list is empty.
    expect(mergeUploaded([], uploadedAssets(), 'all', '').map((p) => p.assetId)).toEqual(['ast_new']);
    expect(mergeUploaded([pick('ast_old')], uploadedAssets(), 'image', '').map((p) => p.assetId)).toEqual(['ast_new', 'ast_old']);
    // Listed by the server now: not doubled.
    expect(mergeUploaded([pick('ast_new'), pick('ast_old')], uploadedAssets(), 'all', '').map((p) => p.assetId)).toEqual(['ast_new', 'ast_old']);
  });

  it('follows the kind chip and the search', () => {
    noteUploadedAsset(pick('ast_clip', { kind: 'video', name: 'Clip' }));
    expect(mergeUploaded([], uploadedAssets(), 'image', '')).toEqual([]);
    expect(mergeUploaded([], uploadedAssets(), 'video', 'cl')).toHaveLength(1);
    expect(mergeUploaded([], uploadedAssets(), 'video', 'beach')).toEqual([]);
  });

  it('is forgotten once the server lists it, or after the grace period', () => {
    const t0 = 1_000_000;
    noteUploadedAsset(pick('ast_a'), t0);
    noteUploadedAsset(pick('ast_b'), t0);
    pruneUploaded(['ast_a'], t0 + 1000);
    expect(uploadedAssets(t0 + 1000).map((p) => p.assetId)).toEqual(['ast_b']);
    expect(uploadedAssets(t0 + UPLOAD_LISTING_GRACE_MS + 1)).toEqual([]);
  });
});
